// Returns a detailer's *real* Stripe Connect onboarding status so the frontend
// can show accurate state ("not connected" / "finish setup" / "verified") instead
// of guessing from whether a stripe_account_id exists. An account row can exist
// while onboarding is incomplete, so "has an id" is NOT the same as "can get paid".
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

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
    const { detailerId } = JSON.parse(event.body || '{}');
    if (!detailerId) {
      return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: 'Missing detailerId' }) };
    }

    const { data: detailer, error } = await supabase
      .from('detailers')
      .select('stripe_account_id')
      .eq('id', detailerId)
      .single();

    if (error || !detailer) {
      return { statusCode: 404, headers: corsHeaders, body: JSON.stringify({ error: 'Detailer not found' }) };
    }

    // No account created yet — clean "not connected" state, not an error.
    if (!detailer.stripe_account_id) {
      return {
        statusCode: 200,
        headers: corsHeaders,
        body: JSON.stringify({ status: 'none', connected: false, detailsSubmitted: false, chargesEnabled: false, payoutsEnabled: false }),
      };
    }

    let acct;
    try {
      acct = await stripe.accounts.retrieve(detailer.stripe_account_id);
    } catch (e) {
      // Account id is stale/invalid (e.g. left over from a different Stripe mode).
      // Treat as not-connected so the detailer can start fresh instead of hitting a wall.
      console.error('stripe-account-status retrieve error:', e.message);
      return {
        statusCode: 200,
        headers: corsHeaders,
        body: JSON.stringify({ status: 'none', connected: false, detailsSubmitted: false, chargesEnabled: false, payoutsEnabled: false, stale: true }),
      };
    }

    const detailsSubmitted = !!acct.details_submitted;
    const chargesEnabled = !!acct.charges_enabled;
    const payoutsEnabled = !!acct.payouts_enabled;
    const fullyEnabled = detailsSubmitted && payoutsEnabled;

    // What still stands between them and getting paid (from Stripe's own requirements).
    const req = acct.requirements || {};
    const pending = []
      .concat(req.currently_due || [])
      .concat(req.past_due || []);

    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify({
        status: fullyEnabled ? 'verified' : (detailsSubmitted ? 'pending' : 'incomplete'),
        connected: true,
        detailsSubmitted,
        chargesEnabled,
        payoutsEnabled,
        disabledReason: req.disabled_reason || null,
        requirementsCount: pending.length,
      }),
    };
  } catch (err) {
    console.error('stripe-account-status error:', err);
    return { statusCode: 500, headers: corsHeaders, body: JSON.stringify({ error: err.message }) };
  }
};
