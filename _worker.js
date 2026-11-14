// ==========================================
// CONFIGURATION & CONSTANTS
// ==========================================
const DEFAULT_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 Minutes Cache

const MEDIA_EXTENSIONS = {
  hls: ['.m3u8', '.m3u', '.ts', '.m4s', '.mp4', '.aac', '.mp3', '.vtt'],
  dash: ['.mpd', '.m4s', '.mp4', '.webm', '.vtt'],
  mpegts: ['.ts', '.m2ts'],
};

const ALLOWED_EXTENSIONS = [...new Set(Object.values(MEDIA_EXTENSIONS).flat())];
const providerCaches = {};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const workerDomain = url.origin;

    try {
      // 1. Serve Static Assets (Landing page HTML, CSS, images in public/) 
      // If the path is root "/" or matches a static file, let Cloudflare Pages handle it.
      if (url.pathname === "/" || url.pathname.startsWith("/static/") || url.pathname.endsWith(".html") || url.pathname.endsWith(".css") || url.pathname.endsWith(".js")) {
        const assetResponse = await env.ASSETS.fetch(request);
        // If the static asset exists, return it directly
        if (assetResponse.status !== 404) {
          return assetResponse;
        }
      }

      // 2. Optional API Key security check for proxy routes
      const authError = verifyApiKey(url, env);
      if (authError) {
        console.warn(`[Security] Unauthorized access attempt from IP: ${request.headers.get("CF-Connecting-IP") || "unknown"}`);
        return authError;
      }

      const apiKeyParam = env.API_KEY && env.API_KEY.trim() !== "" ? `&key=${encodeURIComponent(env.API_KEY)}` : "";

      // 3. Build provider list from environment variables
      const providers = buildProvidersFromEnv(env);
      if (providers.length === 0) {
        console.error("[Config Error] No provider environment variables (P1, P2, etc.) were found in environment settings.");
        return new Response("Configuration Error: No M3U providers configured.", { status: 500 });
      }

      const allowedDomains = buildAllowedDomains(env, providers);

      // ==========================================
      // ROUTE 1: Split Playlist by Provider (/playlist_p1.m3u)
      // ==========================================
      const splitMatch = url.pathname.match(/^\/playlist_([a-zA-Z0-9]+)\.m3u$/);
      if (splitMatch) {
        const requestedPrefix = splitMatch[1].toLowerCase();
        const targetProvider = providers.find(p => p.prefix === requestedPrefix);

        if (!targetProvider) {
          console.warn(`[Route Warning] Requested split playlist prefix '${requestedPrefix}' does not exist.`);
          return new Response(`Error: Provider playlist '${requestedPrefix}' not found.`, { status: 404 });
        }

        try {
          const singlePlaylist = await buildSingleProviderPlaylist(workerDomain, targetProvider, apiKeyParam, env, allowedDomains);
          return new Response(singlePlaylist, {
            headers: {
              "Content-Type": "audio/x-mpegurl",
              "Content-Disposition": `inline; filename="playlist_${requestedPrefix}.m3u"`,
              "Access-Control-Allow-Origin": "*",
              "Cache-Control": "no-cache"
            }
          });
        } catch (err) {
          console.error(`[Playlist Error] Failed building playlist for ${targetProvider.name}:`, err.stack || err.message);
          return new Response(`Error generating provider playlist: ${err.message}`, { status: 502 });
        }
      }

      // ==========================================
      // ROUTE 2: /playlist.m3u (Merged Playlist)
      // ==========================================
      if (url.pathname === "/playlist.m3u") {
        try {
          const mergedPlaylist = await buildNamespacedPlaylist(workerDomain, providers, apiKeyParam, env, allowedDomains);
          return new Response(mergedPlaylist, {
            headers: {
              "Content-Type": "audio/x-mpegurl",
              "Content-Disposition": 'inline; filename="playlist.m3u"',
              "Access-Control-Allow-Origin": "*",
              "Cache-Control": "no-cache"
            }
          });
        } catch (err) {
          console.error("[Playlist Error] Failed building merged multi-provider playlist:", err.stack || err.message);
          return new Response(`Error generating merged playlist: ${err.message}`, { status: 502 });
        }
      }

      // ==========================================
      // ROUTE 3: /live/stream.m3u8?id=... (Stream Resolver)
      // ==========================================
      if (url.pathname === "/live/stream") {
        const rawStreamId = url.searchParams.get("id");
        if (!rawStreamId) {
          console.warn("[Stream Warning] Request missing 'id' parameter.");
          return new Response("Error: Missing 'id' parameter.", { status: 400 });
        }

        const cleanId = sanitizeStreamId(rawStreamId);
        const { prefix, targetId } = parseNamespacedId(cleanId);

        try {
          let targetStreamUrl = null;
          if (prefix) {
            targetStreamUrl = await findStreamInSpecificProvider(providers, prefix, targetId, env);
          } else {
            targetStreamUrl = await findStreamAcrossProviders(providers, targetId, env);
          }

          if (!targetStreamUrl) {
            console.warn(`[Stream Notice] Stream ID '${targetId}' (Prefix: ${prefix || 'none'}) not found in active providers.`);
            return new Response(`Error: Stream ID '${targetId}' not found.`, { status: 404 });
          }

          const formattedUrl = convertToM3U8Url(targetStreamUrl);

          const validationResult = validateStreamUrl(formattedUrl, allowedDomains);
          if (!validationResult.valid) {
            console.error(`[Security Violation] Blocked unsafe stream URL '${formattedUrl}'. Reason: ${validationResult.reason}`);
            return new Response(`403 Forbidden: ${validationResult.reason}`, { status: 403 });
          }

          const m3u8Content = [
            "#EXTM3U",
            "#EXT-X-VERSION:3",
            "#EXT-X-STREAM-INF:PROGRAM-ID=1,AVERAGE-BANDWIDTH=2200000,BANDWIDTH=2200000",
            formattedUrl
          ].join("\n");

          return new Response(m3u8Content, {
            headers: {
              "Content-Type": "application/vnd.apple.mpegurl",
              "Access-Control-Allow-Origin": "*",
              "Cache-Control": "no-cache"
            }
          });

        } catch (err) {
          console.error(`[Stream Error] Failed resolving stream ID '${cleanId}':`, err.stack || err.message);
          return new Response(`Stream Resolution Error: ${err.message}`, { status: 502 });
        }
      }

      // Fallback if asset missing and route unrecognized
      return new Response("Not Found", { status: 404 });

    } catch (globalErr) {
      console.error("[Fatal Error] Unhandled exception in worker fetch handler:", globalErr.stack || globalErr.message);
      return new Response(`Internal Server Error: ${globalErr.message}`, { status: 500 });
    }
  }
};

