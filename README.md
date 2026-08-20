# AudioBox

A Netflix-style public audiobook streaming site powered by LibriVox.

## What works

- Live LibriVox catalog and chapter audio
- Netflix-style hero, shelves, browse view, search, detail modal
- Direct chapter playback from LibriVox/Internet Archive audio URLs
- Continue Listening saved locally
- My List saved locally
- Chapter navigation, seek, volume, playback speed, sleep timer
- Browser/OS media controls through Media Session API
- Installable PWA shell
- Audiobook ZIP download link when supplied by LibriVox
- Recently Played shelf
- LibriVox cover art with Open Library cover fallback
- Author biography via Wikipedia
- Source-text / ebook link when supplied by LibriVox
- Best-edition ranking favors single-narrator recordings when duplicate versions are returned
- Responsive desktop/mobile UI
- No accounts, database, auth, payments, analytics, or paid API keys

## Run locally

Requires Node.js 18+.

```bash
npm start
```

Then open http://localhost:3000

The local server is dependency-free and proxies the public APIs to avoid browser CORS issues.

## Deploy

The project is Vercel-ready. Static files are served from the root and `/api/*.js` are serverless API routes.

```bash
vercel --prod
```

## Data sources

- LibriVox: audiobook metadata, sections, readers, cover art and audio URLs
- Open Library: cover fallback
- Wikipedia: short author biography/image fallback

AudioBox does not mirror or re-host audiobook audio.
