// netlify/functions/notify-booking.js
// Sends booking notifications (detailer + customer) and fleet-inquiry alerts (owner).
// DORMANT until RESEND_API_KEY is set in Netlify env — until then it no-ops gracefully
// (returns 200 {skipped:true}) so no flow is ever blocked by notifications.
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const RESEND_API_KEY = process.env.RESEND_API_KEY;               // <-- set in Netlify to activate
const FROM = process.env.NOTIFY_FROM || 'DetailRadius <onboarding@resend.dev>'; // replace w/ verified domain
const SITE_URL = process.env.SITE_URL || 'https://serene-cupcake-78a254.netlify.app';
const OWNER_EMAIL = process.env.OWNER_EMAIL || 'ashtons.autodetail4@gmail.com';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const esc = (s) => String(s == null ? '' : s).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));

async function sendEmail(to, subject, html) {
  if (!to) return;
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: FROM, to, subject, html }),
  });
  if (!res.ok) throw new Error(`Resend ${res.status}: ${await res.text()}`);
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: corsHeaders, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: corsHeaders, body: JSON.stringify({ error: 'Method not allowed' }) };
  }
  try {
    const body = JSON.parse(event.body || '{}');

    // Dormant until a provider key is configured — never block the calling flow.
    if (!RESEND_API_KEY) {
      return { statusCode: 200, headers: corsHeaders, body: JSON.stringify({ skipped: true, reason: 'RESEND_API_KEY not set' }) };
    }

    // ---- Fleet/B2B inquiry alert → owner ----
    if (body.type === 'fleet') {
      await sendEmail(OWNER_EMAIL,
        `🚚 Fleet inquiry — ${body.company || 'Unknown company'} (${body.fleetSize || '?'})`,
        `<h2>New fleet inquiry</h2>
         <ul>
           <li><strong>Company:</strong> ${esc(body.company)}</li>
           <li><strong>Email:</strong> ${esc(body.email)}</li>
           <li><strong>Fleet size:</strong> ${esc(body.fleetSize)}</li>
           <li><strong>City:</strong> ${esc(body.city)}</li>
           <li><strong>Message:</strong> ${esc(body.message)}</li>
         </ul>
         <p>Reply same-day — fleet contracts are the big fish. Full details in the Owner tab.</p>`);
      return { statusCode: 200, headers: corsHeaders, body: JSON.stringify({ sent: true }) };
    }

    // ---- Booking notification (default) ----
    const jobId = body.jobId;
    if (!jobId) return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: 'Missing jobId' }) };

    const { data: job, error } = await supabase.from('jobs').select('*').eq('id', jobId).single();
    if (error || !job) return { statusCode: 404, headers: corsHeaders, body: JSON.stringify({ error: 'Job not found' }) };

    // Look up the detailer + their owner's email (auth.users via user_id)
    let detailerEmail = null, detailerName = 'your detailer';
    if (job.detailer_id) {
      const { data: det } = await supabase.from('detailers').select('name,user_id').eq('id', job.detailer_id).single();
      if (det) {
        detailerName = det.name || detailerName;
        if (det.user_id) {
          const { data: u } = await supabase.auth.admin.getUserById(det.user_id);
          detailerEmail = u?.user?.email || null;
        }
      }
    }

    const summary = `
      <ul>
        <li><strong>Service:</strong> ${esc(job.service)}</li>
        <li><strong>Vehicle:</strong> ${esc(job.vehicle)}</li>
        <li><strong>Date:</strong> ${esc(job.date)} ${esc(job.requested_time)}</li>
        <li><strong>Location:</strong> ${esc(job.service_location_type)} ${esc(job.service_address)}</li>
        <li><strong>Price:</strong> $${job.price ?? ''}</li>
        <li><strong>Customer:</strong> ${esc(job.customer)} (${esc(job.customer_email) || 'no email'})</li>
        ${job.referral_code ? `<li><strong>🎁 Referral code:</strong> ${esc(job.referral_code)} — honor $10 off the final balance</li>` : ''}
      </ul>`;

    // Notify detailer
    await sendEmail(detailerEmail,
      `New booking request — ${job.service || 'Detail'}`,
      `<h2>New booking request</h2><p>You have a new request on DetailRadius.</p>${summary}
       <p><a href="${SITE_URL}">Open DetailRadius</a></p>`);

    // Confirm to customer
    await sendEmail(job.customer_email,
      `Your DetailRadius booking request`,
      `<h2>Booking received ✅</h2><p>${esc(detailerName)} will confirm shortly.</p>${summary}`);

    return { statusCode: 200, headers: corsHeaders, body: JSON.stringify({ sent: true, detailerEmailed: !!detailerEmail }) };
  } catch (err) {
    console.error('notify-booking error:', err);
    // Never surface raw errors to the client; notifications are best-effort.
    return { statusCode: 200, headers: corsHeaders, body: JSON.stringify({ sent: false }) };
  }
};
