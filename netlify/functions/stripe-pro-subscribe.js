// DetailRadius Pro — $19/mo detailer subscription.
// action:"create"  -> returns a Stripe Checkout (subscription mode) URL
// action:"verify"  -> after return from checkout, confirms the session is paid
//                     and flips detailers.pro = true (works even if webhooks are down)
// action:"status"  -> returns current pro state for a detailer
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const respond = (code, body) => ({ statusCode: code, headers: corsHeaders, body: JSON.stringify(body) });

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: corsHeaders, body: '' };
  if (event.httpMethod !== 'POST') return respond(405, { error: 'Method not allowed' });

  try {
    const { action, detailerId, sessionId, successUrl, cancelUrl } = JSON.parse(event.body || '{}');
    if (!detailerId) return respond(400, { error: 'Missing detailerId' });

    const { data: detailer, error } = await supabase
      .from('detailers')
      .select('id, name, pro, pro_sub_id')
      .eq('id', detailerId)
      .single();
    if (error || !detailer) return respond(404, { error: 'Detailer not found' });

    if (action === 'status') {
      return respond(200, { pro: !!detailer.pro });
    }

    if (action === 'create') {
      if (detailer.pro) return respond(200, { alreadyPro: true });
      if (!successUrl || !cancelUrl) return respond(400, { error: 'Missing return URLs' });

      const session = await stripe.checkout.sessions.create({
        mode: 'subscription',
        line_items: [{
          quantity: 1,
          price_data: {
            currency: 'usd',
            unit_amount: 1900,
            recurring: { interval: 'month' },
            product_data: {
              name: 'DetailRadius Pro',
              description: 'Featured placement, shareable booking link, review tools & priority support',
            },
          },
        }],
        metadata: { detailerId: String(detailerId), type: 'pro' },
        subscription_data: { metadata: { detailerId: String(detailerId), type: 'pro' } },
        success_url: successUrl + (successUrl.includes('?') ? '&' : '?') + 'session_id={CHECKOUT_SESSION_ID}',
        cancel_url: cancelUrl,
      });
      return respond(200, { url: session.url });
    }

    if (action === 'verify') {
      if (!sessionId) return respond(400, { error: 'Missing sessionId' });
      const session = await stripe.checkout.sessions.retrieve(sessionId);
      const belongsToDetailer = session.metadata && String(session.metadata.detailerId) === String(detailerId);
      const paid = session.status === 'complete' && (session.payment_status === 'paid' || session.payment_status === 'no_payment_required');
      if (!belongsToDetailer || !paid) return respond(200, { pro: !!detailer.pro, verified: false });

      const { error: upErr } = await supabase
        .from('detailers')
        .update({ pro: true, pro_sub_id: session.subscription || null })
        .eq('id', detailerId);
      if (upErr) return respond(500, { error: 'Could not activate Pro: ' + upErr.message });
      return respond(200, { pro: true, verified: true });
    }

    return respond(400, { error: 'Unknown action' });
  } catch (err) {
    console.error('stripe-pro-subscribe error:', err);
    return respond(500, { error: err.message });
  }
};
