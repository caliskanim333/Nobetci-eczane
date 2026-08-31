export default {
  async fetch(request, env) {
    // Tarayıcı, content-type: application/json header'ı gönderen isteklerden
    // önce bir OPTIONS (preflight) isteği atar. Bu isteği CollectAPI'ye
    // yönlendirmek yerine worker'ın kendisi burada yanıtlamalı.
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization',
          'Access-Control-Max-Age': '86400'
        }
      });
    }

    const url = new URL(request.url);
    const target = url.searchParams.get('url');

    if (!target) {
      return new Response('Missing url param', {
        status: 400,
        headers: { 'Access-Control-Allow-Origin': '*' }
      });
    }

    try {
      const upstream = await fetch(target, {
        headers: {
          'authorization': `apikey ${env.API_KEY}`,
          'content-type': 'application/json'
        }
      });

      const body = await upstream.text();

      return new Response(body, {
        status: upstream.status,
        headers: {
          'content-type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        }
      });
    } catch (err) {
      return new Response(JSON.stringify({ error: 'upstream fetch failed', detail: String(err) }), {
        status: 502,
        headers: {
          'content-type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        }
      });
    }
  }
};
