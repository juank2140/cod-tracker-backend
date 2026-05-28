require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const axios = require('axios');
const admin = require('firebase-admin');

const app = express();
const PORT = process.env.PORT || 3000;

// ── FIREBASE INIT ────────────────────────────────────────
// Usamos la URL de la base de datos directamente sin service account
// (funciona con las reglas públicas que ya configuraste)
let db;
try {
  if (!admin.apps.length) {
    admin.initializeApp({
      databaseURL: process.env.FIREBASE_DATABASE_URL,
      credential: admin.credential.applicationDefault(),
    });
  }
  db = admin.database();
  console.log('✅ Firebase conectado');
} catch (e) {
  // Si no hay credenciales de service account, usamos REST API directamente
  console.log('⚠️  Firebase Admin sin credenciales — usando REST API');
  db = null;
}

// ── HELPERS ──────────────────────────────────────────────
const genId = () => 'P' + Date.now().toString(36).toUpperCase().slice(-5);

const fmtCOP = (n) => '$' + Number(n || 0).toLocaleString('es-CO');

// Escribir en Firebase via REST (no necesita service account)
async function writeToFirebase(path, data) {
  const url = `${process.env.FIREBASE_DATABASE_URL}/${path}.json`;
  const res = await axios.post(url, data);
  return res.data;
}

async function updateFirebase(path, data) {
  const url = `${process.env.FIREBASE_DATABASE_URL}/${path}.json`;
  const res = await axios.patch(url, data);
  return res.data;
}

async function getFromFirebase(path) {
  const url = `${process.env.FIREBASE_DATABASE_URL}/${path}.json`;
  const res = await axios.get(url);
  return res.data;
}

// ── MAPEAR PRODUCTO SHOPIFY → NOMBRE LEGIBLE ────────────
function mapearProducto(lineItems) {
  if (!lineItems || lineItems.length === 0) return 'Producto';
  const item = lineItems[0];
  const nombre = item.name || item.title || 'Producto';
  const qty = item.quantity || 1;
  return qty > 1 ? `${nombre} x${qty}` : nombre;
}

// ── MAPEAR ESTADO SHOPIFY → ESTADO COD TRACKER ──────────
function mapearEstado(shopifyOrder) {
  const financialStatus = shopifyOrder.financial_status;
  const fulfillmentStatus = shopifyOrder.fulfillment_status;
  if (fulfillmentStatus === 'fulfilled') return 'entregado';
  if (financialStatus === 'paid') return 'confirmado';
  return 'pendiente';
}

// ── ENVIAR WHATSAPP VIA ULTRAMSG ─────────────────────────
async function enviarWhatsApp(telefono, mensaje) {
  if (!process.env.ULTRAMSG_INSTANCE || !process.env.ULTRAMSG_TOKEN) {
    console.log('⚠️  WhatsApp no configurado — mensaje omitido:', mensaje);
    return null;
  }

  // Limpiar teléfono: solo números, agregar 57 si es colombiano
  let tel = telefono.replace(/\D/g, '');
  if (tel.startsWith('3') && tel.length === 10) tel = '57' + tel;
  if (!tel.startsWith('57')) tel = '57' + tel;

  try {
    const res = await axios.post(
      `https://api.ultramsg.com/${process.env.ULTRAMSG_INSTANCE}/messages/chat`,
      {
        token: process.env.ULTRAMSG_TOKEN,
        to: tel,
        body: mensaje,
      }
    );
    console.log(`✅ WhatsApp enviado a ${tel}`);
    return res.data;
  } catch (e) {
    console.error('❌ Error WhatsApp:', e.message);
    return null;
  }
}

// ── VERIFICAR HMAC DE SHOPIFY ────────────────────────────
function verificarWebhook(rawBody, hmacHeader) {
  if (!process.env.SHOPIFY_WEBHOOK_SECRET) return true; // Skip en desarrollo
  const hash = crypto
    .createHmac('sha256', process.env.SHOPIFY_WEBHOOK_SECRET)
    .update(rawBody, 'utf8')
    .digest('base64');
  return hash === hmacHeader;
}

