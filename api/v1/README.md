# Playlist redirect resolver

This Cloudflare Worker reads `pl.txt`, follows HTTP redirects for each stream URL in the requested page, and serves the rewritten playlist as a download at `/playlist.m3u`.

## Pagination

`start` is a zero-based channel index, and `limit` is the maximum number of channels (not the ending index) in the download. The default is `start=0&limit=100`, which includes the full current playlist. The maximum page size is 100.

Examples:

- `/playlist.m3u?start=0&limit=20` — channels 1–20
- `/playlist.m3u?start=20&limit=20` — channels 21–40
- `/playlist.m3u?start=40&limit=20` — channels 41–53

Each download retains the M3U header and channel metadata. Only URLs in the selected page are resolved for that request. If resolution fails, that entry keeps its original URL.

## Deploy

From this directory, authenticate with Wrangler and deploy:

```sh
npx wrangler login
npx wrangler deploy
```

Cloudflare prints the deployed Worker URL. Append `/playlist.m3u` and the desired query parameters to download the generated playlist (for example, `https://<worker>.<account>.workers.dev/playlist.m3u?start=0&limit=20`).

The playlist source is pinned to commit `4bebe80bd277ba01a29a336f2aa3f3841579fd15`. Update `PLAYLIST_SOURCE` in `worker.js` to use a different revision. The Worker resolves ordinary HTTP redirects only; if a stream endpoint returns a player page or requires client-side processing, its URL is retained as-is. The generated playlist is not cached because redirect targets may be temporary.