// ==========================================
// HELPER & SECURITY FUNCTIONS
// ==========================================

function buildAllowedDomains(env, providers) {
  const domains = new Set();
  if (env.ALLOWED_DOMAINS && typeof env.ALLOWED_DOMAINS === "string") {
    env.ALLOWED_DOMAINS.split(",").forEach(entry => {
      const cleaned = entry.trim().toLowerCase();
      if (cleaned) domains.add(cleaned);
    });
  }

  providers.forEach(provider => {
    try {
      const hostname = new URL(provider.url).hostname.toLowerCase();
      if (!isGitHubUrl(hostname)) {
        domains.add(hostname);
      }
    } catch (e) {
      console.warn(`[Config Warning] Malformed provider URL skipped in domain builder: ${provider.url}`);
    }
  });

  return Array.from(domains);
}

function isDomainAllowed(hostname, allowedDomains) {
  if (!allowedDomains || allowedDomains.length === 0) return false;
  const targetHost = hostname.toLowerCase();

  return allowedDomains.some(pattern => {
    if (pattern.startsWith("*.")) {
      const baseDomain = pattern.slice(2);
      return targetHost === baseDomain || targetHost.endsWith(`.${baseDomain}`);
    }
    return targetHost === pattern;
  });
}

function validateStreamUrl(rawUrl, allowedDomains) {
  try {
    const parsedUrl = new URL(rawUrl);
    if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
      return { valid: false, reason: "Invalid protocol." };
    }
    if (!isDomainAllowed(parsedUrl.hostname, allowedDomains)) {
      return { valid: false, reason: `Domain '${parsedUrl.hostname}' not whitelisted.` };
    }
    const pathname = parsedUrl.pathname.toLowerCase();
    const hasAllowedPathExt = ALLOWED_EXTENSIONS.some(ext => pathname.endsWith(ext));
    if (hasAllowedPathExt) return { valid: true };

    const queryExt = parsedUrl.searchParams.get("extension");
    if (queryExt) {
      const normalizedQueryExt = queryExt.startsWith(".") ? queryExt.toLowerCase() : `.${queryExt.toLowerCase()}`;
      if (ALLOWED_EXTENSIONS.includes(normalizedQueryExt)) return { valid: true };
    }

    return { valid: false, reason: "Extension not allowed." };
  } catch (e) {
    return { valid: false, reason: "Malformed URL format." };
  }
}

