// Creates a Stripe Checkout Session for either:
//  - "deposit": charged at booking time, secures the job
//  - "remainder": charged once the detailer sets the real final price
// Both charges land in the platform's own Stripe balance and are held there
// until the detailer marks the job complete.
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

// Deposit is 25% of the price shown at booking. Change this if you want a different amount.
const DEPOSIT_PERCENT = 0.25;

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: corsHeaders, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  try {
    const { jobId, type, successUrl, cancelUrl } = JSON.parse(event.body);
    if (!jobId || !type || !successUrl || !cancelUrl) {
      return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: 'Missing required fields' }) };
    }

    const { data: job, error } = await supabase.from('jobs').select('*').eq('id', jobId).single();
    if (error || !job) {
      console.error('stripe-checkout job lookup failed:', error ? error.message : 'no matching job row');
      return { statusCode: 404, headers: corsHeaders, body: JSON.stringify({ error: 'Job not found' }) };
    }

    let amountCents, description, tipCents = 0;

    if (type === 'deposit') {
      if (job.payment_status && job.payment_status !== 'pending_deposit') {
        return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: 'Deposit already handled for this job' }) };
      }
      const depositDollars = Math.max(1, Math.round(job.price * DEPOSIT_PERCENT));
      amountCents = depositDollars * 100;
      description = `Deposit — ${job.service} (${job.vehicle})`;
    } else if (type === 'remainder') {
      // Don't let a second remainder checkout be created once the job is paid off
      // (or already transferred) — that would double-charge the customer.
      if (job.payment_status === 'fully_paid' || job.payment_status === 'transferred') {
        return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: 'This job is already paid in full' }) };
      }
      const remainderDollars = job.price - (job.deposit_amount || 0);
      if (remainderDollars <= 0) {
        return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: 'No balance due on this job' }) };
      }
      amountCents = remainderDollars * 100;
      description = `Balance due — ${job.service} (${job.vehicle})`;
      // Optional tip chosen by the customer (jobs.tip_amount, written by the
      // frontend right before this call). Tips ride as their own line item and
      // are transferred to the detailer at 100% — no platform fee on tips.
      tipCents = Math.round((parseFloat(job.tip_amount) || 0) * 100);
      if (tipCents < 0 || tipCents > 50000) tipCents = 0; // sanity: $0–$500
    } else {
      return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: 'type must be "deposit" or "remainder"' }) };
    }

    const lineItems = [{
      price_data: {
        currency: 'usd',
        product_data: { name: description },
        unit_amount: amountCents,
      },
      quantity: 1,
    }];
    if (typeof tipCents === 'number' && tipCents > 0) {
      lineItems.push({
        price_data: {
          currency: 'usd',
          product_data: { name: 'Tip for your detailer (they keep 100%)' },
          unit_amount: tipCents,
        },
        quantity: 1,
      });
    }
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      line_items: lineItems,
      payment_intent_data: {
        transfer_group: `job_${jobId}`,
        metadata: { job_id: String(jobId), payment_type: type },
      },
      metadata: { job_id: String(jobId), payment_type: type },
      customer_email: job.customer_email || undefined,
      success_url: successUrl,
      cancel_url: cancelUrl,
    });

    return { statusCode: 200, headers: corsHeaders, body: JSON.stringify({ url: session.url }) };
  } catch (err) {
    console.error('stripe-checkout error:', err);
    return { statusCode: 500, headers: corsHeaders, body: JSON.stringify({ error: err.message }) };
  }
};
