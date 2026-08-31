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
 
    // NosyAPI slug bekliyor (küçük harf, Türkçe karakter yok): "İstanbul" -> "istanbul",
    // "Kadıköy" -> "kadikoy". Türkçe harfleri sadeleştirip slug'a çeviriyoruz.
    const toSlug = (s) => s
      .toLocaleLowerCase('tr')
      .replace(/ç/g, 'c').replace(/ğ/g, 'g').replace(/ı/g, 'i')
      .replace(/ö/g, 'o').replace(/ş/g, 's').replace(/ü/g, 'u')
      .replace(/[^a-z0-9]+/g, '');
 
    const citySlug = toSlug(il);
    const districtSlug = toSlug(ilce);
 
    // ÖNEMLİ: Hedef URL burada, worker içinde, sabit host'a karşı oluşturuluyor.
    // Dışarıdan keyfi bir "url" parametresi kabul EDİLMİYOR — bu sayede worker
    // açık bir proxy olarak kötüye kullanılamaz; sadece NosyAPI'nin
    // pharmacies-on-duty endpoint'ine, sadece city/district parametreleriyle istek atabilir.
    const target = `https://www.nosyapi.com/apiv2/service/pharmacies-on-duty?city=${encodeURIComponent(citySlug)}&district=${encodeURIComponent(districtSlug)}`;
 
    const upstream = await fetch(target, {
      headers: {
        'Authorization': `Bearer ${env.API_KEY}`,
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
 
