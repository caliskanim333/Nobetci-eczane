export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const target = url.searchParams.get('url');

    if (!target) {
      return new Response('Missing url param', { status: 400 });
    }

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
  }
};
