export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Kendi Netlify sitenin adresiyle değiştir (https:// ile, sonunda / OLMADAN).
    const ALLOWED_ORIGIN = 'https://nobetci-eczane-takip.netlify.app';

    // CORS preflight desteği
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
          'Access-Control-Allow-Methods': 'GET, OPTIONS',
          'Access-Control-Allow-Headers': 'content-type, x-app-token'
        }
      });
    }

    // Basit paylaşılan token kontrolü. Bu "gerçek" bir kimlik doğrulama
    // değildir (frontend kodunda görünür) ama rastgele bot taramalarının
    // ve otomatik URL keşfinin büyük çoğunluğunu eler. env.APP_TOKEN
    // olarak Cloudflare'de secret şeklinde tanımlanmalı.
    const clientToken = request.headers.get('x-app-token');
    if (!env.APP_TOKEN || clientToken !== env.APP_TOKEN) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { 'content-type': 'application/json', 'Access-Control-Allow-Origin': ALLOWED_ORIGIN }
      });
    }

    // ================= IP BAŞINA HIZ SINIRI (RATE LIMIT) =================
    // Aynı IP adresi 1 dakika içinde RATE_LIMIT_MAX'ten fazla istek atarsa
    // reddediyoruz. Normal bir kullanıcı 1 dakikada bu kadar çok istek
    // atmaz; bunu aşan trafik bot/kötüye kullanım şüphesi taşır.
    const RATE_LIMIT_MAX = 20; // dakikada en fazla 20 istek
    const clientIp = request.headers.get('CF-Connecting-IP') || 'unknown';
    const minuteBucket = Math.floor(Date.now() / 60000); // her dakika değişen sayı
    const rlKey = `rl:${clientIp}:${minuteBucket}`;

    if (env.RATE_LIMIT) {
      const currentCountRaw = await env.RATE_LIMIT.get(rlKey);
      const currentCount = currentCountRaw ? parseInt(currentCountRaw, 10) : 0;

      if (currentCount >= RATE_LIMIT_MAX) {
        return new Response(JSON.stringify({ error: 'Too many requests, please slow down' }), {
          status: 429,
          headers: { 'content-type': 'application/json', 'Access-Control-Allow-Origin': ALLOWED_ORIGIN }
        });
      }

      // Sayacı 1 artırıp tekrar kaydediyoruz; 90 saniye sonra KV kendisi siliyor
      // (expirationTtl), yani her dakika için ayrı ayrı temizlik yapmamıza gerek yok.
      ctx.waitUntil(env.RATE_LIMIT.put(rlKey, String(currentCount + 1), { expirationTtl: 90 }));
    }

    const ilRaw = url.searchParams.get('il') || '';
    const ilceRaw = url.searchParams.get('ilce') || '';

    // Girdi doğrulama: sadece harf/boşluk, makul uzunluk. Bu, rastgele
    // çöp parametrelerle önbelleği "bypass" edip her seferinde gerçek
    // API'yi tetiklemeye çalışan kötüye kullanımı engeller.
    const validPattern = /^[A-Za-zÇçĞğİıÖöŞşÜü\s]{2,40}$/;
    if (!validPattern.test(ilRaw) || !validPattern.test(ilceRaw)) {
      return new Response(JSON.stringify({ error: 'Invalid il or ilce param' }), {
        status: 400,
        headers: { 'content-type': 'application/json', 'Access-Control-Allow-Origin': ALLOWED_ORIGIN }
      });
    }

    const il = ilRaw.trim();
    const ilce = ilceRaw.trim();

    // ================= ÖNBELLEKLEME =================
    // Nöbetçi eczane verisi günde bir kez değişir; sık sık taze veri
    // gerekmez. Aynı il/ilçe için gelen istekleri CACHE_TTL_SECONDS
    // boyunca Cloudflare'in edge cache'inden karşılıyoruz, böylece
    // NosyAPI/CollectAPI'ye giden gerçek istek sayısı ciddi şekilde azalır.
    const CACHE_TTL_SECONDS = 6 * 60 * 60; // 6 saat
    const cache = caches.default;
    // Cache anahtarını kendimiz kuruyoruz (query sırası/token farklılıklarından
    // etkilenmesin diye), GET isteği olarak.
    const cacheKeyUrl = new URL(request.url);
    cacheKeyUrl.search = `?il=${encodeURIComponent(il)}&ilce=${encodeURIComponent(ilce)}`;
    const cacheKey = new Request(cacheKeyUrl.toString(), { method: 'GET' });

    const cached = await cache.match(cacheKey);
    if (cached) {
      const cachedBody = await cached.text();
      return new Response(cachedBody, {
        status: cached.status,
        headers: {
          'content-type': 'application/json',
          'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
          'x-cache': 'HIT'
        }
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

    const response = new Response(body, {
      status: upstream.status,
      headers: {
        'content-type': 'application/json',
        'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
        'x-cache': 'MISS'
      }
    });

    // Sadece başarılı yanıtları önbelleğe al (hata yanıtlarını cache'lersek,
    // API geçici olarak hata verdiğinde bu hatayı 6 saat boyunca herkese
    // tekrar tekrar göstermiş oluruz).
    if (upstream.status === 200) {
      const toCache = new Response(body, {
        status: 200,
        headers: { 'content-type': 'application/json', 'Cache-Control': `max-age=${CACHE_TTL_SECONDS}` }
      });
      ctx.waitUntil(cache.put(cacheKey, toCache));
    }

    return response; } };
  }
};
