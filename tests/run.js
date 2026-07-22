const path = require('path');
const Module = require('module');

// ---- mock state, reset per scenario ----
let state = {};
function reset(job) {
  state = {
    job,
    updates: [],
    transfers: [],
    piCalls: [],
    throwOnTransfer: false,
  };
}

// ---- fake stripe ----
const fakeStripe = () => ({
  paymentIntents: {
    retrieve: async (id) => { state.piCalls.push(id); return { latest_charge: id ? 'ch_' + id : null }; },
  },
  transfers: {
    create: async (args, opts) => {
      state.transfers.push({ args, idem: opts && opts.idempotencyKey });
      return { id: 'tr_' + state.transfers.length };
    },
  },
  checkout: { sessions: { create: async (a) => ({ url: 'https://cs/' + (a.metadata.payment_type) }) } },
  webhooks: { constructEvent: (b) => JSON.parse(b) },
});
// stripe module is called as stripe(key) -> returns client
function stripeFactory() { return fakeStripe(); }

// ---- fake supabase ----
function makeQuery(table) {
  const q = {
    _table: table,
    select() { return q; },
    eq() { return q; },
    async single() { return { data: state.job ? { ...state.job, detailers: { stripe_account_id: state.job._acct } } : null, error: state.job ? null : { message: 'no row' } }; },
    update(u) { q._update = u; return { eq: async () => { state.updates.push(u); return { error: state.dbWriteError ? { message: 'write fail' } : null }; } }; },
  };
  return q;
}
const fakeSupabase = { createClient: () => ({ from: (t) => makeQuery(t) }) };

// ---- intercept require ----
const realLoad = Module._load;
Module._load = function (req, parent, isMain) {
  if (req === 'stripe') return stripeFactory;
  if (req === '@supabase/supabase-js') return fakeSupabase;
  return realLoad.apply(this, arguments);
};

process.env.STRIPE_SECRET_KEY = 'sk_test';
process.env.SUPABASE_URL = 'http://x'; process.env.SUPABASE_SERVICE_KEY = 'k';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec';

const FN = path.join(__dirname, '..', 'netlify', 'functions');
function fresh(p) { delete require.cache[require.resolve(p)]; return require(p); }

function ev(body, extra) { return Object.assign({ httpMethod: 'POST', body: JSON.stringify(body), headers: {} }, extra || {}); }
let pass = 0, fail = 0;
function ok(cond, msg) { (cond ? (pass++, console.log('  ✓ ' + msg)) : (fail++, console.log('  ✗ FAIL: ' + msg))); }

