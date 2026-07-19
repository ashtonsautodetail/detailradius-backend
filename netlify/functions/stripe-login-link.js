// Gives a detailer a one-click link into their own Stripe Express dashboard
// so they can see their payout history and balance without you building
// that view yourself.
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  try {
    const { detailerId } = JSON.parse(event.body);
    if (!detailerId) return { statusCode: 400, body: JSON.stringify({ error: 'Missing detailerId' }) };

    const { data: detailer, error } = await supabase
      .from('detailers')
      .select('stripe_account_id')
      .eq('id', detailerId)
      .single();

    if (error || !detailer || !detailer.stripe_account_id) {
      return { statusCode: 400, body: JSON.stringify({ error: 'No connected Stripe account yet' }) };
    }

    const loginLink = await stripe.accounts.createLoginLink(detailer.stripe_account_id);
    return { statusCode: 200, body: JSON.stringify({ url: loginLink.url }) };
  } catch (err) {
    console.error('stripe-login-link error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