function verifyApiKey(url, env) {
  if (!env.API_KEY || env.API_KEY.trim() === "") return null;
  const clientKey = url.searchParams.get("key");
  if (!clientKey || clientKey !== env.API_KEY) {
    return new Response("401 Unauthorized: Invalid or missing API key.", {
      status: 401,
      headers: { "Content-Type": "text/plain" }
    });
  }
  return null;
}

function buildProvidersFromEnv(env) {
  const providers = [];
  for (let i = 1; i <= 10; i++) {
    const key = `P${i}`;
    const url = env[key];
    if (url && typeof url === "string" && url.trim().length > 0) {
      providers.push({
        prefix: `p${i}`,
        name: `Provider_${i}`,
        url: url.trim(),
        enabled: true,
        headers: { "User-Agent": DEFAULT_USER_AGENT }
      });
    }
  }
  return providers;
}

async function getOrFetchProviderM3U(provider, env) {
  const now = Date.now();
  const cacheKey = provider.name;

  if (!providerCaches[cacheKey]) {
    providerCaches[cacheKey] = { content: null, lastFetch: 0 };
  }

  const cache = providerCaches[cacheKey];
  if (cache.content && (now - cache.lastFetch < CACHE_TTL_MS)) {
    return cache.content;
  }

  const requestHeaders = {
    "User-Agent": DEFAULT_USER_AGENT,
    ...(provider.headers || {})
  };

  if (isGitHubUrl(provider.url) && env.GITHUB_TOKEN && env.GITHUB_TOKEN.trim() !== "") {
    requestHeaders["Authorization"] = `Bearer ${env.GITHUB_TOKEN.trim()}`;
  }

  try {
    const response = await fetch(provider.url, { method: "GET", headers: requestHeaders });
    if (!response.ok) {
      console.error(`[HTTP Error] Upstream provider '${provider.name}' returned status ${response.status} (${response.statusText}) for URL: ${provider.url}`);
      if (cache.content) return cache.content;
      return null;
    }

    cache.content = await response.text();
    cache.lastFetch = now;
    return cache.content;
  } catch (fetchErr) {
    console.error(`[Network Error] Failed connecting to provider '${provider.name}' (${provider.url}):`, fetchErr.message);
    if (cache.content) return cache.content;
    return null;
  }
}

function isGitHubUrl(urlStr) {
  return urlStr.includes("githubusercontent.com") || urlStr.includes("github.com");
}

async function buildSingleProviderPlaylist(workerDomain, provider, apiKeyParam, env, allowedDomains) {
  let linesOutput = ["#EXTM3U"];
  const rawM3u = await getOrFetchProviderM3U(provider, env);
  if (!rawM3u) throw new Error(`Unable to fetch or retrieve M3U content for ${provider.name}`);

  const lines = rawM3u.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.startsWith("#EXTM3U")) continue;

    if (line.startsWith("http")) {
      if (!validateStreamUrl(line, allowedDomains).valid) continue;
      const streamId = extractStreamId(line);
      if (streamId) {
        linesOutput.push(`${workerDomain}/live/stream?id=${provider.prefix}_${streamId}.m3u8${apiKeyParam}`);
      } else {
        linesOutput.push(line);
      }
    } else {
      linesOutput.push(line);
    }
  }

  return linesOutput.join("\n");
}

