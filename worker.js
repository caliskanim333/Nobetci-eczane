export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // CORS preflight desteği
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, OPTIONS',
          'Access-Control-Allow-Headers': 'content-type'
        }
      });
    }

    const il = url.searchParams.get('il');
    const ilce = url.searchParams.get('ilce');

    if (!il || !ilce) {
      return new Response(JSON.stringify({ error: 'Missing il or ilce param' }), {
        status: 400,
        headers: { 'content-type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    }

    // ÖNEMLİ: Hedef URL burada, worker içinde, sabit host'a karşı oluşturuluyor.
    // Dışarıdan keyfi bir "url" parametresi kabul EDİLMİYOR — bu sayede worker
    // açık bir proxy olarak kötüye kullanılamaz; sadece CollectAPI'nin
    // dutyPharmacy endpoint'ine, sadece il/ilce parametreleriyle istek atabilir.
    const target = `https://api.collectapi.com/health/dutyPharmacy?il=${encodeURIComponent(il)}&ilce=${encodeURIComponent(ilce)}`;

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
        'content-type': 'app
