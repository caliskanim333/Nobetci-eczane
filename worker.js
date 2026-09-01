// ================= Nöbetçi Eczane - Cloudflare Worker =================
// Görevi: frontend'den gelen il/ilce isteğini alıp Nosyapi'nin
// "Nöbetçi Eczane API"sine iletmek. (https://www.nosyapi.com/api/nobetci-eczane)
//
// Cloudflare Dashboard > Settings > Variables and Secrets bölümünde
// tanımlanmış olması gerekenler:
//   - API_KEY       (Secret)  -> Nosyapi anahtarınız
//   - APP_TOKEN     (Secret)  -> frontend'in gönderdiği basit istek doğrulama değeri
//   - ALLOWED_ORIGIN (Variable, secret olmasına gerek yok) ->
//       izin verilen origin(ler). Birden fazlaysa virgülle ayırın, örn:
//       "https://nobetci-eczane-takip.netlify.app,http://localhost:8888"
//       NOT: Sonunda "/" OLMAMALI — Origin header'ı asla path/slash içermez.

const CACHE_TTL_SECONDS = 300;       // Aynı il/ilce için 5 dakika cache
const RATE_LIMIT_MAX = 30;           // IP başına dakikada izin verilen istek
const RATE_LIMIT_WINDOW_MS = 60_000; // 1 dakika

const rateLimitStore = new Map();

function getAllowedOrigins(env) {
  return (env.ALLOWED_ORIGIN || '')
    .split(',')
    .map((s) => s.trim().replace(/\/$/, ''))
    .filter(Boolean);
}

function corsHeaders(origin) {
  const headers = {
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'content-type, x-app-token',
    'Vary': 'Origin',
  };
  if (origin) headers['Access-Control-Allow-Origin'] = origin;
  return headers;
}

function jsonResponse(body, status, origin) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      ...corsHeaders(origin),
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
  if (entry.count > RATE_LIMIT_MAX) return true;
  return false;
}

function cleanupRateLimitStore() {
  const now = Date.now();
  for (const [ip, entry] of rateLimitStore) {
    if (now > entry.resetAt) rateLimitStore.delete(ip);
  }
}

export default {
  async fetch(request, env, ctx) {
    const requestOrigin = (request.headers.get('origin') || '').replace(/\/$/, '');
    const allowedOrigins = getAllowedOrigins(env);
    const originAllowed = requestOrigin && allowedOrigins.includes(requestOrigin);
    const echoOrigin = originAllowed ? requestOrigin : null;

    const debugUrl = new URL(request.url);

    // ---- GEÇİCİ DEBUG 1: origin teşhisi ----
    if (debugUrl.searchParams.get('debug') === '1') {
      return new Response(JSON.stringify({
        receivedOrigin: request.headers.get('origin'),
        normalizedOrigin: requestOrigin,
        allowedOrigins: allowedOrigins,
        match: originAllowed,
        method: request.method
      }, null, 2), {
        headers: { 'content-type': 'application/json; charset=utf-8' }
      });
    }

    // ---- GEÇİCİ DEBUG 2: Balıkesir ilçe slug listesi (kredi harcamaz) ----
    if (debugUrl.searchParams.get('debug') === '2') {
      const citiesUrl = new URL('https://www.nosyapi.com/apiv2/service/pharmacies-on-duty/cities');
      citiesUrl.searchParams.set('city', 'balikesir');
      citiesUrl.searchParams.set('apiKey', env.API_KEY);
      const citiesRes = await fetch(citiesUrl.toString());
      const citiesData = await citiesRes.json();
      return new Response(JSON.stringify(citiesData, null, 2), {
        headers: { 'content-type': 'application/json; charset=utf-8' }
      });
    }
    // ---- /GEÇİCİ DEBUG ----

    if (request.method === 'OPTIONS') {
      if (!originAllowed) {
        return new Response(null, { status: 403 });
      }
      return new Response(null, { headers: corsHeaders(echoOrigin) });
    }

    if (request.method !== 'GET') {
      return jsonResponse({ success: false, message: 'Sadece GET destekleniyor' }, 405, echoOrigin);
    }

    if (!originAllowed) {
      return jsonResponse({ success: false, message: 'Yetkisiz origin' }, 403, null);
    }

    const appToken = request.headers.get('x-app-token');
    if (!appToken || appToken !== env.APP_TOKEN) {
      return jsonResponse({ success: false, message: 'Yetkisiz istek' }, 401, echoOrigin);
    }

    const ip = request.headers.get('cf-connecting-ip') || 'unknown';
    if (isRateLimited(ip)) {
      return jsonResponse(
        { success: false, message: 'Çok fazla istek gönderildi, lütfen biraz bekleyin.' },
        429,
        echoOrigin
      );
    }
    ctx.waitUntil(Promise.resolve().then(cleanupRateLimitStore));

    const url = new URL(request.url);
    const il = url.searchParams.get('il');
    const ilce = url.searchParams.get('ilce');

    if (!il) {
      return jsonResponse({ success: false, message: 'il parametresi zorunlu' }, 400, echoOrigin);
    }

    const cacheKey = new Request(url.toString(), request);
    const cache = caches.default;
    let response = await cache.match(cacheKey);
    if (response) {
      const cached = new Response(response.body, response);
      cached.headers.set('x-cache', 'HIT');
      cached.headers.set('Access-Control-Allow-Origin', echoOrigin);
      return cached;
    }

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
        502,
        echoOrigin
      );
    }

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
        ...corsHeaders(echoOrigin),
      },
    });

    if (isSuccess) {
      ctx.waitUntil(cache.put(cacheKey, response.clone()));
    }

    return response;
  },
};
