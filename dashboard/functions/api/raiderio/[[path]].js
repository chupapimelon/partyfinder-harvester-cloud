export async function onRequest(context) {
  const url = new URL(context.request.url);

  // Handle CORS preflight
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

  // Proxy /api/raiderio/* -> https://raider.io/api/* with CORS enabled
  const subPath = url.pathname.replace(/^\/api\/raiderio\/?/, '');
  const rioUrl = `https://raider.io/api/${subPath}${url.search}`;

  try {
    const res = await fetch(rioUrl, {
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
        'Accept': 'application/json',
      }
    });

    const body = await res.arrayBuffer();
    const headers = new Headers();
    headers.set('Content-Type', res.headers.get('Content-Type') || 'application/json');
    headers.set('Access-Control-Allow-Origin', '*');
    headers.set('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    headers.set('Access-Control-Allow-Headers', '*');
    headers.set('Cache-Control', 'public, max-age=60');

    return new Response(body, {
      status: res.status,
      headers
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 502,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      }
    });
  }
}
