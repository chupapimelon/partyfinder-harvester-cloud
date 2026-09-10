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

  const r2Url = `https://r2.imongmama.online${url.pathname}${url.search}`;

  try {
    const res = await fetch(r2Url, {
      method: context.request.method,
      headers: {
        'User-Agent': 'Cloudflare-Pages-Edge-Proxy',
      }
    });

    const body = await res.arrayBuffer();
    const headers = new Headers(res.headers);
    headers.set('Access-Control-Allow-Origin', '*');
    headers.set('Access-Control-Allow-Methods', 'GET, HEAD, POST, OPTIONS');
    headers.set('Access-Control-Allow-Headers', '*');
    headers.set('Cache-Control', 'public, max-age=300');

    return new Response(body, {
      status: res.status,
      statusText: res.statusText,
      headers: headers
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 502,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      }
    });
  }
}
