// Runs when a detailer marks a job "Complete." This is the only place money
// actually leaves the platform's Stripe balance. It transfers 95% (97% for Pro) of every
// charge collected for this job (deposit, and remainder if there was one) to
// the detailer's connected account. The remainder stays behind — that's the
// platform fee (0% for founding detailers on their first 10 jobs). Refuses to run if a balance is still owed.
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

// Plan-based platform fee: free detailers keep 95%, Pro members keep 97%.
// Overridable via env so the rates can change without a code deploy.
const FEE_FREE = parseFloat(process.env.PLATFORM_FEE_FREE || '0.05');
const FEE_PRO = parseFloat(process.env.PLATFORM_FEE_PRO || '0.03');

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
      .select('*, detailers(stripe_account_id, pro, founding)')
      .eq('id', jobId)
      .single();

    if (error || !job) return { statusCode: 404, headers: corsHeaders, body: JSON.stringify({ error: 'Job not found' }) };

    // IDEMPOTENCY GUARD (money-safety): if this job has already paid out, never run
    // the transfers again. Without this, a double-click or a retry would attempt to
    // pay the detailer a second time. Combined with the idempotency keys below, a
    // payout for a given job can happen at most once.
    if (job.payment_status === 'transferred') {
      return { statusCode: 200, headers: corsHeaders, body: JSON.stringify({ success: true, alreadyCompleted: true, transferIds: [] }) };
    }

    const accountId = job.detailers && job.detailers.stripe_account_id;
    if (!accountId) {
      return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: 'This detailer has not connected payouts yet' }) };
    }

    const remainderDue = job.price - (job.deposit_amount || 0);
    if (remainderDue > 0 && job.payment_status !== 'fully_paid') {
      return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: 'The customer still owes a balance on this job — collect that before completing it' }) };
    }

    // Nothing was ever collected — refuse rather than transfer $0 / from the wrong balance.
    if (!job.deposit_charge_id && !job.remainder_charge_id) {
      return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: 'No payment has been collected for this job yet' }) };
    }

    // Pro members pay the lower platform fee.
    let PLATFORM_CUT = (job.detailers && job.detailers.pro) ? FEE_PRO : FEE_FREE;

    // FOUNDING DETAILER OFFER: 0% platform fee on the first 10 completed jobs.
    // The flag is set manually (detailers.founding) when Ashton approves a founding
    // spot. Count prior completed payouts; this job qualifies if fewer than 10 exist.
    if (job.detailers && job.detailers.founding) {
      const { count } = await supabase
        .from('jobs')
        .select('id', { count: 'exact', head: true })
        .eq('detailer_id', job.detailer_id)
        .eq('payment_status', 'transferred');
      if ((count || 0) < 10) PLATFORM_CUT = 0;
    }

    const transferIds = [];

    if (job.deposit_charge_id) {
      const chargeId = await chargeIdFromPaymentIntent(job.deposit_charge_id);
      if (!chargeId) {
        return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: 'Deposit payment has not settled yet — try again shortly' }) };
      }
      const amount = Math.round((job.deposit_amount || 0) * 100 * (1 - PLATFORM_CUT));
      const t = await stripe.transfers.create({
        amount,
        currency: 'usd',
        destination: accountId,
        source_transaction: chargeId,
        transfer_group: `job_${jobId}`,
      }, { idempotencyKey: `transfer_job_${jobId}_deposit` });
      transferIds.push(t.id);
    }

    if (job.remainder_charge_id) {
      const chargeId = await chargeIdFromPaymentIntent(job.remainder_charge_id);
      if (!chargeId) {
        return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: 'Balance payment has not settled yet — try again shortly' }) };
      }
      const remainderDollars = job.price - (job.deposit_amount || 0);
      const amount = Math.round(remainderDollars * 100 * (1 - PLATFORM_CUT));
      const t = await stripe.transfers.create({
        amount,
        currency: 'usd',
        destination: accountId,
        source_transaction: chargeId,
        transfer_group: `job_${jobId}`,
      }, { idempotencyKey: `transfer_job_${jobId}_remainder` });
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
