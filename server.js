const express    = require('express');
const multer     = require('multer');
const axios      = require('axios');
const nodemailer = require('nodemailer');
const fs         = require('fs-extra');
const path       = require('path');
const cors       = require('cors');
const { v4: uuidv4 } = require('uuid');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── MIDDLEWARE ──────────────────────────────────────────────────
app.use(cors({
  origin: (_origin, cb) => cb(null, true), // allow all origins (Hostinger + local)
  credentials: true
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname)));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// ── DATA DIRECTORIES ───────────────────────────────────────────
fs.ensureDirSync('./data');
fs.ensureDirSync('./uploads/products');
fs.ensureDirSync('./uploads/banners');

// ── DATA HELPERS ───────────────────────────────────────────────
const dataPath = (file) => path.join(__dirname, 'data', file);

function load(file) {
  const fp = dataPath(file);
  if (!fs.existsSync(fp)) return [];
  return fs.readJsonSync(fp);
}

function save(file, data) {
  fs.writeJsonSync(dataPath(file), data, { spaces: 2 });
}

function loadSettings() {
  const fp = dataPath('settings.json');
  if (!fs.existsSync(fp)) return {};
  return fs.readJsonSync(fp);
}

function saveSettings(data) {
  fs.writeJsonSync(dataPath('settings.json'), data, { spaces: 2 });
}

// ── FILE UPLOAD (multer) ───────────────────────────────────────
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = req.baseUrl?.includes('banner') || req.path?.includes('banner')
      ? './uploads/banners'
      : './uploads/products';
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    cb(null, uuidv4() + path.extname(file.originalname));
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Only images allowed'));
  }
});

// ──────────────────────────────────────────────────────────────
// PRODUCTS
// ──────────────────────────────────────────────────────────────
app.get('/api/products', (req, res) => {
  res.json(load('products.json'));
});

app.post('/api/products', upload.single('image'), (req, res) => {
  const products = load('products.json');
  const product = {
    id:            uuidv4(),
    name:          req.body.name,
    category:      req.body.category,
    price:         parseFloat(req.body.price) || 0,
    originalPrice: req.body.originalPrice ? parseFloat(req.body.originalPrice) : null,
    description:   req.body.description || '',
    stock:         parseInt(req.body.stock) || 0,
    badge:         req.body.badge || '',
    icon:          req.body.icon || '🎀',
    image:         req.file ? `/uploads/products/${req.file.filename}` : null,
    active:        true,
    createdAt:     new Date().toISOString()
  };
  products.push(product);
  save('products.json', products);
  res.json(product);
});

app.put('/api/products/:id', upload.single('image'), (req, res) => {
  const products = load('products.json');
  const idx = products.findIndex(p => p.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  products[idx] = {
    ...products[idx],
    name:          req.body.name          || products[idx].name,
    category:      req.body.category      || products[idx].category,
    price:         req.body.price         ? parseFloat(req.body.price) : products[idx].price,
    originalPrice: req.body.originalPrice ? parseFloat(req.body.originalPrice) : products[idx].originalPrice,
    description:   req.body.description   ?? products[idx].description,
    stock:         req.body.stock         ? parseInt(req.body.stock) : products[idx].stock,
    badge:         req.body.badge         ?? products[idx].badge,
    icon:          req.body.icon          || products[idx].icon,
    active:        req.body.active !== undefined ? req.body.active === 'true' : products[idx].active,
    image:         req.file ? `/uploads/products/${req.file.filename}` : products[idx].image,
    updatedAt:     new Date().toISOString()
  };
  save('products.json', products);
  res.json(products[idx]);
});

app.delete('/api/products/:id', (req, res) => {
  let products = load('products.json');
  products = products.filter(p => p.id !== req.params.id);
  save('products.json', products);
  res.json({ success: true });
});

// ──────────────────────────────────────────────────────────────
// ORDERS
// ──────────────────────────────────────────────────────────────
app.get('/api/orders', (req, res) => {
  const orders = load('orders.json');
  // Sort newest first
  res.json(orders.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)));
});

