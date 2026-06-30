// ============================================================
//  POST /api/webhook  ->  Webhook de Stripe
//  - Confirma los pagos (incluida la transferencia, que es asincrona).
//  - Asigna el NUMERO DE PIEZA de la edicion a cada donacion completada,
//    de forma secuencial, atomica y sin duplicados, usando un contador
//    en el almacen KV (Redis de Vercel / Upstash).
//  - Opcionalmente envia un correo al donante con su numero (si hay Resend).
//
//  Variables de entorno en Vercel:
//    STRIPE_SECRET_KEY       -> clave secreta
//    STRIPE_WEBHOOK_SECRET   -> secreto del endpoint (whsec_...)
//    KV_REST_API_URL  + KV_REST_API_TOKEN          (Vercel KV)
//      o  UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN  (Upstash)
//    PIECE_NUMBER_START      -> (opcional) primer numero, por defecto 1
//    RESEND_API_KEY          -> (opcional) para enviar el correo del numero
//    DONATION_FROM_EMAIL     -> (opcional) remitente, p. ej. "Fragmentos de Esperanza <noreply@disstands.com>"
// ============================================================
const Stripe = require('stripe');

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: '2024-06-20',
});

// ---- Helpers de almacen KV (Redis via REST) ----
function kvConfig() {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  return { url, token };
}

async function kv(command) {
  const { url, token } = kvConfig();
  if (!url || !token) throw new Error('Almacen KV no configurado (faltan variables de entorno).');
  const resp = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(command),
  });
  const data = await resp.json();
  if (data.error) throw new Error('KV: ' + data.error);
  return data.result;
}

// ---- Correo opcional con el numero de pieza (via Resend) ----
async function enviarCorreoPieza(email, numero, importeEur, nombre) {
  if (!process.env.RESEND_API_KEY || !email) return; // sin credenciales no se envia, el resto sigue
  const from = process.env.DONATION_FROM_EMAIL || 'Fragmentos de Esperanza <noreply@disstands.com>';
  const num = String(numero);
  const nombreSeguro = String(nombre || '').replace(/[<>&"]/g, function (c) {
    return { '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c];
  });
  const titulo = nombreSeguro ? '&iexcl;Gracias, ' + nombreSeguro + '!' : 'Gracias por tu donaci&oacute;n';
  const html =
    '<div style="background:#1d232f;color:#ece4d3;font-family:Georgia,serif;padding:40px 24px;text-align:center;">' +
    '<p style="letter-spacing:.26em;text-transform:uppercase;font-size:12px;color:#ac8040;margin:0 0 8px;">Fragmentos de Esperanza</p>' +
    '<h1 style="font-size:26px;margin:0 0 6px;color:#ece4d3;">' + titulo + '</h1>' +
    '<p style="color:rgba(236,228,211,.7);font-style:italic;margin:0 0 26px;">Tu donaci&oacute;n va &iacute;ntegra a la lucha contra el c&aacute;ncer infantil.</p>' +
    '<div style="display:inline-block;border:1.5px solid #ac8040;border-radius:6px;padding:22px 34px;margin:0 0 24px;">' +
    '<p style="margin:0 0 4px;font-size:12px;letter-spacing:.2em;text-transform:uppercase;color:#ac8040;">Tu pieza</p>' +
    '<p style="margin:0;font-size:42px;color:#c99a55;font-weight:bold;">N&ordm; ' + num + '</p></div>' +
    '<p style="color:rgba(236,228,211,.7);font-size:14px;margin:0;">Sostienes un fragmento de un instante que no volver&aacute; a repetirse.</p>' +
    (importeEur ? '<p style="color:rgba(236,228,211,.5);font-size:13px;margin:18px 0 0;">Donativo: ' + importeEur + ' &euro;</p>' : '') +
    '</div>';

  // Copia para la organizacion (notificacion interna de cada donacion).
  const notify = process.env.DONATION_NOTIFY_EMAIL || 'cancerinfantil@disstands.com';

  try {
    const payload = {
      from,
      to: [email],
      subject: 'Tu pieza Nº ' + num + ' · Fragmentos de Esperanza',
      html,
    };
    if (notify) payload.bcc = [notify];
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch (e) {
    console.error('Error enviando correo de pieza (Resend):', e.message);
  }
}

// ---- Asignacion del numero de pieza (exactamente una vez por pago) ----
async function asignarNumeroPieza(pi) {
  // Ya tiene numero: nada que hacer (reintentos de webhook).
  if (pi.metadata && pi.metadata.pieza_numero) return pi.metadata.pieza_numero;

  // Reclamo atomico por id de pago: solo el primero en llegar continua.
  const claim = await kv(['SET', 'frag:pi:' + pi.id, 'pending', 'NX']);
  if (claim !== 'OK') {
    // Otro proceso ya lo esta asignando o lo asigno: leemos el valor guardado.
    const guardado = await kv(['GET', 'frag:pi:' + pi.id]);
    return guardado && guardado !== 'pending' ? guardado : null;
  }

  // Contador atomico global de la edicion.
  const start = parseInt(process.env.PIECE_NUMBER_START || '1', 10);
  const incr = await kv(['INCR', 'frag:contador_piezas']);
  const numero = start - 1 + Number(incr);

  // Guardamos el numero final en KV y en los metadatos del pago (verificable).
  await kv(['SET', 'frag:pi:' + pi.id, String(numero)]);
  await stripe.paymentIntents.update(pi.id, {
    metadata: Object.assign({}, pi.metadata, { pieza_numero: String(numero) }),
  });

  // Correo opcional con el numero.
  const importeEur = (pi.amount / 100).toFixed(2).replace('.', ',');
  const nombre = (pi.metadata && pi.metadata.nombre) || '';
  await enviarCorreoPieza(pi.receipt_email, numero, importeEur, nombre);

  console.log('Pieza asignada:', numero, '->', pi.id);
  return String(numero);
}

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    res.status(405).end();
    return;
  }

  let event;
  try {
    const rawBody = await readRawBody(req);
    const signature = req.headers['stripe-signature'];
    event = stripe.webhooks.constructEvent(rawBody, signature, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Firma de webhook invalida:', err.message);
    res.status(400).send(`Webhook Error: ${err.message}`);
    return;
  }

  try {
    switch (event.type) {
      case 'payment_intent.succeeded': {
        const pi = event.data.object;
        // Donacion confirmada -> asignamos numero de pieza.
        await asignarNumeroPieza(pi);
        break;
      }
      case 'payment_intent.processing': {
        // Pago en curso (tipico de la transferencia). No se asigna numero
        // hasta que el dinero llega y el evento pasa a succeeded.
        console.log('Donacion en proceso:', event.data.object.id);
        break;
      }
      case 'payment_intent.payment_failed': {
        console.log('Donacion fallida:', event.data.object.id);
        break;
      }
      default:
        break;
    }
  } catch (err) {
    // Si algo falla (p. ej. KV no disponible), respondemos 500 para que
    // Stripe REINTENTE el webhook mas tarde y no se pierda el numero.
    console.error('Error procesando webhook:', err.message);
    res.status(500).json({ error: 'procesando' });
    return;
  }

  res.status(200).json({ received: true });
};

// Vercel: no parsear el cuerpo para poder verificar la firma de Stripe.
module.exports.config = {
  api: { bodyParser: false },
};