// ── MIDDLEWARE ───────────────────────────────────────────
// Guardar raw body para verificación HMAC
app.use((req, res, next) => {
  let data = '';
  req.on('data', chunk => { data += chunk; });
  req.on('end', () => {
    req.rawBody = data;
    try { req.body = JSON.parse(data); } catch (e) { req.body = {}; }
    next();
  });
});

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  next();
});

// ── RUTA HEALTH CHECK ────────────────────────────────────
app.get('/', (req, res) => {
  res.json({
    status: 'online',
    service: 'COD Tracker Backend',
    version: '1.0.0',
    timestamp: new Date().toISOString(),
  });
});

// ── WEBHOOK: NUEVO PEDIDO DE SHOPIFY ────────────────────
app.post('/webhook/orders/create', async (req, res) => {
  // 1. Verificar que viene de Shopify
  const hmac = req.headers['x-shopify-hmac-sha256'];
  if (!verificarWebhook(req.rawBody, hmac)) {
    console.error('❌ Webhook no autorizado');
    return res.status(401).json({ error: 'No autorizado' });
  }

  res.status(200).json({ received: true }); // Responder rápido a Shopify

  const order = req.body;
  console.log(`\n📦 Nuevo pedido Shopify: #${order.order_number} — ${order.email}`);

  try {
    // 2. Extraer datos del pedido
    const telefono =
      order.shipping_address?.phone ||
      order.billing_address?.phone ||
      order.phone ||
      order.customer?.phone ||
      '';

    const nombre =
      order.shipping_address?.name ||
      `${order.customer?.first_name || ''} ${order.customer?.last_name || ''}`.trim() ||
      'Cliente';

    const direccion =
      order.shipping_address
        ? `${order.shipping_address.address1 || ''} ${order.shipping_address.address2 || ''}`.trim()
        : '';

    const ciudad =
      order.shipping_address?.city || '';

    const producto = mapearProducto(order.line_items);
    const valor = Math.round(parseFloat(order.total_price || 0));
    const estado = mapearEstado(order);
    const id = genId();

    // 3. Crear pedido en Firebase
    const pedidoCOD = {
      id,
      shopifyOrderId: String(order.id),
      shopifyOrderNumber: String(order.order_number),
      nombre,
      telefono: telefono.replace(/\D/g, '').slice(-10),
      ciudad,
      direccion,
      producto,
      valor,
      transportadora: '',
      guia: '',
      estado,
      intentos: '0',
      novedad: '',
      notas: `Shopify #${order.order_number}`,
      creadoEn: Date.now(),
      actualizadoEn: Date.now(),
      historial: [{ estado, fecha: Date.now(), nota: 'Pedido creado desde Shopify' }],
      fuente: 'shopify',
    };

    await writeToFirebase('pedidos', pedidoCOD);
    console.log(`✅ Pedido ${id} guardado en Firebase`);

    // 4. Enviar WhatsApp de confirmación si hay teléfono
    if (telefono) {
      const mensaje =
        `Hola ${nombre.split(' ')[0]} 👋\n\n` +
        `Recibimos tu pedido de *${producto}* por *${fmtCOP(valor)}*.\n\n` +
        `Para confirmar tu entrega responde *SÍ* ✅\n\n` +
        `_Salud Verde Colombia_`;

      await enviarWhatsApp(telefono, mensaje);
    } else {
      console.log('⚠️  Pedido sin teléfono — WhatsApp omitido');
    }

  } catch (err) {
    console.error('❌ Error procesando pedido:', err.message);
  }
});

