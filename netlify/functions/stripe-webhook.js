// Stripe calls this URL directly (not your site) whenever a payment event happens.
// This is how the app finds out a payment actually succeeded — the customer's
// browser redirect alone is not proof of payment, since anyone could load the
// success URL without paying. Only this webhook, verified with your webhook
// signing secret, is trustworthy.
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

exports.handler = async (event) => {
  const sig = event.headers['stripe-signature'];
  let stripeEvent;

  try {
    stripeEvent = stripe.webhooks.constructEvent(event.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return { statusCode: 400, body: `Webhook Error: ${err.message}` };
  }

  if (stripeEvent.type === 'checkout.session.completed') {
    const session = stripeEvent.data.object;
    const jobId = session.metadata && session.metadata.job_id;
    const paymentType = session.metadata && session.metadata.payment_type;

    if (jobId && paymentType === 'deposit') {
      const depositDollars = session.amount_total / 100;
      const { error } = await supabase.from('jobs').update({
        payment_status: 'deposit_paid',
        deposit_amount: depositDollars,
        deposit_charge_id: session.payment_intent,
      }).eq('id', jobId);
      if (error) console.error('Failed to record deposit payment:', error);
    } else if (jobId && paymentType === 'remainder') {
      const { error } = await supabase.from('jobs').update({
        payment_status: 'fully_paid',
        remainder_charge_id: session.payment_intent,
      }).eq('id', jobId);
      if (error) console.error('Failed to record remainder payment:', error);
    }
  }

  return { statusCode: 200, body: JSON.stringify({ received: true }) };
};
