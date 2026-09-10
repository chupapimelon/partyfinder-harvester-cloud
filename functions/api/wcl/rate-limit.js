export async function onRequest(context) {
  if (context.request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': '*',
      }
    });
  }

  let clientId = null;
  let clientSecret = null;

  if (context.request.method === 'POST') {
    try {
      const body = await context.request.json();
      clientId = body.clientId;
      clientSecret = body.clientSecret;
    } catch (e) {}
  }

  // Fallback to Supabase vault if not provided in body
  if (!clientId || !clientSecret) {
    try {
      const SUPABASE_URL = 'https://anvkqwbqgqcopsuhhene.supabase.co';
      const SUPABASE_ANON_KEY = 'sb_publishable_FdCOqHNEXexN-CgD9Pb9Ag_SLV86t_I';
      const sRes = await fetch(`${SUPABASE_URL}/rest/v1/app_secrets?select=key,value`, {
        headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` }
      });
      if (sRes.ok) {
        const secrets = await sRes.json();
        clientId = secrets.find(s => s.key === 'wcl_client_id')?.value;
        clientSecret = secrets.find(s => s.key === 'wcl_client_secret')?.value;
      }
    } catch (e) {}
  }

  if (!clientId || !clientSecret) {
    return new Response(JSON.stringify({ ok: false, error: 'WCL credentials not found' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  }

  try {
    const authString = btoa(`${clientId}:${clientSecret}`);
    const tokenRes = await fetch('https://www.warcraftlogs.com/oauth/token', {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${authString}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'PartyFinder-Harvester/2.0'
      },
      body: 'grant_type=client_credentials'
    });

    if (!tokenRes.ok) {
      const txt = await tokenRes.text();
      return new Response(JSON.stringify({ ok: false, error: `WCL OAuth Rejected (${tokenRes.status}): ${txt}` }), {
        status: tokenRes.status,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    }

    const tokenData = await tokenRes.json();
    const accessToken = tokenData.access_token;

    // Query GraphQL Rate Limit
    const gqlRes = await fetch('https://www.warcraftlogs.com/api/v2/client', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'User-Agent': 'PartyFinder-Harvester/2.0'
      },
      body: JSON.stringify({
        query: `{ rateLimitData { limitPerHour pointsSpentThisHour pointsResetIn } }`
      })
    });

    const gqlData = await gqlRes.json();
    const rl = gqlData.data?.rateLimitData || {};
    const limit = rl.limitPerHour || 3600;
    const spent = rl.pointsSpentThisHour || 0;
    const remaining = Math.max(0, limit - spent);
    const resetIn = rl.pointsResetIn || 3600;

    let tier = 'Standard (Free)';
    if (limit >= 18000) tier = 'Platinum (18,000 pts/hr)';
    else if (limit >= 9000) tier = 'Gold (9,000 pts/hr)';

    return new Response(JSON.stringify({
      ok: true,
      tier,
      limitPerHour: limit,
      pointsSpentThisHour: spent,
      pointsRemaining: remaining,
      pointsResetIn: resetIn
    }), {
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, error: err.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  }
}
