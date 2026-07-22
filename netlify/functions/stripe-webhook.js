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

    if (jobId && (paymentType === 'deposit' || paymentType === 'remainder')) {
      // Read the current row so out-of-order or duplicate deliveries can't move the
      // job backwards (e.g. a late deposit event overwriting an already-paid-off or
      // already-transferred job).
      const { data: job, error: readErr } = await supabase
        .from('jobs').select('payment_status').eq('id', jobId).single();

      if (readErr || !job) {
        // Can't find the job (or a transient read error) — return non-2xx so Stripe
        // retries later rather than silently dropping a real payment.
        console.error('Webhook: job lookup failed for', jobId, readErr && readErr.message);
        return { statusCode: 500, body: JSON.stringify({ error: 'job lookup failed' }) };
      }

      // Money has already left the platform for this job — nothing to record.
      if (job.payment_status === 'transferred') {
        return { statusCode: 200, body: JSON.stringify({ received: true, ignored: 'already transferred' }) };
      }

      let update = null;
      if (paymentType === 'deposit' && job.payment_status !== 'fully_paid') {
        update = {
          payment_status: 'deposit_paid',
          deposit_amount: session.amount_total / 100,
          deposit_charge_id: session.payment_intent,
        };
      } else if (paymentType === 'remainder') {
        update = {
          payment_status: 'fully_paid',
          remainder_charge_id: session.payment_intent,
        };
      }

      if (update) {
        const { error } = await supabase.from('jobs').update(update).eq('id', jobId);
        if (error) {
          // Return non-2xx so Stripe re-delivers — never lose a payment to a transient write.
          console.error('Failed to record payment for job', jobId, error.message);
          return { statusCode: 500, body: JSON.stringify({ error: 'db write failed' }) };
        }
      }
    }
  }

  return { statusCode: 200, body: JSON.stringify({ received: true }) };
};
