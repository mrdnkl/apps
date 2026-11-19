# Playlist redirect resolver

This Cloudflare Worker reads `pl.txt`, follows HTTP redirects for each stream URL, and serves the rewritten playlist as a download at `/playlist.m3u`.

## Deploy

From this directory, authenticate with Wrangler and deploy:

```sh
npx wrangler login
npx wrangler deploy
```

Cloudflare prints the deployed Worker URL. Append `/playlist.m3u` to download the generated playlist (for example, `https://<worker>.<account>.workers.dev/playlist.m3u`).

The playlist source is pinned to commit `4bebe80bd277ba01a29a336f2aa3f3841579fd15`. Update `PLAYLIST_SOURCE` in `worker.js` to use a different revision. The Worker resolves ordinary HTTP redirects only; if a stream endpoint returns a player page or requires client-side processing, its URL is retained as-is. Unresolvable entries also remain unchanged. The generated playlist is not cached because redirect targets may be temporary.
