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
      let videoId = extractVideoId(targetUrl);
      
      const baseHeaders = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-us,en;q=0.5",
        "Sec-Fetch-Mode": "navigate"
      };

      // Eğer doğrudan ID yoksa kanal/live linkidir, ana sayfadan ID bul
      if (!videoId) {
        const pageRes = await fetch(targetUrl, { headers: baseHeaders, redirect: "follow" });
        const html = await pageRes.text();
        videoId = extractVideoIdFromHtml(html) || extractVideoId(pageRes.url);
      }

      if (!videoId) {
        throw new Error("YouTube Video ID veya aktif canlı yayın bulunamadı.");
      }

      // -- KRİTİK ÇÖZÜM: EMBED SAYFASINI KULLANMAK --
      // YouTube embed sayfaları bot korumalarından arındırılmış JSON verisini doğrudan barındırır.
      const embedUrl = `https://www.youtube.com/embed/${videoId}`;
      const embedRes = await fetch(embedUrl, { headers: baseHeaders });
      const embedHtml = await embedRes.text();

      // Embed sayfasından ytInitialPlayerResponse verisini yakala
      let playerResponse = null;
      const jsonMatch = embedHtml.match(/ytInitialPlayerResponse\s*=\s*({.+?});<\/script>/);
      
      if (jsonMatch) {
        try {
          playerResponse = JSON.parse(jsonMatch[1]);
        } catch (e) {}
      }

      if (!playerResponse) {
        // Alternatif olarak config değişkenini dene
        const altMatch = embedHtml.match(/ytplayer\.config\s*=\s*\{.+?["']args["']\s*:\s*\{.+?["']player_response["']\s*:\s*["']({.+?})["']/);
        if (altMatch) {
            try {
                // Unicode escape karakterlerini temizleyerek parse et
                let unescaped = altMatch[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\');
                playerResponse = JSON.parse(unescaped);
            } catch (e) {}
        }
      }

      if (!playerResponse) {
        throw new Error("Embed sayfasından da player verisi çözülemedi. Yayın gizli veya korumalı olabilir.");
      }

      const streamingData = playerResponse.streamingData || {};
      let hlsManifestUrl = streamingData.hlsManifestUrl || null;

      // HLS adresi doğrudan yoksa formatlar içinden .m3u8 ara
      if (!hlsManifestUrl) {
        const allFormats = [...(streamingData.formats || []), ...(streamingData.adaptiveFormats || [])];
        for (const fmt of allFormats) {
          if (fmt.url && fmt.url.includes(".m3u8")) {
            hlsManifestUrl = fmt.url;
            break;
          }
        }
      }

      if (hlsManifestUrl) {
        return Response.redirect(hlsManifestUrl, 302);
      }

      return new Response(JSON.stringify({
        video_id: videoId,
        hls_manifest_url: hlsManifestUrl,
        streaming_data: streamingData
      }, null, 2), {
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
      /embed\/([\w-]{11})/
    ];
    for (const pattern of patterns) {
      const match = urlStr.match(pattern);
      if (match) return match[1];
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
