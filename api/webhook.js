// ============================================================
//  POST /api/webhook  ->  Webhook de Stripe
//  Confirma los pagos, incluidos los ASINCRONOS como la
//  transferencia bancaria, que se completan minutos/dias despues.
//
//  Variables de entorno necesarias en Vercel:
//    STRIPE_SECRET_KEY      -> clave secreta
//    STRIPE_WEBHOOK_SECRET  -> secreto del endpoint (whsec_...)
//
//  IMPORTANTE: el webhook necesita el cuerpo SIN PARSEAR para poder
//  verificar la firma, por eso desactivamos el bodyParser de Vercel.
// ============================================================
const Stripe = require('stripe');

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: '2024-06-20',
});

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

  switch (event.type) {
    case 'payment_intent.succeeded': {
      const pi = event.data.object;
      // Donacion confirmada (tarjeta, wallets o transferencia ya completada).
      console.log('Donacion confirmada:', pi.id, pi.amount, pi.currency);
      break;
    }
    case 'payment_intent.processing': {
      const pi = event.data.object;
      // Pago en curso (tipico en transferencia bancaria mientras llega el dinero).
      console.log('Donacion en proceso:', pi.id);
      break;
    }
    case 'payment_intent.payment_failed': {
      const pi = event.data.object;
      console.log('Donacion fallida:', pi.id);
      break;
    }
    default:
      break;
  }

  res.status(200).json({ received: true });
};

// Vercel: no parsear el cuerpo para poder verificar la firma de Stripe.
module.exports.config = {
  api: { bodyParser: false },
};
