// Runs when a detailer marks a job "Complete." This is the only place money
// actually leaves the platform's Stripe balance. It transfers the detailer's
// share of every charge collected for this job (deposit, and remainder if there
// was one) to their connected account. What stays behind = the platform fee
// (0% for founding detailers on their first 10 jobs) + the card-processing
// cost, which is passed through AT COST (Stripe's own 2.9% + 30¢ per charge —
// the same thing any Square/Clover card reader charges a detailer). Tips are
// exempt: they pass through at a true 100%; the platform eats the pennies of
// processing on tips. Refuses to run if a balance is still owed.
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const { authUserId, unauthorized, forbidden } = require('./_auth');

// Plan-based platform fee: free detailers keep 95%, Pro members keep 97%.
// Overridable via env so the rates can change without a code deploy.
const FEE_FREE = parseFloat(process.env.PLATFORM_FEE_FREE || '0.05');
const FEE_PRO = parseFloat(process.env.PLATFORM_FEE_PRO || '0.03');

// Card-processing pass-through, at cost (Stripe standard US pricing). If Stripe
// ever changes its pricing, update via env — no code deploy needed.
const CARD_PCT = parseFloat(process.env.CARD_FEE_PCT || '0.029');
const CARD_FIXED = parseInt(process.env.CARD_FEE_FIXED_CENTS || '30', 10);

// Processing cost for one charge of `serviceCents` (tip excluded by callers).
function processingCents(serviceCents) {
  if (serviceCents <= 0) return 0;
  return Math.round(serviceCents * CARD_PCT) + CARD_FIXED;
}

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

  // Hoisted so the catch block can revert the payout claim on failure.
  let jobId, priorStatus;
  try {
    ({ jobId } = JSON.parse(event.body));
    if (!jobId) return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: 'Missing jobId' }) };

    const { data: job, error } = await supabase
      .from('jobs')
      .select('*, detailers(stripe_account_id, pro, founding, user_id)')
      .eq('id', jobId)
      .single();

    if (error || !job) return { statusCode: 404, headers: corsHeaders, body: JSON.stringify({ error: 'Job not found' }) };

    // AUTH (money-safety): only the detailer who owns this job can complete it and
    // release its payout. Without this, anyone could POST a guessed jobId and move
    // money / force-close jobs across the whole marketplace.
    const uid = await authUserId(event);
    if (!uid) return unauthorized(corsHeaders);
    if (!job.detailers || job.detailers.user_id !== uid) return forbidden(corsHeaders);

    // IDEMPOTENCY GUARD (money-safety): if this job has already paid out, never run
    // the transfers again. Without this, a double-click or a retry would attempt to
    // pay the detailer a second time. Combined with the idempotency keys below, a
    // payout for a given job can happen at most once.
    if (job.payment_status === 'transferred') {
      return { statusCode: 200, headers: corsHeaders, body: JSON.stringify({ success: true, alreadyCompleted: true, transferIds: [] }) };
    }
    if (job.payment_status === 'transferring') {
      // Another request is mid-payout for this job right now — don't run a second.
      return { statusCode: 200, headers: corsHeaders, body: JSON.stringify({ success: true, alreadyCompleted: true, transferIds: [] }) };
    }

    const accountId = job.detailers && job.detailers.stripe_account_id;
    if (!accountId) {
      return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: 'This detailer has not connected payouts yet' }) };
    }

    const remainderDue = job.price - (job.deposit_amount || 0);
    // CASH BALANCE: when the customer chose to pay the remainder in cash on
    // site (jobs.balance_method = 'cash'), the deposit is the only card money
    // — the detailer collects the rest in person, so completing is allowed
    // with just the deposit paid. Only the deposit share transfers via Stripe.
    const cashBalance = job.balance_method === 'cash';
    if (remainderDue > 0 && job.payment_status !== 'fully_paid' && !cashBalance) {
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

    // CLAIM THE JOB (money-safety): atomically flip payment_status to
    // 'transferring' only if it's still the value we read. If another concurrent
    // request already claimed it, 0 rows change and we bail — this closes the
    // check-then-act race that the per-charge idempotency keys can't cover after
    // their ~24h window expires.
    priorStatus = job.payment_status;
    const { data: claimed, error: claimErr } = await supabase
      .from('jobs')
      .update({ payment_status: 'transferring' })
      .eq('id', jobId)
      .eq('payment_status', priorStatus)
      .select('id');
    if (claimErr) {
      return { statusCode: 500, headers: corsHeaders, body: JSON.stringify({ error: 'Couldn’t start the payout. Please try again.' }) };
    }
    if (!claimed || claimed.length === 0) {
      // Someone else claimed it between our read and write.
      return { statusCode: 200, headers: corsHeaders, body: JSON.stringify({ success: true, alreadyCompleted: true, transferIds: [] }) };
    }

    const transferIds = [];

    if (job.deposit_charge_id) {
      const chargeId = await chargeIdFromPaymentIntent(job.deposit_charge_id);
      if (!chargeId) {
        return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: 'Deposit payment has not settled yet — try again shortly' }) };
      }
      const depositCents = Math.round((job.deposit_amount || 0) * 100);
      const amount = Math.max(0, Math.round(depositCents * (1 - PLATFORM_CUT)) - processingCents(depositCents));
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
      // Tip (if any) was collected on this same charge — it passes through at
      // 100%; the platform fee and card-processing pass-through only ever apply
      // to the service price, never the tip.
      const tipCents = Math.max(0, Math.round((parseFloat(job.tip_amount) || 0) * 100));
      const serviceCents = Math.round(remainderDollars * 100);
      const amount = Math.max(0, Math.round(serviceCents * (1 - PLATFORM_CUT)) - processingCents(serviceCents)) + tipCents;
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
      // Transfers succeeded but the final status write failed. Leave the row in
      // 'transferring' (NOT reverted) so a retry won't re-transfer — the payout
      // already happened; this needs manual reconciliation, logged for the owner.
      console.error('stripe-complete-job: payout done but status write failed for job', jobId, updateErr.message, 'transfers:', transferIds.join(','));
      return { statusCode: 500, headers: corsHeaders, body: JSON.stringify({ error: 'Your payout was sent, but we hit a snag updating the job. It’s recorded — refresh in a moment.', transferIds }) };
    }

    return { statusCode: 200, headers: corsHeaders, body: JSON.stringify({ success: true, transferIds }) };
  } catch (err) {
    console.error('stripe-complete-job error:', err && err.message);
    // A transfer threw. Revert our claim so the detailer can safely retry — the
    // per-charge idempotency keys guarantee no charge is transferred twice.
    try {
      if (jobId && priorStatus) {
        await supabase.from('jobs').update({ payment_status: priorStatus }).eq('id', jobId).eq('payment_status', 'transferring');
      }
    } catch (e) { /* best effort */ }
    return { statusCode: 500, headers: corsHeaders, body: JSON.stringify({ error: 'Couldn’t complete the payout just now. Please try again in a moment.' }) };
  }
};