async function buildNamespacedPlaylist(workerDomain, providers, apiKeyParam, env, allowedDomains) {
  let combinedLines = ["#EXTM3U"];
  let successCount = 0;

  for (const provider of providers) {
    if (!provider.enabled) continue;
    try {
      const rawM3u = await getOrFetchProviderM3U(provider, env);
      if (!rawM3u) continue;

      const lines = rawM3u.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (line.startsWith("#EXTM3U")) continue;

        if (line.startsWith("http")) {
          if (!validateStreamUrl(line, allowedDomains).valid) continue;
          const streamId = extractStreamId(line);
          if (streamId) {
            combinedLines.push(`${workerDomain}/live/stream?id=${provider.prefix}_${streamId}.m3u8${apiKeyParam}`);
          } else {
            combinedLines.push(line);
          }
        } else {
          combinedLines.push(line);
        }
      }
      successCount++;
    } catch (err) {
      console.error(`[Merge Error] Error processing provider '${provider.name}':`, err.message);
    }
  }

  if (successCount === 0) throw new Error("All configured M3U providers failed to load.");
  return combinedLines.join("\n");
}

function sanitizeStreamId(idParam) {
  return idParam.replace(/\.(m3u8|ts|mpd|m3u)$/i, "");
}

function parseNamespacedId(fullId) {
  const match = fullId.match(/^([a-zA-Z0-9]+)_(.+)$/);
  if (match) {
    return { prefix: match[1], targetId: match[2] };
  }
  return { prefix: null, targetId: fullId };
}

async function findStreamInSpecificProvider(providers, prefix, streamId, env) {
  const provider = providers.find(p => p.prefix === prefix && p.enabled);
  if (!provider) return null;
  const m3uText = await getOrFetchProviderM3U(provider, env);
  if (!m3uText) return null;
  return parseM3UForId(m3uText, streamId);
}

async function findStreamAcrossProviders(providers, streamId, env) {
  for (const provider of providers) {
    if (!provider.enabled) continue;
    const m3uText = await getOrFetchProviderM3U(provider, env);
    if (!m3uText) continue;
    const streamUrl = parseM3UForId(m3uText, streamId);
    if (streamUrl) return streamUrl;
  }
  return null;
}

function extractStreamId(streamUrl) {
  try {
    const parsed = new URL(streamUrl);
    if (parsed.searchParams.has("stream")) return sanitizeStreamId(parsed.searchParams.get("stream"));
    if (parsed.searchParams.has("id")) return sanitizeStreamId(parsed.searchParams.get("id"));

    const pathSegments = parsed.pathname.split("/").filter(Boolean);
    if (pathSegments.length === 0) return null;

    const lastSegment = pathSegments[pathSegments.length - 1];
    if (lastSegment.toLowerCase().startsWith("index")) {
      const parentFolder = pathSegments[pathSegments.length - 2];
      return parentFolder ? sanitizeStreamId(parentFolder) : null;
    }

    const match = lastSegment.match(/([a-zA-Z0-9_-]+)(?:\.(m3u8|ts|mpd|m3u))?$/i);
    return match ? sanitizeStreamId(match[1]) : null;
  } catch (e) {
    return null;
  }
}

function parseM3UForId(m3uContent, streamId) {
  const lines = m3uContent.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.startsWith("http")) {
      const lineId = extractStreamId(line);
      if (lineId && lineId === streamId) {
        return line;
      }
    }
  }
  return null;
}

function convertToM3U8Url(rawUrl) {
  try {
    const parsedUrl = new URL(rawUrl);
    if (parsedUrl.searchParams.has("extension")) {
      parsedUrl.searchParams.set("extension", "m3u8");
    }
    let updatedUrl = parsedUrl.toString();
    if (parsedUrl.pathname.endsWith(".ts")) {
      updatedUrl = updatedUrl.replace(/\.ts(\?|$)/, ".m3u8$1");
    }
    return updatedUrl;
  } catch (e) {
    return rawUrl;
  }
}
