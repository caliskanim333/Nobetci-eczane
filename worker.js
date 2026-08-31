// ================= Nöbetçi Eczane - Cloudflare Worker =================
// Görevi: frontend'den gelen il/ilce isteğini alıp Nosyapi'nin
// "Nöbetçi Eczane API"sine iletmek. (https://www.nosyapi.com/api/nobetci-eczane)
// API_KEY (Nosyapi anahtarınız) ve APP_TOKEN (frontend'in gönderdiği basit
// istek doğrulama değeri) Cloudflare Dashboard > Settings > Variables
// bölümünde "Secret" olarak tanımlanmış olmalı: env.API_KEY, env.APP_TOKEN

const CACHE_TTL_SECONDS = 300;       // Aynı il/ilce için 5 dakika cache
const RATE_LIMIT_MAX = 30;           // IP başına dakikada izin verilen istek
const RATE_LIMIT_WINDOW_MS = 60_000; // 1 dakika

// Basit bellek-içi hız sınırlayıcı. Worker izole edilmiş (isolate) süreçler
// arasında paylaşılmadığı için mükemmel değildir, ama bot/aşırı istek
// senaryolarına karşı ucuz ve etkili bir ilk savunma katmanıdır.
const rateLimitStore = new Map();

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'content-type, x-app-token',
  };
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      ...corsHeaders(),
    },
  });
}

function isRateLimited(ip) {
  const now = Date.now();
  const entry = rateLimitStore.get(ip);

  if (!entry || now > entry.resetAt) {
    rateLimitStore.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return false;
  }

  entry.count += 1;
  if (entry.count > RATE_LIMIT_MAX) {
    return true;
  }
  return false;
}

// Store büyümesin diye arada bir eski kayıtları temizle.
function cleanupRateLimitStore() {
  const now = Date.now();
  for (const [ip, entry] of rateLimitStore) {
    if (now > entry.resetAt) {
      rateLimitStore.delete(ip);
    }
  }
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders() });
    }

    if (request.method !== 'GET') {
      return jsonResponse({ success: false, message: 'Sadece GET destekleniyor' }, 405);
    }

    // ---- 1) Basit istek doğrulama (gizli anahtar değil, bot filtresi) ----
    const appToken = request.headers.get('x-app-token');
    if (!appToken || appToken !== env.APP_TOKEN) {
      return jsonResponse({ success: false, message: 'Yetkisiz istek' }, 401);
    }

    // ---- 2) IP başına hız sınırı ----
    const ip = request.headers.get('cf-connecting-ip') || 'unknown';
    if (isRateLimited(ip)) {
      return jsonResponse(
        { success: false, message: 'Çok fazla istek gönderildi, lütfen biraz bekleyin.' },
        429
      );
    }
    ctx.waitUntil(Promise.resolve().then(cleanupRateLimitStore));

    // ---- 3) Parametreleri oku ----
    const url = new URL(request.url);
    const il = url.searchParams.get('il');
    const ilce = url.searchParams.get('ilce');

    if (!il) {
      return jsonResponse({ success: false, message: 'il parametresi zorunlu' }, 400);
    }

    // ---- 4) Cache kontrolü (Cloudflare Cache API) ----
    const cacheKey = new Request(url.toString(), request);
    const cache = caches.default;
    let response = await cache.match(cacheKey);
    if (response) {
      const cached = new Response(response.body, response);
      cached.headers.set('x-cache', 'HIT');
      return cached;
    }

    // ---- 5) Nosyapi isteği ----
    // Nosyapi "city"/"district" parametrelerini küçük harfli slug olarak
    // bekliyor (örn. "istanbul", "kadikoy"). Frontend Türkçe karakterleri
    // zaten ASCII'ye çeviriyor (normalizeTr); burada sadece küçük harfe
    // çevirip boşlukları temizliyoruz.
    const toSlug = (s) => (s || '').toLowerCase().replace(/\s+/g, '');

    const apiUrl = new URL('https://www.nosyapi.com/apiv2/service/pharmacies-on-duty');
    apiUrl.searchParams.set('city', toSlug(il));
    if (ilce) apiUrl.searchParams.set('district', toSlug(ilce));
    apiUrl.searchParams.set('apiKey', env.API_KEY);

    let apiRes;
    let nosyData;
    try {
      apiRes = await fetch(apiUrl.toString(), {
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${env.API_KEY}`,
        },
      });
      nosyData = await apiRes.json();
    } catch (err) {
      return jsonResponse(
        { success: false, message: 'Nosyapi isteği başarısız: ' + err.message },
        502
      );
    }

    // Nosyapi yanıt formatı: { status: "success", data: [...], ... }
    // Frontend ise CollectAPI-tarzı { success: true, result: [...] } bekliyor,
    // burada bu dönüşümü yapıyoruz ki frontend değişmesin.
    const isSuccess = apiRes.ok && nosyData && nosyData.status === 'success';
    const normalized = isSuccess
      ? { success: true, result: nosyData.data || [] }
      : { success: false, message: (nosyData && (nosyData.message || nosyData.messageTR)) || 'Nosyapi hata döndürdü' };

    response = new Response(JSON.stringify(normalized), {
      status: isSuccess ? 200 : apiRes.status,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'x-cache': 'MISS',
        'cache-control': `public, max-age=${CACHE_TTL_SECONDS}`,
        ...corsHeaders(),
      },
    });

    // Sadece başarılı yanıtları cache'le.
    if (isSuccess) {
      ctx.waitUntil(cache.put(cacheKey, response.clone()));
    }

    return response;
  },
};
