// Google reviews for a detailer's storefront, via the official Places API (New).
// DORMANT until GOOGLE_MAPS_API_KEY is set in Netlify env — returns {skipped:true} until then.
//
// Flow: POST {detailerId}
//   1. If cached in detailers row and fresh (<7 days) -> return cache (zero API cost).
//   2. Resolve the detailer's Google place_id once (Text Search biased to their location),
//      cache it in detailers.google_place_id.
//   3. Fetch rating + userRatingCount + reviews (Place Details), cache in the row, return.
// Google's terms require attribution when displaying this data — the frontend shows
// "Reviews from Google" and each review's author name.
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const KEY = process.env.GOOGLE_MAPS_API_KEY;
const CACHE_DAYS = 7;

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
    const { detailerId } = JSON.parse(event.body || '{}');
    if (!detailerId) return respond(400, { error: 'Missing detailerId' });

    if (!KEY) return respond(200, { skipped: true, reason: 'GOOGLE_MAPS_API_KEY not set' });

    const { data: d, error } = await supabase
      .from('detailers')
      .select('id, name, service_area, latitude, longitude, google_place_id, google_rating, google_reviews_count, google_reviews, google_reviews_updated')
      .eq('id', detailerId)
      .single();
    if (error || !d) return respond(404, { error: 'Detailer not found' });

    // Fresh cache -> serve it without touching Google (keeps API cost ~zero).
    if (d.google_reviews_updated) {
      const ageMs = Date.now() - new Date(d.google_reviews_updated).getTime();
      if (ageMs < CACHE_DAYS * 24 * 3600 * 1000 && d.google_rating != null) {
        return respond(200, {
          cached: true,
          rating: d.google_rating,
          count: d.google_reviews_count,
          reviews: d.google_reviews || [],
        });
      }
    }

    // Resolve place_id once (Text Search, biased to the detailer's own coordinates).
    let placeId = d.google_place_id;
    if (!placeId) {
      const searchBody = {
        textQuery: `${d.name} ${d.service_area || 'auto detailing'}`,
        maxResultCount: 1,
      };
      if (d.latitude != null && d.longitude != null) {
        searchBody.locationBias = {
          circle: { center: { latitude: d.latitude, longitude: d.longitude }, radius: 30000 },
        };
      }
      const sRes = await fetch('https://places.googleapis.com/v1/places:searchText', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': KEY,
          'X-Goog-FieldMask': 'places.id,places.displayName',
        },
        body: JSON.stringify(searchBody),
      });
      if (!sRes.ok) throw new Error(`Places search ${sRes.status}: ${(await sRes.text()).slice(0, 200)}`);
      const sData = await sRes.json();
      placeId = sData.places && sData.places[0] && sData.places[0].id;
      if (!placeId) {
        // Not found on Google — cache the miss so we don't re-search every open.
        await supabase.from('detailers').update({ google_reviews_updated: new Date().toISOString() }).eq('id', d.id);
        return respond(200, { rating: null, count: 0, reviews: [], notFound: true });
      }
      await supabase.from('detailers').update({ google_place_id: placeId }).eq('id', d.id);
    }

    // Fetch rating + reviews (Google returns up to 5 reviews).
    const pRes = await fetch(`https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}`, {
      headers: {
        'X-Goog-Api-Key': KEY,
        'X-Goog-FieldMask': 'rating,userRatingCount,reviews',
      },
    });
    if (!pRes.ok) throw new Error(`Place details ${pRes.status}: ${(await pRes.text()).slice(0, 200)}`);
    const p = await pRes.json();

    const reviews = (p.reviews || []).map((r) => ({
      author: (r.authorAttribution && r.authorAttribution.displayName) || 'Google user',
      rating: r.rating || null,
      text: (r.text && r.text.text) ? String(r.text.text).slice(0, 600) : '',
      when: r.relativePublishTimeDescription || '',
    }));

    await supabase.from('detailers').update({
      google_rating: p.rating ?? null,
      google_reviews_count: p.userRatingCount ?? 0,
      google_reviews: reviews,
      google_reviews_updated: new Date().toISOString(),
    }).eq('id', d.id);

    return respond(200, { rating: p.rating ?? null, count: p.userRatingCount ?? 0, reviews });
  } catch (err) {
    console.error('google-reviews error:', err);
    // Reviews are enrichment — never break the storefront over them.
    return respond(200, { rating: null, count: 0, reviews: [], error: true });
  }
};
