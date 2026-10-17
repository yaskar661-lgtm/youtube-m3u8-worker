export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    
    // Kullanım: https://workers.dev
    // Örnek: ?url=https://www.youtube.com/@KanalAdi/live veya ?url=https://youtu.be
    let targetUrl = url.searchParams.get("url");

    if (!targetUrl) {
      return new Response(
        JSON.stringify({ error: "Lütfen '?url=' parametresi ile bir YouTube linki gönderin." }),
        { status: 400, headers: { "Content-Type": "application/json; charset=utf-8" } }
      );
    }

    try {
      // 1. URL'yi Normalize Et (Python'daki _normalize_url)
      targetUrl = normalizeUrl(targetUrl);

      // Çerezleri/Session'ı simüle etmek için başlıklar
      const baseHeaders = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept-Language": "en-US,en;q=0.9"
      };

      // 2. Doğrudan URL'den Video ID'yi Çıkarmayı Dene
      let videoId = extractVideoId(targetUrl);
      let pageHtml = "";

      // 3. ID bulunamadıysa veya Kanal/Live URL'siyse sayfayı ziyaret et
      if (!videoId || isChannelOrLiveUrl(targetUrl)) {
        const pageRes = await getWithConsentCheck(targetUrl, baseHeaders);
        pageHtml = pageRes.html;
        
        // Yönlendirilmiş nihai URL'den video ID'yi kontrol et
        videoId = extractVideoId(pageRes.finalUrl);

        // Sayfa HTML'inden video ID'yi ara
        if (!videoId) {
          videoId = extractVideoIdFromHtml(pageHtml);
        }

        // Canonical linkten ara
        if (!videoId) {
          const matchCanon = pageHtml.match(/<link rel="canonical" href="([^"]+)"/);
          if (matchCanon) {
            videoId = extractVideoId(matchCanon[1]);
          }
        }
      }

      if (!videoId) {
        throw new Error("YouTube Video ID veya aktif canlı yayın bulunamadı.");
      }

      // 4. Eğer elimizde sayfa HTML'i yoksa Innertube API Anahtarı için watch sayfasını çek
      if (!pageHtml) {
        const watchPageRes = await getWithConsentCheck(`https://youtube.com{videoId}`, baseHeaders);
        pageHtml = watchPageRes.html;
      }

      // Innertube API key bul veya varsayılanı kullan
      const apiKeyMatch = pageHtml.match(/"INNERTUBE_API_KEY"\s*:\s*"([^"]+)"/);
      const apiKey = apiKeyMatch ? apiKeyMatch[1] : "AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8";

      // 5. Innertube API Çağrısı (Python'daki ANDROID client payload'ı)
      const apiResult = await callInnertubePlayer(videoId, apiKey, baseHeaders);

      // Doğrudan M3U8 linkine yönlendirmek istiyorsanız:
      if (apiResult.hls_manifest_url) {
        return Response.redirect(apiResult.hls_manifest_url, 302);
      }

      // M3U8 yoksa veya JSON çıktıları görmek isterseniz:
      return new Response(JSON.stringify(apiResult, null, 2), {
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

// --- YARDIMCI FONKSİYONLAR (Python metotlarının JS karşılıkları) ---

function normalizeUrl(urlStr) {
  try {
    let parsed = new URL(urlStr);
    if (parsed.hostname === "gaming.youtube.com") {
      parsed.hostname = "www.youtube.com";
    } else if (parsed.hostname === "youtu.be") {
      const videoId = parsed.pathname.substring(1);
      return `https://youtube.com{videoId}`;
    }
    if (parsed.protocol !== "https:") {
      parsed.protocol = "https:";
    }
    return parsed.toString();
  } catch (e) {
    return urlStr;
  }
}

function isChannelOrLiveUrl(urlStr) {
  try {
    const path = new URL(urlStr).pathname;
    return path.includes("/live") || path.includes("/channel/") || path.includes("/@");
  } catch (e) {
    return false;
  }
}

function extractVideoId(urlStr) {
  const patterns = [
    /youtube\.com\/(?:v\/|live\/|watch\?(?:.*&)?v=)([\w-]{11})/,
    /youtu\.be\/([\w-]{11})/,
    /youtube\.com\/embed\/([\w-]{11})/
  ];
  for (const pattern of patterns) {
    const match = urlStr.match(pattern);
    if (match) return match[1];
  }
  return null;
}

function extractVideoIdFromHtml(html) {
  const matchId = html.match(/"videoId"\s*:\s*"([\w-]{11})"/);
  if (matchId) return matchId[1];

  const matchProp = html.match(/itemprop="videoId" content="([\w-]{11})"/);
  if (matchProp) return matchProp[1];

  return null;
}

// Python'daki _get_res (Çerez/Consent Duvarı Yönetimi)
async function getWithConsentCheck(url, headers) {
  let response = await fetch(url, { headers });
  let finalUrl = response.url;
  let html = await response.text();

  // Eğer Google Rıza (Consent) duvarına takılırsa otomatik formu post et
  if (new URL(finalUrl).hostname === "consent.youtube.com") {
    const formActionMatch = html.match(/<form action="([^"]+)"/);
    if (formActionMatch) {
      const target = formActionMatch[1];
      const inputRegex = /<input type="hidden" name="([^"]+)" value="([^"]*)"/g;
      const formData = new URLSearchParams();
      
      let match;
      while ((match = inputRegex.exec(html)) !== null) {
        formData.append(match[1], match[2]);
      }

      // Cookie takibi için ilk response başlıklarını alıyoruz
      const setCookie = response.headers.get("Set-Cookie");
      const postHeaders = { ...headers, "Content-Type": "application/x-www-form-urlencoded" };
      if (setCookie) postHeaders["Cookie"] = setCookie;

      const postRes = await fetch(target, {
        method: "POST",
        headers: postHeaders,
        body: formData.toString()
      });
      
      finalUrl = postRes.url;
      html = await postRes.text();
    }
  }

  return { html, finalUrl };
}

// Innertube Player API İstek Fonksiyonu
async function callInnertubePlayer(videoId, apiKey, headers) {
  const apiUrl = `https://youtube.com{apiKey}`;
  const payload = {
    videoId: videoId,
    contentCheckOk: true,
    racyCheckOk: true,
    context: {
      client: {
        clientName: "ANDROID",
        clientVersion: "21.08.266",
        platform: "DESKTOP",
        clientScreen: "EMBED",
        clientFormFactor: "UNKNOWN_FORM_FACTOR",
        browserName: "Chrome",
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