// ── WEBHOOK: PEDIDO ACTUALIZADO ──────────────────────────
app.post('/webhook/orders/updated', async (req, res) => {
  const hmac = req.headers['x-shopify-hmac-sha256'];
  if (!verificarWebhook(req.rawBody, hmac)) {
    return res.status(401).json({ error: 'No autorizado' });
  }

  res.status(200).json({ received: true });

  const order = req.body;
  console.log(`\n🔄 Pedido actualizado: #${order.order_number}`);

  try {
    // Buscar el pedido en Firebase por shopifyOrderId
    const pedidos = await getFromFirebase('pedidos');
    if (!pedidos) return;

    const entry = Object.entries(pedidos).find(
      ([, p]) => p.shopifyOrderId === String(order.id)
    );

    if (!entry) {
      console.log(`⚠️  Pedido Shopify #${order.order_number} no encontrado en Firebase`);
      return;
    }

    const [firebaseKey, pedido] = entry;
    const nuevoEstado = mapearEstado(order);

    if (pedido.estado !== nuevoEstado) {
      const historial = pedido.historial || [];
      historial.push({ estado: nuevoEstado, fecha: Date.now(), nota: 'Actualizado desde Shopify' });

      await updateFirebase(`pedidos/${firebaseKey}`, {
        estado: nuevoEstado,
        actualizadoEn: Date.now(),
        historial,
      });

      console.log(`✅ Estado actualizado: ${pedido.estado} → ${nuevoEstado}`);
    }
  } catch (err) {
    console.error('❌ Error actualizando pedido:', err.message);
  }
});

// ── ENDPOINT: RESPUESTA DE WHATSAPP (confirmación cliente) ──
// Cuando el cliente responde SÍ, UltraMsg llama este endpoint
app.post('/whatsapp/incoming', async (req, res) => {
  res.status(200).json({ ok: true });

  const { from, body } = req.body || {};
  if (!from || !body) return;

  const respuesta = body.trim().toLowerCase();
  const tel = from.replace(/\D/g, '').slice(-10);

  console.log(`\n📱 WhatsApp recibido de ${tel}: "${respuesta}"`);

  const esConfirmacion = ['si', 'sí', 'yes', 'ok', 'dale', 'confirmo', '1'].includes(respuesta);
  if (!esConfirmacion) return;

  try {
    const pedidos = await getFromFirebase('pedidos');
    if (!pedidos) return;

    // Buscar pedido pendiente con ese teléfono
    const entry = Object.entries(pedidos).find(
      ([, p]) => p.telefono === tel && p.estado === 'pendiente'
    );

    if (!entry) {
      console.log(`⚠️  No hay pedido pendiente para ${tel}`);
      return;
    }

    const [firebaseKey, pedido] = entry;
    const historial = pedido.historial || [];
    historial.push({ estado: 'confirmado', fecha: Date.now(), nota: 'Confirmado por WhatsApp' });

    await updateFirebase(`pedidos/${firebaseKey}`, {
      estado: 'confirmado',
      actualizadoEn: Date.now(),
      historial,
    });

    console.log(`✅ Pedido ${pedido.id} confirmado por WhatsApp`);

    // Responder al cliente
    await enviarWhatsApp(tel,
      `✅ *¡Perfecto ${pedido.nombre.split(' ')[0]}!*\n\n` +
      `Tu pedido está confirmado. Pronto te enviamos el número de guía para que puedas rastrearlo.\n\n` +
      `_Salud Verde Colombia_`
    );

  } catch (err) {
    console.error('❌ Error procesando confirmación:', err.message);
  }
});

