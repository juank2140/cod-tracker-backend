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
  if (fulfillmentStatus === 'fulfilled') return 'enviado';      // Preparado/Despachado → En camino
  if (fulfillmentStatus === 'partial') return 'enviado';        // Parcialmente despachado → En camino
  if (financialStatus === 'paid') return 'confirmado';          // Pagado → Confirmado
  return 'pendiente';                                           // Todo lo demás → Pendiente
}

// ── ENVIAR WHATSAPP VIA WASENDERAPI ──────────────────────
async function enviarWhatsApp(telefono, mensaje) {
  if (!process.env.WASENDER_API_KEY) {
    console.log('⚠️  WhatsApp no configurado — mensaje omitido');
    return null;
  }

  // Formato E.164: +573011779152
  let tel = telefono.replace(/\D/g, '');
  if (tel.startsWith('3') && tel.length === 10) tel = '57' + tel;
  if (!tel.startsWith('+')) tel = '+' + tel;

  try {
    const res = await axios.post(
      'https://www.wasenderapi.com/api/send-message',
      { to: tel, text: mensaje },
      {
        headers: {
          'Authorization': `Bearer ${process.env.WASENDER_API_KEY}`,
          'Content-Type': 'application/json',
        }
      }
    );
    console.log(`✅ WhatsApp enviado a ${tel}`, res.data);
    return res.data;
  } catch (e) {
    console.error('❌ Error WhatsApp:', e.response?.data || e.message);
    return null;
  }
}

// ── CONSULTAR DROPI ──────────────────────────────────────
async function consultarDropi(telefono) {
  try {
    // Obtener token desde Firebase
    const config = await getFromFirebase('config');
    const dropiToken = config?.dropiToken;
    if (!dropiToken) {
      console.log('⚠️  Token Dropi no configurado');
      return null;
    }

    const tel = telefono.replace(/\D/g, '').slice(-10);
    const url = `https://api-v2.dropi.co/bff/customers/fingerprint/v2?country_code=CO&user_id=202912&phone=${tel}&months=0`;

    const res = await axios.get(url, {
      headers: {
        'X-Authorization': `Bearer ${dropiToken}`,
        'X-Host': 'co',
        'Accept': 'application/json',
        'Referer': 'https://app.dropi.co/',
      },
      timeout: 8000,
    });

    const data = res.data?.data;
    if (!data?.found) return { found: false, riesgo: 'Sin historial', color: 'gray', tipo: 'Nuevo' };

    const gp = data.global_profile;
    return {
      found: true,
      riesgo: gp.risk_label || 'Sin historial',
      color: gp.risk_color || 'gray',
      tipo: gp.buyer_type || 'Nuevo',
      totalPedidos: gp.lifetime_totals?.orders || 0,
      entregados: gp.lifetime_totals?.delivered || 0,
      devueltos: gp.lifetime_totals?.returned || 0,
    };
  } catch (e) {
    console.error('❌ Error consultando Dropi:', e.response?.data || e.message);
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

    // 3. Consultar Dropi para análisis de riesgo
    let dropiData = null;
    if (telefono) {
      dropiData = await consultarDropi(telefono);
      if (dropiData) console.log(`🔍 Dropi: ${dropiData.riesgo} — ${dropiData.tipo}`);
    }

    // 4. Crear pedido en Firebase
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
      dropi: dropiData || null,
    };

    await writeToFirebase('pedidos', pedidoCOD);
    console.log(`✅ Pedido ${id} guardado en Firebase`);

    // 5. Enviar WhatsApp de confirmación si hay teléfono
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

    // ── EXTRAER GUÍA Y TRANSPORTADORA DE SHOPIFY ──────────
    // Effi sube la guía como tracking number en el fulfillment
    let guia = pedido.guia || '';
    let transportadora = pedido.transportadora || '';
    let guiaNueva = false;

    const fulfillments = order.fulfillments || [];
    if (fulfillments.length > 0) {
      const lastFulfillment = fulfillments[fulfillments.length - 1];
      const trackingNumber = lastFulfillment.tracking_number || '';
      const trackingCompany = lastFulfillment.tracking_company || '';

      if (trackingNumber && trackingNumber !== pedido.guia) {
        guia = trackingNumber;
        transportadora = trackingCompany || pedido.transportadora || '';
        guiaNueva = true;
        console.log(`📦 Guía detectada: ${guia} — ${transportadora}`);
      }
    }

    // ── ACTUALIZAR FIREBASE ────────────────────────────────
    const cambios = { actualizadoEn: Date.now() };
    const historial = pedido.historial || [];

    if (pedido.estado !== nuevoEstado) {
      cambios.estado = nuevoEstado;
      historial.push({ estado: nuevoEstado, fecha: Date.now(), nota: guiaNueva ? `Guía ${guia}` : 'Actualizado desde Shopify' });
      cambios.historial = historial;
      console.log(`✅ Estado: ${pedido.estado} → ${nuevoEstado}`);
    }

    if (guiaNueva) {
      cambios.guia = guia;
      cambios.transportadora = transportadora;
    }

    await updateFirebase(`pedidos/${firebaseKey}`, cambios);

    // ── ENVIAR WHATSAPP CON LA GUÍA ────────────────────────
    if (guiaNueva && pedido.telefono) {
      const nombre = (pedido.nombre || '').split(' ')[0];
      const msg =
        `🚚 *¡Tu pedido va en camino!*\n\n` +
        `Hola ${nombre}, tu *${pedido.producto}* fue despachado.\n\n` +
        `📦 *Guía:* ${guia}\n` +
        `🏢 *Transportadora:* ${transportadora}\n\n` +
        `Puedes rastrearlo en la página web de ${transportadora}.\n\n` +
        `_Salud Verde Colombia_`;

      await enviarWhatsApp(pedido.telefono, msg);
      console.log(`✅ WhatsApp de guía enviado a ${pedido.telefono}`);
    }

  } catch (err) {
    console.error('❌ Error actualizando pedido:', err.message);
  }
});

