// Shared authentication helper for the money/owner endpoints.
// Verifies the Supabase session JWT sent by the browser as
// `Authorization: Bearer <access_token>` and returns the authenticated
// user's id — or null if the token is missing/invalid/expired.
//
// This is what stops a stranger from POSTing a guessed integer id to move
// another detailer's money: every sensitive endpoint resolves the caller's
// real user id here, then checks it owns the detailer/job it's acting on.
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

async function authUserId(event) {
  const h = (event.headers && (event.headers.authorization || event.headers.Authorization)) || '';
  const token = h.replace(/^Bearer\s+/i, '').trim();
  if (!token) return null;
  try {
    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data || !data.user) return null;
    return data.user.id;
  } catch (e) {
    return null;
  }
}

// True when `userId` owns the detailer row `detailerId`.
async function ownsDetailer(detailerId, userId) {
  if (!detailerId || !userId) return false;
  const { data, error } = await supabase
    .from('detailers').select('user_id').eq('id', detailerId).single();
  return !error && data && data.user_id === userId;
}

const unauthorized = (corsHeaders) => ({
  statusCode: 401,
  headers: corsHeaders,
  body: JSON.stringify({ error: 'Please sign in again to continue.' }),
});

const forbidden = (corsHeaders) => ({
  statusCode: 403,
  headers: corsHeaders,
  body: JSON.stringify({ error: 'You don’t have access to that.' }),
});

module.exports = { authUserId, ownsDetailer, unauthorized, forbidden };