// ── ENDPOINT: NOTIFICAR GUÍA ASIGNADA ────────────────────
// El COD Tracker llama este endpoint cuando asignas una guía manualmente
app.post('/api/notify-guide', async (req, res) => {
  const { firebaseKey, guia, transportadora, telefono, nombre, producto } = req.body || {};

  if (!firebaseKey || !guia || !telefono) {
    return res.status(400).json({ error: 'Faltan datos: firebaseKey, guia, telefono' });
  }

  try {
    // Actualizar estado en Firebase
    const pedidos = await getFromFirebase('pedidos');
    const pedido = pedidos?.[firebaseKey];
    if (!pedido) return res.status(404).json({ error: 'Pedido no encontrado' });

    const historial = pedido.historial || [];
    historial.push({ estado: 'enviado', fecha: Date.now(), nota: `Guía ${guia} — ${transportadora}` });

    await updateFirebase(`pedidos/${firebaseKey}`, {
      estado: 'enviado',
      guia,
      transportadora,
      actualizadoEn: Date.now(),
      historial,
    });

    // Enviar WhatsApp con la guía
    const msg =
      `🚚 *¡Tu pedido va en camino!*\n\n` +
      `Hola ${(nombre || pedido.nombre || '').split(' ')[0]}, tu *${producto || pedido.producto}* ya fue despachado.\n\n` +
      `📦 *Guía:* ${guia}\n` +
      `🏢 *Transportadora:* ${transportadora}\n\n` +
      `Puedes rastrearlo en la página web de ${transportadora}.\n\n` +
      `_Salud Verde Colombia_`;

    await enviarWhatsApp(telefono || pedido.telefono, msg);

    console.log(`✅ Guía ${guia} notificada para pedido ${pedido.id}`);
    res.json({ ok: true, message: 'Guía notificada y WhatsApp enviado' });

  } catch (err) {
    console.error('❌ Error notificando guía:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── ENDPOINT: REINTENTO DE CONFIRMACIÓN ─────────────────
// Llama esto manualmente o con un cron para reintentar pedidos sin confirmar
app.post('/api/retry-confirmation', async (req, res) => {
  try {
    const pedidos = await getFromFirebase('pedidos');
    if (!pedidos) return res.json({ retried: 0 });

    const ahora = Date.now();
    const DOS_HORAS = 2 * 60 * 60 * 1000;
    let retried = 0;

    for (const [key, pedido] of Object.entries(pedidos)) {
      if (pedido.estado !== 'pendiente') continue;
      if (!pedido.telefono) continue;
      const tiempoSinRespuesta = ahora - (pedido.actualizadoEn || pedido.creadoEn);
      if (tiempoSinRespuesta < DOS_HORAS) continue;
      if (parseInt(pedido.intentos || 0) >= 3) continue;

      await enviarWhatsApp(pedido.telefono,
        `Hola ${pedido.nombre.split(' ')[0]} 👋\n\n` +
        `Te escribimos de nuevo sobre tu pedido de *${pedido.producto}*.\n\n` +
        `¿Confirmas tu entrega? Responde *SÍ* para que podamos enviártelo. ✅\n\n` +
        `_Salud Verde Colombia_`
      );

      await updateFirebase(`pedidos/${key}`, {
        intentos: String(parseInt(pedido.intentos || 0) + 1),
        actualizadoEn: Date.now(),
      });

      retried++;
      console.log(`🔄 Reintento enviado a ${pedido.nombre} (${pedido.telefono})`);
    }

    res.json({ ok: true, retried });
  } catch (err) {
    console.error('❌ Error en reintentos:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── ENDPOINT: ESTADÍSTICAS ───────────────────────────────
app.get('/api/stats', async (req, res) => {
  try {
    const pedidos = await getFromFirebase('pedidos');
    if (!pedidos) return res.json({ total: 0 });

    const arr = Object.values(pedidos);
    const stats = {
      total: arr.length,
      pendiente: arr.filter(p => p.estado === 'pendiente').length,
      confirmado: arr.filter(p => p.estado === 'confirmado').length,
      enviado: arr.filter(p => p.estado === 'enviado').length,
      entregado: arr.filter(p => p.estado === 'entregado').length,
      devuelto: arr.filter(p => p.estado === 'devuelto').length,
      novedad: arr.filter(p => p.estado === 'novedad').length,
      noConfirmado: arr.filter(p => p.estado === 'no-confirmado').length,
      recaudado: arr.filter(p => p.estado === 'entregado').reduce((a, b) => a + Number(b.valor || 0), 0),
    };

    const confirmados = stats.confirmado + stats.enviado + stats.entregado + stats.devuelto + stats.novedad;
    const baseConf = confirmados + stats.pendiente + stats.noConfirmado;
    stats.tasaConfirmacion = baseConf ? Math.round(confirmados / baseConf * 100) : 0;
    stats.tasaEntrega = (stats.entregado + stats.devuelto) ? Math.round(stats.entregado / (stats.entregado + stats.devuelto) * 100) : 0;

    res.json(stats);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── ARRANCAR SERVIDOR ────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🚀 COD Tracker Backend corriendo en puerto ${PORT}`);
  console.log(`   Shopify store: ${process.env.SHOPIFY_STORE}`);
  console.log(`   Firebase: ${process.env.FIREBASE_DATABASE_URL}`);
  console.log(`   WhatsApp: ${process.env.ULTRAMSG_INSTANCE ? 'configurado' : 'no configurado'}\n`);
});

module.exports = app;
