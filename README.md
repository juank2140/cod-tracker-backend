# COD Tracker Backend

Backend para automatizar pedidos Shopify → Firebase → WhatsApp.

## Lo que hace

1. Recibe webhooks de Shopify cuando entra un pedido nuevo
2. Crea el pedido automáticamente en Firebase (aparece en COD Tracker)
3. Envía WhatsApp de confirmación al cliente
4. Cuando el cliente responde SÍ → cambia estado a Confirmado
5. Cuando asignas una guía → envía WhatsApp con el número de tracking

---

## Despliegue en Railway (paso a paso)

### 1. Subir el código a GitHub

1. Ve a github.com → New repository
2. Nombre: `cod-tracker-backend`
3. Público o privado (da igual)
4. Sube estos archivos:
   - `index.js`
   - `package.json`
   - `.env.example`
   - `README.md`

### 2. Crear proyecto en Railway

1. Ve a railway.app
2. New Project → Deploy from GitHub repo
3. Selecciona `cod-tracker-backend`
4. Railway detecta automáticamente que es Node.js

### 3. Configurar variables de entorno en Railway

En Railway → tu proyecto → Variables, agrega:

```
SHOPIFY_STORE=be423b-ca.myshopify.com
SHOPIFY_ACCESS_TOKEN=shpat_TU_TOKEN_COMPLETO
SHOPIFY_WEBHOOK_SECRET=lo_generas_al_crear_el_webhook
FIREBASE_DATABASE_URL=https://cod-tracker-1daaf-default-rtdb.firebaseio.com
FIREBASE_PROJECT_ID=cod-tracker-1daaf
ULTRAMSG_INSTANCE=TU_INSTANCIA (cuando lo tengas)
ULTRAMSG_TOKEN=TU_TOKEN (cuando lo tengas)
PORT=3000
```

### 4. Obtener la URL de Railway

Después del deploy Railway te da una URL como:
`https://cod-tracker-backend.up.railway.app`

Esa es la URL base de tu backend.

### 5. Registrar webhooks en Shopify

Ve a tu admin de Shopify → Configuración → Notificaciones → Webhooks

Agrega estos dos webhooks:

| Evento | URL |
|--------|-----|
| Creación de pedido | `https://TU-URL.railway.app/webhook/orders/create` |
| Actualización de pedido | `https://TU-URL.railway.app/webhook/orders/updated` |

Formato: JSON
Versión API: 2026-04

Shopify te muestra un "Signing secret" — cópialo y ponlo en Railway como `SHOPIFY_WEBHOOK_SECRET`.

---

## Endpoints disponibles

| Método | Ruta | Descripción |
|--------|------|-------------|
| GET | `/` | Health check — verifica que está online |
| POST | `/webhook/orders/create` | Recibe nuevos pedidos de Shopify |
| POST | `/webhook/orders/updated` | Recibe actualizaciones de Shopify |
| POST | `/whatsapp/incoming` | Recibe respuestas de WhatsApp (UltraMsg) |
| POST | `/api/notify-guide` | Notifica guía asignada al cliente |
| POST | `/api/retry-confirmation` | Reenvía WhatsApp a pendientes sin respuesta |
| GET | `/api/stats` | Estadísticas generales |

---

## Conectar UltraMsg (WhatsApp)

1. Ve a ultramsg.com → crear cuenta
2. Crea una instancia → escanea el QR con tu WhatsApp Business
3. Copia el Instance ID y el Token
4. Agrégalos en Railway como variables de entorno
5. En UltraMsg → Webhook → pon: `https://TU-URL.railway.app/whatsapp/incoming`

---

## Integración con COD Tracker (index.html)

Cuando asignes una guía en el COD Tracker, el sistema llamará automáticamente
al endpoint `/api/notify-guide` para enviar el WhatsApp al cliente.

(Esta integración se agrega al index.html en la siguiente fase)

---

## Flujo completo

```
Cliente compra en Shopify
        ↓
Webhook → Backend Railway
        ↓
Firebase ← Pedido creado (aparece en COD Tracker)
        ↓
WhatsApp → "Hola, confirma tu pedido respondiendo SÍ"
        ↓
Cliente responde SÍ
        ↓
Firebase ← Estado: Confirmado
WhatsApp → "¡Confirmado! Pronto te enviamos la guía"
        ↓
Tú asignas guía en COD Tracker
        ↓
Backend → WhatsApp → "Tu pedido va en camino. Guía: XXXX"
```
