export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    let targetUrl = url.searchParams.get("url");

    if (!targetUrl) {
      return new Response(
        JSON.stringify({ error: "Lütfen '?url=' parametresi ile bir YouTube linki gönderin." }),
        { status: 400, headers: { "Content-Type": "application/json; charset=utf-8" } }
      );
    }

    try {
      // 1. URL'yi Normalize Et ve Video ID'yi Çıkar
      let videoId = extractVideoId(targetUrl);

      const baseHeaders = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36",
        "Accept-Language": "en-US,en;q=0.9"
      };

      if (!videoId) {
        const pageRes = await fetch(targetUrl, { headers: baseHeaders, redirect: "follow" });
        const html = await pageRes.text();
        videoId = extractVideoIdFromHtml(html) || extractVideoId(pageRes.url);
      }

      if (!videoId) {
        throw new Error("YouTube Video ID veya aktif canlı yayın bulunamadı.");
      }

      // 2. CACHE API KONTROLÜ
      // Her video ID için özel bir cache URL'si simüle ediyoruz
      const cacheUrl = `https://youtube-cache-internal/stream/${videoId}`;
      const cacheKey = new Request(cacheUrl, { method: "GET" });
      const cache = caches.default;

      let cachedResponse = await cache.match(cacheKey);
      if (cachedResponse) {
        const cachedData = await cachedResponse.json();
        
        if (cachedData.hls_manifest_url) {
          return Response.redirect(cachedData.hls_manifest_url, 302);
        }

        return new Response(JSON.stringify({ ...cachedData, source: "edge-cache" }, null, 2), {
          status: 200,
          headers: { "Content-Type": "application/json; charset=utf-8" }
        });
      }

      // 3. Innertube Player API Çağrısı (Önbellekte yoksa YouTube'a sor)
      const apiResult = await callInnertubePlayer(videoId, baseHeaders);

      // 4. Yeni Sonucu Cache API'ye Kaydet (2 Saat / 7200 Saniye)
      const responseToCache = new Response(JSON.stringify(apiResult), {
        status: 200,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "public, max-age=7200" // 2 saat edge önbellek süresi
        }
      });

      // Arka planda önbelleğe yazma işlemini gerçekleştir
      ctx.waitUntil(cache.put(cacheKey, responseToCache));

      if (apiResult.hls_manifest_url) {
        return Response.redirect(apiResult.hls_manifest_url, 302);
      }

      return new Response(JSON.stringify({ ...apiResult, source: "live-api" }, null, 2), {
        status: 200,
        headers: { "Content-Type": "application/json; charset=utf-8" }
      });

    } catch (error) {
      return new Response(JSON.stringify({ error: error.message }), {
        status: 500,
        headers: { "Content-Type": "application/json; charset=utf-8" }
      });
    }
  }
};

function extractVideoId(urlStr) {
  try {
    const patterns = [
      /(?:v\/|live\/|watch\?(?:.*&)?v=)([\w-]{11})/,
      /youtu\.be\/([\w-]{11})/,
      /embed\/([\w-]{11})/,
      /@[\w-]+\/live/
    ];
    for (const pattern of patterns) {
      const match = urlStr.match(pattern);
      if (match && match[1]) return match[1];
    }
  } catch (e) {}
  return null;
}

function extractVideoIdFromHtml(html) {
  const matchId = html.match(/"videoId"\s*:\s*"([\w-]{11})"/);
  if (matchId) return matchId[1];
  const matchProp = html.match(/itemprop="videoId" content="([\w-]{11})"/);
  if (matchProp) return matchProp[1];
  return null;
}

async function callInnertubePlayer(videoId, headers) {
  const apiKey = "AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8";
  const apiUrl = `https://www.youtube.com/youtubei/v1/player?key=${apiKey}`;
  
  const payload = {
    videoId: videoId,
    contentCheckOk: true,
    racyCheckOk: true,
    context: {
      client: {
        clientName: "TVHTML5",
        clientVersion: "7.20240411.10.00",
        platform: "TV",
        clientScreen: "WATCH",
      },
      user: { lockedSafetyMode: false },
      request: { useSsl: true },
    },
  };

  const res = await fetch(apiUrl, {
    method: "POST",
    headers: {
      ...headers,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  const data = await res.json();

  const playability = data.playabilityStatus || {};
  if (playability.status !== "OK") {
    throw new Error(`Video oynatılamıyor / Erişilemiyor: ${playability.reason || "Bilinmeyen hata"}`);
  }

  const streamingData = data.streamingData || {};
  
  return {
    video_id: videoId,
    hls_manifest_url: streamingData.hlsManifestUrl || null,
    formats: streamingData.formats || [],
    adaptive_formats: streamingData.adaptiveFormats || []
  };
}
