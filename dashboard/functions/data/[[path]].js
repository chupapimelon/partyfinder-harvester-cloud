export async function onRequest(context) {
  const url = new URL(context.request.url);

  if (context.request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, HEAD, POST, OPTIONS',
        'Access-Control-Allow-Headers': '*',
      }
    });
  }

  // Primary source for live database files (partyfinder_meta.json, PartyFinder_Data_Live.lua) is imongmama.online
  const isLiveMetaOrDb = url.pathname.includes('partyfinder_meta.json') || url.pathname.includes('PartyFinder_Data_Live.lua');
  const targetUrls = isLiveMetaOrDb
    ? [`https://imongmama.online${url.pathname}${url.search}`, `https://r2.imongmama.online${url.pathname}${url.search}`]
    : [`https://r2.imongmama.online${url.pathname}${url.search}`, `https://imongmama.online${url.pathname}${url.search}`];

  let lastErr = null;
  for (const targetUrl of targetUrls) {
    try {
      const res = await fetch(targetUrl, {
        method: context.request.method,
        headers: {
          'User-Agent': 'Cloudflare-Pages-Edge-Proxy',
        }
      });

      if (res.ok) {
        const body = await res.arrayBuffer();
        const headers = new Headers(res.headers);
        headers.set('Access-Control-Allow-Origin', '*');
        headers.set('Access-Control-Allow-Methods', 'GET, HEAD, POST, OPTIONS');
        headers.set('Access-Control-Allow-Headers', '*');
        headers.set('Cache-Control', 'public, max-age=60');

        return new Response(body, {
          status: res.status,
          statusText: res.statusText,
          headers: headers
        });
      }
    } catch (err) {
      lastErr = err;
    }
  }

  return new Response(JSON.stringify({ error: lastErr?.message || 'Upstream fetch failed' }), {
    status: 502,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*'
    }
  });
}
