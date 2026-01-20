// Simple Cloudflare Worker CORS proxy for AniList (GraphQL), ANN RSS and SubsPlease.
// - Maps:
//    /anilist        -> https://graphql.anilist.co           (POST/GET GraphQL queries)
//    /ann            -> https://www.animenewsnetwork.com/all/rss.xml
//    /subsplease/*   -> https://subsplease.org/<rest>        (HTML)
// - Adds permissive CORS headers (adjust Access-Control-Allow-Origin for production)
//
// Usage examples from the client:
//   POST https://<worker-domain>/anilist   (body & headers forwarded)
//   GET  https://<worker-domain>/ann
//   GET  https://<worker-domain>/subsplease/  (or any path after /subsplease/)
addEventListener('fetch', event => {
  event.respondWith(handle(event.request));
});

const routes = {
  anilist: 'https://graphql.anilist.co',
  ann: 'https://www.animenewsnetwork.com/all/rss.xml',
  subsplease: 'https://subsplease.org'
};

// change this to restrict origins if you don't want "*" in production
const CORS_ORIGIN = '*';

async function handle(request) {
  try {
    const url = new URL(request.url);
    const parts = url.pathname.replace(/^\/+/, '').split('/');
    const route = parts[0] || '';

    // Handle preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    if (route === 'anilist') {
      // Forward to AniList GraphQL endpoint
      const target = routes.anilist;
      const init = makeForwardInit(request, target);
      const resp = await fetch(target, init);
      return buildResponseWithCors(resp);
    }

    if (route === 'ann') {
      const target = routes.ann;
      const resp = await fetch(target, { method: 'GET', headers: { 'Accept': 'application/rss+xml,application/xml,text/xml' } });
      return buildResponseWithCors(resp);
    }

    if (route === 'subsplease') {
      // recompose path after /subsplease
      const rest = parts.slice(1).join('/');
      const target = rest ? `${routes.subsplease}/${rest}` : routes.subsplease;
      // preserve query string
      const targetUrl = new URL(target);
      targetUrl.search = url.search;
      const resp = await fetch(targetUrl.toString(), { method: 'GET', headers: { 'Accept': 'text/html' } });
      return buildResponseWithCors(resp);
    }

    // If no route matched, return helpful JSON
    return new Response(JSON.stringify({
      ok: false,
      message: 'Proxy worker running. Routes: /anilist, /ann, /subsplease/*'
    }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json;charset=UTF-8',
        ...corsHeaders()
      }
    });

  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json;charset=UTF-8', ...corsHeaders() }
    });
  }
}

function makeForwardInit(request, target) {
  const headers = new Headers(request.headers);
  // remove host header to avoid conflicts
  headers.delete('host');

  // Ensure we accept JSON for AniList. Clients typically set content-type.
  if (!headers.has('Accept')) headers.set('Accept', 'application/json');

  const init = {
    method: request.method,
    headers,
    // For GET and HEAD, body must be undefined
    body: ['GET', 'HEAD'].includes(request.method) ? undefined : request.body,
    redirect: 'follow'
  };
  return init;
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': CORS_ORIGIN,
    'Access-Control-Allow-Methods': 'GET,HEAD,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400'
  };
}

async function buildResponseWithCors(resp) {
  // Clone response and append CORS headers
  const headers = new Headers(resp.headers);
  const ch = corsHeaders();
  Object.keys(ch).forEach(k => headers.set(k, ch[k]));

  // Respect content-type; stream body
  const body = await resp.arrayBuffer();
  return new Response(body, {
    status: resp.status,
    statusText: resp.statusText,
    headers
  });
}
