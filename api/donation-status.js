// ============================================================
//  GET /api/donation-status?payment_intent=pi_xxx
//  Devuelve el estado del pago y, si ya se ha asignado, el numero
//  de pieza (metadata.pieza_numero). La pagina de gracias consulta
//  este endpoint hasta que el webhook asigna el numero.
// ============================================================
const Stripe = require('stripe');

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: '2024-06-20',
});

module.exports = async (req, res) => {
  const id = req.query && req.query.payment_intent;
  if (!id) {
    res.status(400).json({ error: 'Falta payment_intent' });
    return;
  }
  try {
    const pi = await stripe.paymentIntents.retrieve(String(id));
    res.status(200).json({
      status: pi.status,
      numero: pi.metadata && pi.metadata.pieza_numero ? pi.metadata.pieza_numero : null,
      amount: pi.amount,
    });
  } catch (err) {
    res.status(404).json({ error: 'Pago no encontrado' });
  }
};
