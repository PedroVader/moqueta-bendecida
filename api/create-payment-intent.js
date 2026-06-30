// ============================================================
//  POST /api/create-payment-intent
//  Crea un PaymentIntent de donacion (importe libre) y devuelve
//  el client_secret para montar el Payment Element en el navegador.
//
//  Metodos de pago: tarjeta, Apple Pay y Google Pay se activan
//  automaticamente (automatic_payment_methods). La transferencia
//  bancaria (customer_balance) requiere un cliente asociado, por eso
//  creamos un Customer con el email del donante.
//
//  Variables de entorno necesarias en Vercel:
//    STRIPE_SECRET_KEY  -> tu clave secreta (sk_live_... / sk_test_...)
// ============================================================
const Stripe = require('stripe');

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: '2024-06-20',
});

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    res.status(405).json({ error: 'Metodo no permitido' });
    return;
  }

  // Comprobacion explicita de configuracion (causa mas frecuente del fallo).
  if (!process.env.STRIPE_SECRET_KEY) {
    res.status(500).json({ error: 'Falta STRIPE_SECRET_KEY en las variables de entorno de Vercel (anadela y haz Redeploy).' });
    return;
  }

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const rawAmount = String(body.amount == null ? '' : body.amount).replace(',', '.');
    const euros = parseFloat(rawAmount);
    const email = (body.email || '').trim();

    // Stripe rechaza importes < 0,50 EUR en tarjeta; aplicamos ese minimo tecnico.
    if (!Number.isFinite(euros) || euros < 0.5) {
      res.status(400).json({ error: 'El importe minimo aceptado por la pasarela es 0,50 EUR.' });
      return;
    }
    const cents = Math.round(euros * 100);

    // Cliente (necesario para la transferencia bancaria y util para el recibo)
    let customerId;
    if (email) {
      const customer = await stripe.customers.create({ email });
      customerId = customer.id;
    }

    const intent = await stripe.paymentIntents.create({
      amount: cents,
      currency: 'eur',
      customer: customerId,
      receipt_email: email || undefined,
      description: 'Donacion - Fragmentos de Esperanza',
      statement_descriptor_suffix: 'FRAGMENTOS',
      automatic_payment_methods: { enabled: true },
      metadata: {
        proyecto: 'Fragmentos de Esperanza',
        tipo: 'donacion',
      },
    });

    res.status(200).json({ clientSecret: intent.client_secret });
  } catch (err) {
    console.error('create-payment-intent error:', err);
    // DIAGNOSTICO TEMPORAL: devolvemos el detalle real para identificar el fallo.
    // (Quitar esta exposicion cuando el pago funcione.)
    res.status(500).json({
      error: 'No se ha podido iniciar el pago. Intentalo de nuevo.',
      detalle: err && err.message ? err.message : String(err),
      tipo: err && err.type ? err.type : undefined,
    });
  }
};
