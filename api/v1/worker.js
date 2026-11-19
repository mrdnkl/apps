const PLAYLIST_SOURCE = "https://raw.githubusercontent.com/mrdnkl/apps/4bebe80bd277ba01a29a336f2aa3f3841579fd15/api/v1/pl.txt";
const MAX_CONCURRENT_RESOLUTIONS = 4;

export default {
  async fetch(request) {
    const requestUrl = new URL(request.url);

    if (request.method !== "GET") {
      return new Response("Method not allowed", {
        status: 405,
        headers: { Allow: "GET" },
      });
    }

    if (requestUrl.pathname !== "/playlist.m3u") {
      return new Response("Not found. Download /playlist.m3u", { status: 404 });
    }

    try {
      const sourceResponse = await fetch(PLAYLIST_SOURCE, {
        headers: { Accept: "application/vnd.apple.mpegurl, text/plain" },
        cf: { cacheTtl: 0, cacheEverything: false },
      });

      if (!sourceResponse.ok) {
        return new Response("Could not load the source playlist", { status: 502 });
      }

      const source = await sourceResponse.text();
      const lines = source.split(/\r?\n/);
      const streamLines = [];

      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index].trim();
        if (/^https?:\/\//i.test(line)) streamLines.push(index);
      }

      await mapLimit(streamLines, MAX_CONCURRENT_RESOLUTIONS, async (lineIndex) => {
        const originalUrl = lines[lineIndex].trim();
        try {
          lines[lineIndex] = await resolveRedirect(originalUrl);
        } catch {
          // Keep the source URL in the playlist when resolution fails.
          lines[lineIndex] = originalUrl;
        }
      });

      return new Response(`${lines.join("\n").replace(/\n*$/, "")}\n`, {
        status: 200,
        headers: {
          "Content-Type": "audio/x-mpegurl; charset=utf-8",
          "Content-Disposition": 'attachment; filename="playlist.m3u"',
          "Cache-Control": "no-store, no-cache, must-revalidate",
          "X-Content-Type-Options": "nosniff",
        },
      });
    } catch {
      return new Response("Playlist generation failed", { status: 502 });
    }
  },
};

async function resolveRedirect(value) {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Unsupported stream URL protocol");
  }

  // Fetch follows standard HTTP redirects; the final response URL is the
  // resolved stream URL. Cancel the body immediately because it is not needed.
  const response = await fetch(url.href, { redirect: "follow" });
  const resolvedUrl = response.url || url.href;
  if (response.body) await response.body.cancel();

  const resolved = new URL(resolvedUrl);
  if (resolved.protocol !== "http:" && resolved.protocol !== "https:") {
    throw new Error("Redirected to an unsupported protocol");
  }
  return resolved.href;
}

async function mapLimit(items, limit, callback) {
  let nextIndex = 0;
  const workerCount = Math.min(limit, items.length);

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < items.length) {
        const index = nextIndex;
        nextIndex += 1;
        await callback(items[index]);
      }
    }),
  );
}
