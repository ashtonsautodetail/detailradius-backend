// Runs when a detailer marks a job "Complete." This is the only place money
// actually leaves the platform's Stripe balance. It transfers 90% of every
// charge collected for this job (deposit, and remainder if there was one) to
// the detailer's connected account. The other 10% simply stays behind —
// that's the platform fee. Refuses to run if a balance is still owed.
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const PLATFORM_CUT = 0.10;

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

async function chargeIdFromPaymentIntent(paymentIntentId) {
  const pi = await stripe.paymentIntents.retrieve(paymentIntentId);
  return pi.latest_charge;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: corsHeaders, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  try {
    const { jobId } = JSON.parse(event.body);
    if (!jobId) return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: 'Missing jobId' }) };

    const { data: job, error } = await supabase
      .from('jobs')
      .select('*, detailers(stripe_account_id)')
      .eq('id', jobId)
      .single();

    if (error || !job) return { statusCode: 404, headers: corsHeaders, body: JSON.stringify({ error: 'Job not found' }) };

    const accountId = job.detailers && job.detailers.stripe_account_id;
    if (!accountId) {
      return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: 'This detailer has not connected payouts yet' }) };
    }

    const remainderDue = job.price - (job.deposit_amount || 0);
    if (remainderDue > 0 && job.payment_status !== 'fully_paid') {
      return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: 'The customer still owes a balance on this job — collect that before completing it' }) };
    }

    const transferIds = [];

    if (job.deposit_charge_id) {
      const chargeId = await chargeIdFromPaymentIntent(job.deposit_charge_id);
      const amount = Math.round(job.deposit_amount * 100 * (1 - PLATFORM_CUT));
      const t = await stripe.transfers.create({
        amount,
        currency: 'usd',
        destination: accountId,
        source_transaction: chargeId,
        transfer_group: `job_${jobId}`,
      });
      transferIds.push(t.id);
    }

    if (job.remainder_charge_id) {
      const chargeId = await chargeIdFromPaymentIntent(job.remainder_charge_id);
      const remainderDollars = job.price - job.deposit_amount;
      const amount = Math.round(remainderDollars * 100 * (1 - PLATFORM_CUT));
      const t = await stripe.transfers.create({
        amount,
        currency: 'usd',
        destination: accountId,
        source_transaction: chargeId,
        transfer_group: `job_${jobId}`,
      });
      transferIds.push(t.id);
    }

    const { error: updateErr } = await supabase
      .from('jobs')
      .update({ status: 'completed', payment_status: 'transferred' })
      .eq('id', jobId);

    if (updateErr) {
      return { statusCode: 500, headers: corsHeaders, body: JSON.stringify({ error: 'Transfer succeeded but failed to update job status: ' + updateErr.message, transferIds }) };
    }

    return { statusCode: 200, headers: corsHeaders, body: JSON.stringify({ success: true, transferIds }) };
  } catch (err) {
    console.error('stripe-complete-job error:', err);
    return { statusCode: 500, headers: corsHeaders, body: JSON.stringify({ error: err.message }) };
  }
};