(async () => {
  const complete = fresh(FN + '/stripe-complete-job.js');

  console.log('\n[complete-job] already transferred → no new transfers');
  reset({ id: 5, price: 220, deposit_amount: 55, deposit_charge_id: 'pi_d', remainder_charge_id: 'pi_r', payment_status: 'transferred', _acct: 'acct_1' });
  let r = await complete.handler(ev({ jobId: 5 }));
  ok(r.statusCode === 200 && JSON.parse(r.body).alreadyCompleted === true, 'returns alreadyCompleted');
  ok(state.transfers.length === 0, 'zero transfers created');

  console.log('\n[complete-job] balance still owed → refuse');
  reset({ id: 6, price: 220, deposit_amount: 55, deposit_charge_id: 'pi_d', remainder_charge_id: null, payment_status: 'deposit_paid', _acct: 'acct_1' });
  r = await complete.handler(ev({ jobId: 6 }));
  ok(r.statusCode === 400 && /still owes/.test(JSON.parse(r.body).error), 'refuses with balance-owed error');
  ok(state.transfers.length === 0, 'zero transfers');

  console.log('\n[complete-job] no payment collected → refuse');
  reset({ id: 7, price: 220, deposit_amount: 220, deposit_charge_id: null, remainder_charge_id: null, payment_status: 'fully_paid', _acct: 'acct_1' });
  r = await complete.handler(ev({ jobId: 7 }));
  ok(r.statusCode === 400 && /No payment/.test(JSON.parse(r.body).error), 'refuses when nothing collected');

  console.log('\n[complete-job] no payout account → refuse');
  reset({ id: 8, price: 100, deposit_amount: 100, deposit_charge_id: 'pi_d', remainder_charge_id: null, payment_status: 'fully_paid', _acct: null });
  r = await complete.handler(ev({ jobId: 8 }));
  ok(r.statusCode === 400 && /connected payouts/.test(JSON.parse(r.body).error), 'refuses without connected account');

  console.log('\n[complete-job] happy path deposit+remainder → 2 transfers, correct amounts + idem keys');
  reset({ id: 9, price: 220, deposit_amount: 55, deposit_charge_id: 'pi_d', remainder_charge_id: 'pi_r', payment_status: 'fully_paid', _acct: 'acct_1' });
  r = await complete.handler(ev({ jobId: 9 }));
  ok(r.statusCode === 200, 'returns 200');
  ok(state.transfers.length === 2, 'two transfers');
  ok(state.transfers[0].args.amount === Math.round(55*100*0.9), 'deposit transfer = 90% of $55 = ' + Math.round(55*100*0.9));
  ok(state.transfers[1].args.amount === Math.round((220-55)*100*0.9), 'remainder transfer = 90% of $165 = ' + Math.round(165*100*0.9));
  ok(state.transfers[0].idem === 'transfer_job_9_deposit' && state.transfers[1].idem === 'transfer_job_9_remainder', 'stable idempotency keys present');
  ok(state.updates.length === 1 && state.updates[0].payment_status === 'transferred', 'marks job transferred');

  // ---- webhook ----
  const wh = fresh(FN + '/stripe-webhook.js');
  console.log('\n[webhook] deposit recorded forward');
  reset({ id: 10, payment_status: 'pending_deposit' });
  r = await wh.handler({ httpMethod:'POST', headers:{'stripe-signature':'x'}, body: JSON.stringify({ type:'checkout.session.completed', data:{object:{ metadata:{job_id:'10', payment_type:'deposit'}, amount_total: 5500, payment_intent:'pi_d' }}}) });
  ok(r.statusCode === 200 && state.updates.length === 1 && state.updates[0].payment_status === 'deposit_paid' && state.updates[0].deposit_amount === 55, 'deposit recorded ($55)');

  console.log('\n[webhook] late deposit event does NOT downgrade a transferred job');
  reset({ id: 11, payment_status: 'transferred' });
  r = await wh.handler({ httpMethod:'POST', headers:{'stripe-signature':'x'}, body: JSON.stringify({ type:'checkout.session.completed', data:{object:{ metadata:{job_id:'11', payment_type:'deposit'}, amount_total: 5500, payment_intent:'pi_d' }}}) });
  ok(r.statusCode === 200 && state.updates.length === 0, 'no update on already-transferred job');

  console.log('\n[webhook] DB write failure → 500 so Stripe retries');
  reset({ id: 12, payment_status: 'pending_deposit' }); state.dbWriteError = true;
  r = await wh.handler({ httpMethod:'POST', headers:{'stripe-signature':'x'}, body: JSON.stringify({ type:'checkout.session.completed', data:{object:{ metadata:{job_id:'12', payment_type:'deposit'}, amount_total: 5500, payment_intent:'pi_d' }}}) });
  ok(r.statusCode === 500, 'returns 500 on write failure');

  // ---- checkout ----
  const co = fresh(FN + '/stripe-checkout.js');
  console.log('\n[checkout] remainder blocked when fully paid');
  reset({ id: 13, price: 220, deposit_amount: 55, payment_status: 'fully_paid' });
  r = await co.handler(ev({ jobId:13, type:'remainder', successUrl:'s', cancelUrl:'c' }));
  ok(r.statusCode === 400 && /already paid in full/.test(JSON.parse(r.body).error), 'blocks double remainder charge');

  console.log('\n[checkout] deposit happy path creates session');
  reset({ id: 14, price: 220, deposit_amount: 0, payment_status: null });
  r = await co.handler(ev({ jobId:14, type:'deposit', successUrl:'s', cancelUrl:'c' }));
  ok(r.statusCode === 200 && /cs\//.test(JSON.parse(r.body).url), 'deposit session created');

  console.log('\n============================');
  console.log(`RESULT: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
