// Starts (or resumes) a detailer's Stripe Connect onboarding.
// Creates a connected account the first time, then always returns a fresh
// onboarding link (Stripe links expire after a few minutes / one use).
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  try {
    const { detailerId, returnUrl } = JSON.parse(event.body);
    if (!detailerId || !returnUrl) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Missing detailerId or returnUrl' }) };
    }

    const { data: detailer, error: fetchErr } = await supabase
      .from('detailers')
      .select('id, stripe_account_id')
      .eq('id', detailerId)
      .single();

    if (fetchErr || !detailer) {
      return { statusCode: 404, body: JSON.stringify({ error: 'Detailer not found' }) };
    }

    let accountId = detailer.stripe_account_id;

    // Only create a new Connect account if this detailer doesn't have one yet.
    if (!accountId) {
      const account = await stripe.accounts.create({
        controller: {
          fees: { payer: 'application' },
          losses: { payments: 'application' },
          stripe_dashboard: { type: 'express' },
        },
        capabilities: {
          transfers: { requested: true },
        },
        business_type: 'individual',
        metadata: { detailer_id: String(detailerId) },
      });
      accountId = account.id;

      const { error: updateErr } = await supabase
        .from('detailers')
        .update({ stripe_account_id: accountId })
        .eq('id', detailerId);

      if (updateErr) {
        return { statusCode: 500, body: JSON.stringify({ error: 'Account created but failed to save: ' + updateErr.message }) };
      }
    }

    // Always issue a fresh Account Link — these expire quickly and can only be used once.
    const accountLink = await stripe.accountLinks.create({
      account: accountId,
      refresh_url: returnUrl,
      return_url: returnUrl,
      type: 'account_onboarding',
    });

    return { statusCode: 200, body: JSON.stringify({ url: accountLink.url }) };
  } catch (err) {
    console.error('stripe-connect-account error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
