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
    // Aynı IP adresi 1 dakika içinde RATE_LIMIT_MAX'ten f