app.get('/api/orders/:id', (req, res) => {
  const orders = load('orders.json');
  const order = orders.find(o => o.id === req.params.id);
  if (!order) return res.status(404).json({ error: 'Not found' });
  res.json(order);
});

app.post('/api/orders', async (req, res) => {
  const orders = load('orders.json');
  const order = {
    id:          uuidv4(),
    orderNumber: 'SH' + Date.now().toString().slice(-6),
    status:      'pending',
    ...req.body,
    createdAt:   new Date().toISOString()
  };
  orders.push(order);
  save('orders.json', orders);

  // Decrement stock
  if (order.items?.length) {
    const products = load('products.json');
    order.items.forEach(item => {
      const p = products.find(p => p.id === item.id);
      if (p) p.stock = Math.max(0, (p.stock || 0) - (item.qty || 1));
    });
    save('products.json', products);
  }

  // Async notifications (don't block response)
  const settings = loadSettings();
  sendOrderNotifications(order, settings).catch(e => console.error('Notifications failed:', e.message));

  res.json(order);
});

app.put('/api/orders/:id/status', async (req, res) => {
  const orders = load('orders.json');
  const idx = orders.findIndex(o => o.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  const prev = orders[idx].status;
  orders[idx].status    = req.body.status;
  orders[idx].updatedAt = new Date().toISOString();
  if (req.body.trackingNumber) orders[idx].trackingNumber = req.body.trackingNumber;
  save('orders.json', orders);

  // Notify customer on shipping
  if (req.body.status === 'shipped' && prev !== 'shipped') {
    const settings = loadSettings();
    const order    = orders[idx];
    const msg      = `שלום ${order.customerName}! הזמנתך ${order.orderNumber} נשלחה 🚚 מספר מעקב: ${order.trackingNumber || ''}`;
    if (order.customerPhone) sendSMS(order.customerPhone, msg, settings).catch(console.error);
    if (order.customerPhone) sendWhatsApp(order.customerPhone, msg, settings).catch(console.error);
  }

  res.json(orders[idx]);
});

// ──────────────────────────────────────────────────────────────
// STATS
// ──────────────────────────────────────────────────────────────
app.get('/api/stats', (req, res) => {
  const orders   = load('orders.json');
  const products = load('products.json');
  const today    = new Date().toDateString();

  const paid        = orders.filter(o => o.status === 'paid' || o.status === 'shipped' || o.status === 'delivered');
  const todayOrders = orders.filter(o => new Date(o.createdAt).toDateString() === today);

  res.json({
    totalOrders:    orders.length,
    todayOrders:    todayOrders.length,
    totalRevenue:   paid.reduce((s, o) => s + (parseFloat(o.total) || 0), 0),
    todayRevenue:   todayOrders.filter(o => paid.includes(o)).reduce((s, o) => s + (parseFloat(o.total) || 0), 0),
    totalProducts:  products.length,
    lowStock:       products.filter(p => (p.stock || 0) < 5).length,
    pendingOrders:  orders.filter(o => o.status === 'pending').length
  });
});

// ──────────────────────────────────────────────────────────────
// PAYMENT GATEWAYS
// ──────────────────────────────────────────────────────────────

// Cardcom — redirect-based payment
app.post('/api/payment/cardcom', async (req, res) => {
  const { cardcom } = loadSettings().payment || {};
  if (!cardcom?.terminalNumber) return res.status(400).json({ error: 'Cardcom לא מוגדר' });

  const { amount, description, orderId } = req.body;
  const base = `${req.protocol}://${req.get('host')}`;

  const params = new URLSearchParams({
    TerminalNumber:     cardcom.terminalNumber,
    UserName:           cardcom.username || 'biz',
    APILevel:           '10',
    codepage:           '65001',
    Operation:          '1',
    Currency:           '1',
    Sum:                amount,
    ProductName:        description,
    ReturnValue:        orderId,
    SuccessRedirectUrl: `${base}/checkout-success.html`,
    ErrorRedirectUrl:   `${base}/checkout-error.html`,
    WebHookUrl:         `${base}/api/payment/webhook/cardcom`
  });

  try {
    const r = await axios.get(`https://secure.cardcom.solutions/interface/ChargeNoToken.aspx?${params}`);
    const match = r.data.match(/url=(.+)/i);
    if (match) return res.json({ redirectUrl: decodeURIComponent(match[1].trim()) });
    res.status(400).json({ error: 'Cardcom failed', raw: r.data });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PayPlus — API-based payment page
app.post('/api/payment/payplus', async (req, res) => {
  const { payplus } = loadSettings().payment || {};
  if (!payplus?.apiKey) return res.status(400).json({ error: 'PayPlus לא מוגדר' });

  const { amount, orderId, customerName, customerEmail, customerPhone } = req.body;
  const base = `${req.protocol}://${req.get('host')}`;

  try {
    const r = await axios.post(
      'https://restapi.payplus.co.il/api/v1.0/PaymentPages/generateLink',
      {
        payment_page_uid:    payplus.pageUid,
        charge_default:      true,
        amount:              parseFloat(amount),
        currency_code:       'ILS',
        sendEmailApproval:   !!customerEmail,
        email:               customerEmail,
        full_name:           customerName,
        phone:               customerPhone,
        more_info:           orderId,
        success_redirect_url: `${base}/checkout-success.html`,
        fail_redirect_url:   `${base}/checkout-error.html`
      },
      { headers: { Authorization: payplus.apiKey, 'Content-Type': 'application/json' } }
    );
    res.json({ redirectUrl: r.data.data.payment_page_link });
  } catch (e) {
    res.status(500).json({ error: e.response?.data?.message || e.message });
  }
});

// Tranzila — iframe redirect
app.post('/api/payment/tranzila', (req, res) => {
  const { tranzila } = loadSettings().payment || {};
  if (!tranzila?.supplier) return res.status(400).json({ error: 'Tranzila לא מוגדר' });

  const { amount, orderId } = req.body;
  const base = `${req.protocol}://${req.get('host')}`;

  const params = new URLSearchParams({
    supplier:     tranzila.supplier,
    sum:          amount,
    currency:     '1',
    tranmode:     'AK',
    noorder:      orderId,
    success_url:  `${base}/checkout-success.html`,
    fail_url:     `${base}/checkout-error.html`
  });

  res.json({ redirectUrl: `https://direct.tranzila.com/${tranzila.supplier}/iframenew.php?${params}` });
});

// Payment callback webhook
app.post('/api/payment/webhook/:gateway', (req, res) => {
  const orders  = load('orders.json');
  const orderId = req.body.ReturnValue || req.body.more_info || req.body.orderId;
  const idx     = orders.findIndex(o => o.id === orderId);

  if (idx !== -1) {
    orders[idx].status    = 'paid';
    orders[idx].paidAt    = new Date().toISOString();
    orders[idx].gateway   = req.params.gateway;
    orders[idx].gatewayRef = req.body.InternalDealNumber || req.body.transaction_uid || '';
    save('orders.json', orders);
    console.log(`✅ Payment confirmed for order ${orders[idx].orderNumber}`);
  }

  res.json({ success: true });
});

// ──────────────────────────────────────────────────────────────
// SHIPPING — DHL Israel
// ──────────────────────────────────────────────────────────────
app.post('/api/shipping/quote', async (req, res) => {
  const settings = loadSettings();
  const { dhl }  = settings.shipping || {};
  const freeFrom = parseFloat(settings.shipping?.freeFrom) || 200;
  const total    = parseFloat(req.body.total) || 0;

  const freeRate = { service: 'FREE', name: `משלוח חינם (מעל ₪${freeFrom})`, price: 0, days: '3-5 ימי עסקים' };

  if (!dhl?.apiKey) {
    const rates = [
      { service: 'EXPRESS', name: 'משלוח מהיר (1-2 ימי עסקים)', price: 45, days: '1-2 ימים' },
      { service: 'STANDARD', name: 'משלוח רגיל (3-5 ימי עסקים)', price: 25, days: '3-5 ימים' }
    ];
    if (total >= freeFrom) rates.push(freeRate);
    return res.json({ rates });
  }

  const { weight = 0.5, zip = '' } = req.body;

  try {
    const r = await axios.get('https://api.dhl.com/rates/v1/products', {
      headers: { 'DHL-API-Key': dhl.apiKey },
      params:  {
        accountNumber:                    dhl.accountNumber,
        originCountryCode:                'IL',
        originPostalCode:                 dhl.originZip || '6100000',
        destinationCountryCode:           'IL',
        destinationPostalCode:            zip,
        weight,
        length: 20, width: 20, height: 10,
        plannedShippingDateAndTime:       new Date(Date.now() + 86400000).toISOString().slice(0, 19)
      }
    });

    const rates = (r.data.products || []).map(p => ({
      service:      p.productCode,
      name:         p.productName,
      price:        p.totalPrice?.[0]?.price || 0,
      days:         p.deliveryCapabilities?.estimatedDeliveryDateAndTime?.slice(0, 10) || ''
    }));

    if (total >= freeFrom) rates.push(freeRate);
    res.json({ rates });
  } catch (e) {
    res.status(500).json({ error: e.response?.data?.detail || e.message });
  }
});

app.post('/api/shipping/create', async (req, res) => {
  const settings = loadSettings();
  const { dhl }  = settings.shipping || {};
  if (!dhl?.apiKey) return res.status(400).json({ error: 'DHL לא מוגדר' });

  const { order, service } = req.body;

  try {
    const payload = {
      plannedShippingDateAndTime: new Date(Date.now() + 86400000).toISOString().slice(0, 19),
      pickup: { isRequested: false },
      productCode: service,
      accounts: [{ typeCode: 'shipper', number: dhl.accountNumber }],
      shipper: {
        name: settings.store?.name || 'שושנה בוטיק',
        phone: settings.store?.phone || '050-0000000',
        email: settings.store?.email || '',
        address: {
          addressLine1: settings.store?.address || 'רחוב 1',
          cityName:     settings.store?.city    || 'תל אביב',
          countryCode:  'IL',
          postalCode:   dhl.originZip || '6100000'
        }
      },
      recipient: {
        name: order.customerName,
        phone: order.customerPhone,
        email: order.customerEmail,
        address: {
          addressLine1: order.address,
          cityName:     order.city,
          countryCode:  'IL',
          postalCode:   order.zip
        }
      },
      packages: [{
        weight:     { value: 0.5, unitOfMeasurement: 'kg' },
        dimensions: { length: 20, width: 15, height: 5, unitOfMeasurement: 'cm' }
      }],
      content: {
        packages: [{ typeCode: 'EE' }],
        isCustomsDeclarable: false,
        description: 'Hair accessories / אביזרי שיער'
      }
    };

    const r = await axios.post('https://api.dhl.com/shipments', payload, {
      headers: { 'DHL-API-Key': dhl.apiKey, 'Content-Type': 'application/json' }
    });

    const trackingNumber = r.data.shipmentTrackingNumber;
    const label          = r.data.documents?.[0]?.content;

    // Save tracking number to order
    const orders = load('orders.json');
    const idx    = orders.findIndex(o => o.id === order.id);
    if (idx !== -1) {
      orders[idx].trackingNumber = trackingNumber;
      orders[idx].status         = 'shipped';
      save('orders.json', orders);
    }

    res.json({ trackingNumber, label });
  } catch (e) {
    res.status(500).json({ error: e.response?.data?.detail || e.message });
  }
});

app.get('/api/shipping/track/:waybill', async (req, res) => {
  const { dhl } = loadSettings().shipping || {};
  try {
    const r = await axios.get(
      `https://api.dhl.com/track/shipments?trackingNumber=${req.params.waybill}`,
      { headers: { 'DHL-API-Key': dhl?.apiKey || 'demo' } }
    );
    res.json(r.data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ──────────────────────────────────────────────────────────────
// NOTIFICATIONS
// ──────────────────────────────────────────────────────────────

async function sendSMS(phone, message, settings) {
  const { inforu } = (settings.notifications || {});
  if (!inforu?.username) return;

  const clean = phone.replace(/[^\d+]/g, '');
  const xml   = `<?xml version="1.0" encoding="utf-8"?>
<InforuXML>
  <User>
    <Username>${inforu.username}</Username>
    <Password>${inforu.password}</Password>
  </User>
  <Content>
    <Message>${message}</Message>
    <From>${inforu.sender || 'Shoshana'}</From>
  </Content>
  <Recipients>
    <PhoneNumber>${clean}</PhoneNumber>
  </Recipients>
</InforuXML>`;

  await axios.post(
    'https://api.inforu.co.il/SendMessageXml.ashx',
    `InforuXML=${encodeURIComponent(xml)}`,
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
  );
}

async function sendWhatsApp(phone, message, settings) {
  const { whatsapp } = (settings.notifications || {});
  if (!whatsapp?.token || !whatsapp?.phoneNumberId) return;

  const clean = phone.replace(/[^\d]/g, '');
  await axios.post(
    `https://graph.facebook.com/v18.0/${whatsapp.phoneNumberId}/messages`,
    { messaging_product: 'whatsapp', to: clean, type: 'text', text: { body: message } },
    { headers: { Authorization: `Bearer ${whatsapp.token}`, 'Content-Type': 'application/json' } }
  );
}

async function sendEmail(to, subject, html, settings) {
  const { email } = (settings.notifications || {});
  if (!email?.host) return;

  const transporter = nodemailer.createTransport({
    host:   email.host,
    port:   parseInt(email.port) || 587,
    secure: parseInt(email.port) === 465,
    auth:   { user: email.user, pass: email.pass }
  });

  await transporter.sendMail({
    from:    `"${settings.store?.name || 'שושנה'}" <${email.user}>`,
    to,
    subject,
    html
  });
}

async function sendOrderNotifications(order, settings) {
  const notif = settings.notifications || {};
  const ownerPhone = settings.store?.phone;

  // SMS to store owner
  if (ownerPhone && notif.smsToOwner) {
    const msg = `📦 הזמנה חדשה! ${order.orderNumber}\n${order.customerName} | ₪${order.total}`;
    await sendSMS(ownerPhone, msg, settings);
  }

  // SMS to customer
  if (order.customerPhone && notif.smsToCustomer) {
    const msg = `שלום ${order.customerName}! הזמנתך ${order.orderNumber} התקבלה ✅\nנודיע לך כשנשלח 🌸`;
    await sendSMS(order.customerPhone, msg, settings);
  }

  // WhatsApp to customer
  if (order.customerPhone && notif.whatsappToCustomer) {
    const msg = `שלום ${order.customerName}! 🌸\nהזמנתך *${order.orderNumber}* התקבלה בהצלחה!\nסה"כ: ₪${order.total}\nנודיע לך כשהחבילה תישלח.`;
    await sendWhatsApp(order.customerPhone, msg, settings);
  }

  // Email to customer
  if (order.customerEmail && notif.emailToCustomer) {
    const itemsHTML = (order.items || []).map(i =>
      `<tr><td style="padding:8px 4px;border-bottom:1px solid #f0e8dc">${i.icon || ''} ${i.name}</td><td style="padding:8px 4px;border-bottom:1px solid #f0e8dc;text-align:left">₪${i.price}</td></tr>`
    ).join('');

    const html = `
<div dir="rtl" style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;background:#fff;border:1px solid #f0e8dc;padding:32px">
  <h1 style="color:#2C1A1D;font-size:1.8rem;margin:0 0 8px">תודה על הזמנתך! 🌸</h1>
  <p style="color:#7A5C62;margin:0 0 24px">שלום ${order.customerName},</p>
  <p>הזמנתך מספר <strong style="color:#B8860B">${order.orderNumber}</strong> התקבלה בהצלחה.</p>
  <table style="width:100%;border-collapse:collapse;margin:16px 0">${itemsHTML}
    <tr><td style="padding:12px 4px;font-weight:bold">סה"כ</td><td style="padding:12px 4px;font-weight:bold;text-align:left;color:#B8860B">₪${order.total}</td></tr>
  </table>
  <p style="color:#7A5C62;font-size:0.9rem">נודיע לך ברגע שהחבילה תצא לדרך 🚚</p>
  <p style="margin-top:24px;color:#C4617A;font-weight:bold">בברכה, צוות שושנה 💕</p>
</div>`;

    await sendEmail(order.customerEmail, `הזמנה ${order.orderNumber} התקבלה! 🌸`, html, settings);
  }
}

// Direct notification test endpoints
app.post('/api/notify/sms', async (req, res) => {
  try {
    await sendSMS(req.body.phone, req.body.message, loadSettings());
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/notify/whatsapp', async (req, res) => {
  try {
    await sendWhatsApp(req.body.phone, req.body.message, loadSettings());
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/notify/email', async (req, res) => {
  try {
    await sendEmail(req.body.to, req.body.subject, `<p>${req.body.message}</p>`, loadSettings());
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ──────────────────────────────────────────────────────────────
// BANNERS
// ──────────────────────────────────────────────────────────────
app.get('/api/banners', (req, res) => res.json(load('banners.json')));

app.post('/api/banners', upload.single('image'), (req, res) => {
  const banners = load('banners.json');
  const banner  = {
    id:        uuidv4(),
    title:     req.body.title || '',
    subtitle:  req.body.subtitle || '',
    link:      req.body.link || '#products',
    color:     req.body.color || '#C4617A',
    image:     req.file ? `/uploads/banners/${req.file.filename}` : null,
    active:    true,
    createdAt: new Date().toISOString()
  };
  banners.push(banner);
  save('banners.json', banners);
  res.json(banner);
});

app.put('/api/banners/:id', (req, res) => {
  const banners = load('banners.json');
  const idx = banners.findIndex(b => b.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  banners[idx] = { ...banners[idx], ...req.body };
  save('banners.json', banners);
  res.json(banners[idx]);
});

app.delete('/api/banners/:id', (req, res) => {
  save('banners.json', load('banners.json').filter(b => b.id !== req.params.id));
  res.json({ success: true });
});

// ──────────────────────────────────────────────────────────────
// SETTINGS
// ──────────────────────────────────────────────────────────────
app.get('/api/settings', (req, res) => res.json(loadSettings()));

app.put('/api/settings', (req, res) => {
  const current = loadSettings();
  // Deep merge
  const updated = deepMerge(current, req.body);
  saveSettings(updated);
  res.json(updated);
});

function deepMerge(target, source) {
  const out = { ...target };
  for (const key of Object.keys(source)) {
    if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
      out[key] = deepMerge(target[key] || {}, source[key]);
    } else {
      out[key] = source[key];
    }
  }
  return out;
}

// ──────────────────────────────────────────────────────────────
// UPLOAD (generic)
// ──────────────────────────────────────────────────────────────
app.post('/api/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  res.json({ url: `/uploads/products/${req.file.filename}` });
});

// ──────────────────────────────────────────────────────────────
// START
// ──────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🌸 שושנה בוטיק — שרת פועל על http://localhost:${PORT}`);
  console.log(`   🏪 חנות:    http://localhost:${PORT}/hair-boutique.html`);
  console.log(`   ⚙️  ניהול:   http://localhost:${PORT}/admin.html`);
  console.log(`   🛒 קופה:    http://localhost:${PORT}/checkout.html\n`);
});