// ── ENDPOINT: RESPUESTA DE WHATSAPP (confirmación cliente) ──
// Cuando el cliente responde SÍ, WasenderAPI llama este endpoint
app.post('/whatsapp/incoming', async (req, res) => {
  res.status(200).json({ ok: true });

  const payload = req.body || {};
  // WasenderAPI formato: data.messages.messageBody y data.messages.key.remoteJid
  const messages = payload?.data?.messages;
  const texto = messages?.messageBody || '';
  const remoteJid = messages?.key?.remoteJid || '';
  // Usar cleanedRemoteJid o extraer del remoteJid
  const cleanedJid = messages?.key?.cleanedRemoteJid || remoteJid;

  if (!texto || !cleanedJid) return;

  const respuesta = texto.trim().toLowerCase();
  // Extraer número limpio: +573011779152 → 3011779152
  const tel = cleanedJid.replace(/\D/g, '').slice(-10);

  console.log(`\n📱 WhatsApp recibido de ${tel}: "${respuesta}"`);

  const esConfirmacion = ['si', 'sí', 'yes', 'ok', 'dale', 'confirmo', '1', 'si!', 'sí!', 'claro'].includes(respuesta);
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

// ── ENDPOINT: ACTUALIZAR TOKEN DROPI ────────────────────
app.post('/api/dropi-token', async (req, res) => {
  const { token } = req.body || {};
  if (!token || !token.startsWith('eyJ')) {
    return res.status(400).json({ error: 'Token inválido' });
  }
  try {
    // Decodificar para verificar expiración
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString());
    const expDate = new Date(payload.exp * 1000);
    const ahora = new Date();
    if (expDate < ahora) {
      return res.status(400).json({ error: 'Token ya expirado', expiro: expDate.toISOString() });
    }
    await updateFirebase('config', { dropiToken: token, dropiTokenExp: payload.exp, dropiTokenUpdated: Date.now() });
    console.log(`✅ Token Dropi actualizado — expira: ${expDate.toLocaleString('es-CO', { timeZone: 'America/Bogota' })}`);
    res.json({ ok: true, expira: expDate.toLocaleString('es-CO', { timeZone: 'America/Bogota' }), horasRestantes: Math.round((payload.exp - ahora.getTime()/1000) / 3600) });
  } catch (e) {
    res.status(500).json({ error: e.message });
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
  console.log(`   WhatsApp: ${process.env.WASENDER_API_KEY ? 'configurado ✅' : 'no configurado'}\n`);
});

module.exports = app;
