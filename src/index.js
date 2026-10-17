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
      // Python'daki YouTubeM3U8Extractor mantığı ile çalıştır
      const extractor = new YouTubeM3U8Extractor(targetUrl);
      const result = await extractor.getStreams();

      // Eğer HLS (m3u8) adresi varsa doğrudan canlı yayına yönlendir
      if (result.hls_manifest_url) {
        return Response.redirect(result.hls_manifest_url, 302);
      }

      // M3U8 yoksa JSON çıktısı döndür
      return new Response(JSON.stringify(result, null, 2), {
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

// --- Python Sınıfının JavaScript Karşılığı ---
class YouTubeM3U8Extractor {
  constructor(url) {
    this.url = url;
    // İstediğiniz özel başlık seti
    this.headers = {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-us,en;q=0.5",
      "Sec-Fetch-Mode": "navigate"
    };
    this.cookies = ""; // Session çerezlerini otomatik taşımak için
    this._normalizeUrl();
  }

  _normalizeUrl() {
    try {
      let parsed = new URL(this.url);
      if (parsed.hostname === "gaming.youtube.com") {
        parsed.hostname = "www.youtube.com";
      } else if (parsed.hostname.includes("youtu.be")) {
        const videoId = parsed.pathname.substring(1);
        this.url = `https://www.youtube.com/watch?v=${videoId}`;
      } else if (parsed.protocol !== "https:") {
        parsed.protocol = "https:";
      }
      this.url = parsed.toString();
    } catch (e) {
      // Geçersiz URL durumunda orijinali bırak
    }
  }

  async _getRes(targetUrl = null) {
    let urlToFetch = targetUrl || this.url;
    
    let currentHeaders = { ...this.headers };
    if (this.cookies) {
      currentHeaders["Cookie"] = this.cookies;
    }

    let response = await fetch(urlToFetch, { 
      headers: currentHeaders,
      redirect: "follow" 
    });

    // Çerezleri güncelle (Session simülasyonu)
    let setCookie = response.headers.get("Set-Cookie");
    if (setCookie) {
      this.cookies = setCookie;
    }

    let finalUrl = response.url;
    let html = await response.text();

    // Python'daki consent.youtube.com (Rıza duvarı) kontrolü
    if (new URL(finalUrl).hostname === "consent.youtube.com") {
      const matchForm = html.match(/<form action="([^"]+)"/);
      if (matchForm) {
        const target = matchForm[1];
        const inputRegex = /<input type="hidden" name="([^"]+)" value="([^"]*)"/g;
        const formData = new URLSearchParams();
        
        let match;
        while ((match = inputRegex.exec(html)) !== null) {
          formData.append(match[1], match[2]);
        }

        let postHeaders = { 
          ...this.headers, 
          "Content-Type": "application/x-www-form-urlencoded" 
        };
        if (this.cookies) postHeaders["Cookie"] = this.cookies;

        const postRes = await fetch(target, {
          method: "POST",
          headers: postHeaders,
          body: formData.toString()
        });

        let postSetCookie = postRes.headers.get("Set-Cookie");
        if (postSetCookie) this.cookies = postSetCookie;

        finalUrl = postRes.url;
        html = await postRes.text();
        
        // Yeni response objesi oluşturup url ve text'i güncelliyoruz
        response = new Response(html, { status: postRes.status, headers: postRes.headers });
        // object assign ile response url'ini simüle ediyoruz
        Object.defineProperty(response, 'url', { value: finalUrl });
      }
    }

    return response;
  }

  _extractVideoIdFromHtml(htmlText) {
    const match = htmlText.match(/"videoId"\s*:\s*"([\w-]{11})"/);
    if (match) return match[1];
    
    const matchProp = htmlText.match(/itemprop="videoId" content="([\w-]{11})"/);
    if (matchProp) return matchProp[1];
    
    return null;
  }

  async _resolveChannelLiveUrl() {
    try {
      const parsed = new URL(this.url);
      if (parsed.pathname.includes("/live") || parsed.pathname.includes("/channel/") || parsed.pathname.includes("/@")) {
        const res = await this._getRes();
        const htmlText = await res.text();
        
        let vid = this._extractVideoIdFromHtml(htmlText);
        if (vid) return vid;
        
        let matchedVid = this._extractVideoId(res.url);
        if (matchedVid) return matchedVid;
      }
    } catch (e) {}
    return null;
  }

  _extractVideoId(targetUrl = null) {
    let urlToCheck = targetUrl || this.url;
    const patterns = [
      /https?:\/\/(?:\w+\.)?youtube\.com\/(?:v\/|live\/|watch\?(?:.*&)?v=)([\w-]{11})/,
      /https?:\/\/youtu\.be\/([\w-]{11})/,
      /https?:\/\/(?:\w+\.)?youtube\.com\/embed\/([\w-]{11})/
    ];
    for (const pattern of patterns) {
      const match = urlToCheck.match(pattern);
      if (match) return match[1];
    }
    return null;
  }

  async getStreams() {
    let videoId = this._extractVideoId();
    let res = null;
    let htmlText = "";

    if (!videoId) {
      videoId = await this._resolveChannelLiveUrl();
    }

    if (!videoId) {
      res = await this._getRes();
      htmlText = await res.text();
      videoId = this._extractVideoIdFromHtml(htmlText);
      
      if (!videoId) {
        const matchCanon = htmlText.match(/<link rel="canonical" href="([^"]+)"/);
        if (matchCanon) {
          videoId = this._extractVideoId(matchCanon[1]);
        }
      }
    }

    if (!videoId) {
      throw new Error("YouTube Video ID veya aktif canlı yayın bulunamadı.");
    }

    if (!res) {
      res = await this._getRes(`https://www.youtube.com/watch?v=${videoId}`);
      htmlText = await res.text();
    }

    const apiKeyMatch = htmlText.match(/"INNERTUBE_API_KEY"\s*:\s*"([^"]+)"/);
    const apiKey = apiKeyMatch ? apiKeyMatch[1] : "AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8";

    // Innertube API Çağrısı (TV veya Android Client ile)
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

    let apiHeaders = { 
      ...this.headers, 
      "Content-Type": "application/json" 
    };
    if (this.cookies) apiHeaders["Cookie"] = this.cookies;

    const apiRes = await fetch(apiUrl, {
      method: "POST",
      headers: apiHeaders,
      body: JSON.stringify(payload)
    });

    const data = await apiRes.json();

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
}
