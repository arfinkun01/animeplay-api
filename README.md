# AnimePlay API Server

Express + MongoDB backend for Anime Play — reverse-engineered sankanime.com metadata with stream URLs and subtitle tracks (EN/ID).

## Endpoints

### Anime
- `GET /anime/samehadaku/home` — Latest episodes / home feed
- `GET /anime/samehadaku/list?page=1` — Full anime list
- `GET /anime/samehadaku/search?q=naruto` — Search anime
- `GET /anime/samehadaku/:animeId` — Anime detail + episode list
- `GET /anime/samehadaku/episode/:animeId?ep={plananimekId}` — Episode stream info
- `GET /anime/samehadaku/episode/:animeId--ep--{number}` — Episode stream by sequential number
- `GET /anime/samehadaku/server/:serverId` — Get HLS stream URL (live-fetched, never expires)

### Admin (Sync)
- `POST /anime/admin/sync/start` — Start full deep sync (8787 anime)
- `GET /anime/admin/sync/status` — Deep sync progress
- `POST /anime/admin/sync/streams/retry` — Retry missing streams + subtitles
- `GET /anime/admin/sync/streams/retry/status` — Retry progress
- `POST /anime/admin/sync/streams/retry/stop` — Stop retry

### Health
- `GET /healthz` — Health check

## Deploy to Vercel

### 1. Clone & Import to Vercel
1. Fork/clone this repo
2. Go to [vercel.com](https://vercel.com) → New Project → Import from GitHub
3. Select `animeplay-api` repository

### 2. Environment Variables
Add these in Vercel project settings → Environment Variables:

| Variable | Value |
|----------|-------|
| `MONGODB_URI` | `mongodb+srv://user:pass@cluster.mongodb.net/?appName=Cluster0` |

### 3. Deploy
Click **Deploy** — Vercel will detect `vercel.json` and deploy automatically.

### ⚠️ Vercel Limitations
- **Stream retry sync** (`POST /anime/admin/sync/streams/retry`) will time out on Vercel free plan (10s limit). Run this from a long-running server (Railway, Render, VPS) or use Vercel Pro with background functions.
- **Auto-start retry** on boot is disabled on Vercel (`VERCEL=1` env var).
- All read endpoints (`/anime/...`, `/healthz`, `/anime/samehadaku/server/:serverId`) work fine on Vercel.

## Local Development

```bash
npm install
cp .env.example .env
# Edit .env with your MongoDB URI
npm run dev
```

## Tech Stack
- **Runtime**: Node.js + TypeScript
- **Framework**: Express 5
- **Database**: MongoDB (anime metadata, episodes, stream URLs, subtitles)
- **Subtitles**: vttnime AI translation (EN → Indonesian)
- **CDN**: cdn.animeplay.me (via Vercel R2 + paste.rs)
