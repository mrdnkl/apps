const PLAYLIST_SOURCE = "your-playlist";
const MAX_CONCURRENT_RESOLUTIONS = 4;
const MAX_PAGE_SIZE = 100;

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

    const start = parseQueryInteger(requestUrl.searchParams.get("start"), 0);
    const limit = parseQueryInteger(requestUrl.searchParams.get("limit"), MAX_PAGE_SIZE);
    if (start === null || limit === null || limit < 1 || limit > MAX_PAGE_SIZE) {
      return new Response("Use non-negative start and limit from 1 to 100", { status: 400 });
    }

    try {
      const sourceResponse = await fetch(PLAYLIST_SOURCE, {
        headers: { Accept: "application/vnd.apple.mpegurl, text/plain" },
        cf: { cacheTtl: 0, cacheEverything: false },
      });

      if (!sourceResponse.ok) {
        return new Response("Could not load the source playlist", { status: 502 });
      }

      const { header, entries } = parsePlaylist(await sourceResponse.text());
      const selectedEntries = entries.slice(start, start + limit);
      const streamLines = selectedEntries.flatMap((entry) =>
        entry
          .map((line, index) => (/^https?:\/\//i.test(line.trim()) ? index : -1))
          .filter((index) => index >= 0)
          .map((index) => ({ entry, index })),
      );

      await mapLimit(streamLines, MAX_CONCURRENT_RESOLUTIONS, async ({ entry, index }) => {
        const originalUrl = entry[index].trim();
        try {
          entry[index] = await resolveRedirect(originalUrl);
        } catch {
          // Keep the source URL in the playlist when resolution fails.
          entry[index] = originalUrl;
        }
      });

      const output = [...header, ...selectedEntries.flat()].join("\n").replace(/\n*$/, "");
      const filename = `playlist-${start}-${Math.max(start, start + selectedEntries.length - 1)}.m3u`;
      return new Response(`${output}\n`, {
        status: 200,
        headers: {
          "Content-Type": "audio/x-mpegurl; charset=utf-8",
          "Content-Disposition": `attachment; filename="${filename}"`,
          "Cache-Control": "no-store, no-cache, must-revalidate",
          "X-Content-Type-Options": "nosniff",
        },
      });
    } catch {
      return new Response("Playlist generation failed", { status: 502 });
    }
  },
};

function parseQueryInteger(value, fallback) {
  if (value === null) return fallback;
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function parsePlaylist(source) {
  const lines = source.split(/\r?\n/);
  const firstEntry = lines.findIndex((line) => line.startsWith("#EXTINF:"));
  if (firstEntry === -1) return { header: lines, entries: [] };

  const header = lines.slice(0, firstEntry);
  const entries = [];
  let currentEntry = [];

  for (const line of lines.slice(firstEntry)) {
    if (line.startsWith("#EXTINF:") && currentEntry.length > 0) {
      entries.push(currentEntry);
      currentEntry = [];
    }
    currentEntry.push(line);
  }
  if (currentEntry.length > 0) entries.push(currentEntry);

  return { header, entries };
}

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
