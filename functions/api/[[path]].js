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
  if (url.pathname.startsWith('/api/raiderio')) {
    const subPath = url.pathname.replace(/^\/api\/raiderio\/?/, '');
    const rioUrl = `https://raider.io/api/${subPath}${url.search}`;
    try {
      let res;
      for (let attempt = 1; attempt <= 2; attempt++) {
        res = await fetch(rioUrl, {
          method: 'GET',
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
            'Accept': 'application/json',
          }
        });
        if (res.ok || res.status < 500) break;
        if (attempt < 2) await new Promise(r => setTimeout(r, 800));
      }
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

  // Rewrite /api/harvest/status -> /api/status.json
  let targetPath = url.pathname;
  if (targetPath.startsWith('/api/harvest/status')) {
    targetPath = '/api/status.json';
  } else if (targetPath.startsWith('/api/harvest/players')) {
    const limit = parseInt(url.searchParams.get('limit') || '50', 10);
    const search = url.searchParams.get('search');
    if (limit >= 1000 || url.searchParams.get('all') === 'true') {
      targetPath = '/data/rio_players_us.json';
    } else if (search && search.length > 0) {
      const char = search[0].toLowerCase();
      targetPath = `/api/us/search_${char}.json`;
    } else {
      const page = url.searchParams.get('page') || '1';
      targetPath = `/api/us/page_${String(page).padStart(4, '0')}.json`;
    }
  }

  const r2Url = `https://r2.imongmama.online${targetPath}${url.search}`;

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
    if (targetPath.includes('status.json') || targetPath.includes('status')) {
      headers.set('Cache-Control', 'no-store, no-cache, must-revalidate');
    } else {
      headers.set('Cache-Control', 'public, max-age=60');
    }

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
