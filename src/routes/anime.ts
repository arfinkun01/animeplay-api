import { Router, type IRouter, type Request, type Response } from "express";
import { readFileSync } from "fs";
import { join } from "path";
import { plana, planaText, encodeServerId, decodeServerId, todayDate, getIndoSubtitleUrl } from "../lib/plananimek";

const VTTNIME_KEY = "Arshia7812";

const CUSTOM_SUBS_PATH = join(__dirname, "../data/custom-subtitles.json");

type SubEntry = { url: string; label: string; addedAt: string };

function loadCustomSubs(): Record<string, SubEntry> {
  try {
    const raw = readFileSync(CUSTOM_SUBS_PATH, "utf-8");
    const data = JSON.parse(raw) as Record<string, unknown>;
    const result: Record<string, SubEntry> = {};
    for (const [key, val] of Object.entries(data)) {
      if (key.startsWith("_")) continue;
      result[key] = val as SubEntry;
    }
    return result;
  } catch {
    return {};
  }
}

const router: IRouter = Router();

function ok(res: Response, data: unknown) {
  res.json({ success: true, results: data });
}

function err(res: Response, status: number, message: string) {
  res.status(status).json({ success: false, error: message });
}

async function safe(res: Response, fn: () => Promise<void>) {
  try {
    await fn();
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Internal error";
    err(res, 502, msg);
  }
}

// ─── HOME ────────────────────────────────────────────────────────────────────
router.get("/anime/samehadaku/home", async (_req: Request, res: Response) => {
  await safe(res, async () => {
    const data = await plana<{ results: unknown }>("/plananimek/api/");
    ok(res, (data as { results: unknown }).results);
  });
});

// ─── RECENT (latest episodes from home) ──────────────────────────────────────
router.get("/anime/samehadaku/recent", async (req: Request, res: Response) => {
  await safe(res, async () => {
    const page = Number(req.query.page) || 1;
    const data = await plana<{ results: { latestEpisode: unknown[] } }>("/plananimek/api/");
    const all = (data.results.latestEpisode as unknown[]) || [];
    const perPage = 20;
    const start = (page - 1) * perPage;
    const paginated = all.slice(start, start + perPage);
    ok(res, { page, totalResults: all.length, data: paginated });
  });
});

// ─── SEARCH ──────────────────────────────────────────────────────────────────
router.get("/anime/samehadaku/search", async (req: Request, res: Response) => {
  await safe(res, async () => {
    const q = req.query.q as string;
    const page = req.query.page || "1";
    if (!q) return err(res, 400, "Query param 'q' is required");
    const keyword = encodeURIComponent(q);
    const data = await plana<{ results: unknown }>(`/plananimek/api/search?keyword=${keyword}&page=${page}`);
    ok(res, (data as { results: unknown }).results);
  });
});

// ─── ONGOING (top-airing) ─────────────────────────────────────────────────────
router.get("/anime/samehadaku/ongoing", async (req: Request, res: Response) => {
  await safe(res, async () => {
    const page = req.query.page || "1";
    const data = await plana<{ results: unknown }>(`/plananimek/api/top-airing?page=${page}`);
    ok(res, (data as { results: unknown }).results);
  });
});

// ─── COMPLETED ────────────────────────────────────────────────────────────────
router.get("/anime/samehadaku/completed", async (req: Request, res: Response) => {
  await safe(res, async () => {
    const page = req.query.page || "1";
    const data = await plana<{ results: unknown }>(`/plananimek/api/completed?page=${page}`);
    ok(res, (data as { results: unknown }).results);
  });
});

// ─── POPULAR ──────────────────────────────────────────────────────────────────
router.get("/anime/samehadaku/popular", async (req: Request, res: Response) => {
  await safe(res, async () => {
    const page = req.query.page || "1";
    const data = await plana<{ results: unknown }>(`/plananimek/api/most-popular?page=${page}`);
    ok(res, (data as { results: unknown }).results);
  });
});

// ─── MOVIES ───────────────────────────────────────────────────────────────────
router.get("/anime/samehadaku/movies", async (req: Request, res: Response) => {
  await safe(res, async () => {
    const page = req.query.page || "1";
    const data = await plana<{ results: unknown }>(`/plananimek/api/movie?page=${page}`);
    ok(res, (data as { results: unknown }).results);
  });
});

// ─── LIST (A-Z) ───────────────────────────────────────────────────────────────
router.get("/anime/samehadaku/list", async (req: Request, res: Response) => {
  await safe(res, async () => {
    const page = req.query.page || "1";
    const data = await plana<{ results: unknown }>(`/plananimek/api/az-list?page=${page}`);
    ok(res, (data as { results: unknown }).results);
  });
});

// ─── SCHEDULE ─────────────────────────────────────────────────────────────────
router.get("/anime/samehadaku/schedule", async (req: Request, res: Response) => {
  await safe(res, async () => {
    const date = (req.query.date as string) || todayDate();
    const data = await plana<{ results: unknown }>(`/plananimek/api/schedule?date=${date}`);
    ok(res, { date, schedule: (data as { results: unknown }).results });
  });
});

// ─── GENRES LIST ──────────────────────────────────────────────────────────────
router.get("/anime/samehadaku/genres", async (_req: Request, res: Response) => {
  await safe(res, async () => {
    const data = await plana<{ results: { genres: unknown } }>("/plananimek/api/");
    ok(res, (data.results as { genres: unknown }).genres);
  });
});

// ─── ANIME BY GENRE ───────────────────────────────────────────────────────────
router.get("/anime/samehadaku/genres/:genreId", async (req: Request, res: Response) => {
  await safe(res, async () => {
    const { genreId } = req.params;
    const page = req.query.page || "1";
    const data = await plana<{ results: unknown }>(`/plananimek/api/genre/${genreId}?page=${page}`);
    ok(res, (data as { results: unknown }).results);
  });
});

// ─── ANIME DETAIL + EPISODE LIST ─────────────────────────────────────────────
// animeId format: one-piece-100  (same as plananimek id)
router.get("/anime/samehadaku/anime/:animeId", async (req: Request, res: Response) => {
  await safe(res, async () => {
    const { animeId } = req.params;
    const [infoRes, epsRes] = await Promise.all([
      plana<{ results: unknown }>(`/plananimek/api/info?id=${animeId}`),
      plana<{ results: unknown }>(`/plananimek/api/episodes/${animeId}`),
    ]);
    ok(res, {
      anime: (infoRes as { results: unknown }).results,
      episodes: (epsRes as { results: unknown }).results,
    });
  });
});

// ─── EPISODE DETAIL + SERVER LIST ────────────────────────────────────────────
// Dua format yang didukung:
//
//  1. Query param (direkomendasikan — cocok dengan plananimek ID asli):
//     GET /anime/samehadaku/episode/one-piece-100?ep=157969
//     ep = plananimek internal episode ID
//
//  2. Path param (lama, tetap didukung):
//     GET /anime/samehadaku/episode/one-piece-100--ep--1
//     angka terakhir = episode_no sequential (1, 2, 3, ...)
//
router.get("/anime/samehadaku/episode/:animeId", async (req: Request, res: Response) => {
  await safe(res, async () => {
    const raw = req.params.animeId;

    // ── Format 1: ?ep=157969 (plananimek internal ID via query param) ──────────
    if (req.query.ep) {
      const epId = req.query.ep as string;
      const plananimekEpId = `${raw}?ep=${epId}`;

      const epsData = await plana<{
        results: { episodes: Array<{ episode_no: number; id: string; title: string; japanese_title: string; filler: boolean }> };
      }>(`/plananimek/api/episodes/${raw}`);

      const episode = epsData.results.episodes.find(
        (e) => e.id === plananimekEpId || e.id.endsWith(`?ep=${epId}`)
      );

      const streamData = await plana<{
        results: {
          streamingLink: unknown;
          servers: Array<{ type: string; data_id: string; server_id: string; serverName: string }>;
        };
      }>(`/plananimek/api/stream?id=${encodeURIComponent(plananimekEpId)}&server=HD-1&type=sub`);

      const servers = (streamData.results.servers || []).map((s) => ({
        id: encodeServerId(plananimekEpId, s.serverName, s.type),
        serverName: s.serverName,
        type: s.type,
        data_id: s.data_id,
      }));

      return ok(res, {
        episode: {
          episode_no: episode?.episode_no ?? null,
          plananimekId: plananimekEpId,
          title: episode?.title ?? null,
          japanese_title: episode?.japanese_title ?? null,
          filler: episode?.filler ?? false,
        },
        servers,
      });
    }

    // ── Format 2: one-piece-100--ep--1 (episode_no sequential, path param) ────
    const sep = "--ep--";
    const sepIdx = raw.lastIndexOf(sep);
    if (sepIdx === -1) {
      return err(
        res,
        400,
        "Format salah. Gunakan: /episode/one-piece-100?ep=157969  ATAU  /episode/one-piece-100--ep--1"
      );
    }

    const animeId = raw.slice(0, sepIdx);
    const epNum = Number(raw.slice(sepIdx + sep.length));
    if (!animeId || isNaN(epNum)) return err(res, 400, "Invalid episodeId format");

    const epsData = await plana<{
      results: { episodes: Array<{ episode_no: number; id: string; title: string; japanese_title: string; filler: boolean }> };
    }>(`/plananimek/api/episodes/${animeId}`);

    const episode = epsData.results.episodes.find((e) => e.episode_no === epNum);
    if (!episode) return err(res, 404, `Episode ${epNum} tidak ditemukan untuk ${animeId}`);

    const streamData = await plana<{
      results: {
        streamingLink: unknown;
        servers: Array<{ type: string; data_id: string; server_id: string; serverName: string }>;
      };
    }>(`/plananimek/api/stream?id=${encodeURIComponent(episode.id)}&server=HD-1&type=sub`);

    const servers = (streamData.results.servers || []).map((s) => ({
      id: encodeServerId(episode.id, s.serverName, s.type),
      serverName: s.serverName,
      type: s.type,
      data_id: s.data_id,
    }));

    ok(res, {
      episode: {
        episode_no: episode.episode_no,
        plananimekId: episode.id,
        title: episode.title,
        japanese_title: episode.japanese_title,
        filler: episode.filler,
      },
      servers,
    });
  });
});

// ─── SERVER (stream link) ────────────────────────────────────────────────────
// serverId: base64url encoded {e: episodeId, s: serverName, t: type}
// Generated automatically by /episode/:episodeId endpoint
// Auto-generates Indonesian subtitle via AI + paste.rs CDN and adds to tracks.
router.get("/anime/samehadaku/server/:serverId", async (req: Request, res: Response) => {
  await safe(res, async () => {
    const { serverId } = req.params;
    const decoded = decodeServerId(serverId);
    if (!decoded) return err(res, 400, "Invalid serverId. Get valid serverIds from /episode/:episodeId");

    const { e: episodeId, s: serverName, t: type } = decoded;
    const streamData = await plana<{
      results: {
        streamingLink: {
          tracks?: Array<{ file: string; label: string; kind: string; default?: boolean }>;
          [key: string]: unknown;
        };
        [key: string]: unknown;
      };
    }>(
      `/plananimek/api/stream?id=${encodeURIComponent(episodeId)}&server=${encodeURIComponent(serverName)}&type=${encodeURIComponent(type)}`
    );

    const results = streamData.results;
    const tracks = results?.streamingLink?.tracks ?? [];

    // Extract animeId and episode number from plananimek episodeId
    // Format: "one-piece-100?ep=2142"
    const [animeSlug, epQuery] = episodeId.split("?ep=");
    const epNumber = epQuery || "1";

    // Find the English subtitle track
    const engTrack = tracks.find((t) =>
      t.label?.toLowerCase().includes("english") || t.kind === "captions"
    );

    // Auto-generate Indonesian subtitle (non-blocking on error)
    let indoTrack: { file: string; label: string; kind: string; default: boolean } | null = null;
    if (engTrack?.file) {
      try {
        const indoUrl = await getIndoSubtitleUrl(engTrack.file, animeSlug, epNumber);
        if (indoUrl) {
          indoTrack = { file: indoUrl, label: "Indonesia (AI)", kind: "captions", default: false };
        }
      } catch {
        // subtitle generation failed — proceed without it
      }
    }

    // Inject Indonesian track into results
    if (indoTrack && results?.streamingLink) {
      results.streamingLink.tracks = [...tracks, indoTrack];
    }

    const sl = results?.streamingLink as Record<string, unknown> | undefined;
    const link = sl?.link as { file?: string; type?: string } | undefined;
    const finalTracks = (sl?.tracks ?? []) as Array<{ file: string; label: string; kind: string; default?: boolean }>;

    // Return clean flat structure + raw streamingLink for completeness
    ok(res, {
      // ── Easy-access top-level fields ──────────────────────────────────────
      embedUrl:  sl?.iframe ?? null,           // e.g. rapid-cloud.co/embed-2/...
      m3u8:      link?.file ?? null,           // HLS stream URL
      streamType: link?.type ?? null,          // "hls" | "mp4"
      server:    sl?.server ?? serverName,
      type,
      intro:     sl?.intro ?? null,
      outro:     sl?.outro ?? null,
      subtitles: finalTracks.map((t) => ({
        url:     t.file,
        label:   t.label,
        kind:    t.kind,
        default: t.default ?? false,
      })),
      // ── Raw plananimek data (full detail) ─────────────────────────────────
      streamingLink: sl,
    });
  });
});

// ─── AI SUBTITLE (Indonesian) ─────────────────────────────────────────────────
// GET /anime/samehadaku/subtitle/ai
//   ?url=<english_vtt_url>         (required)
//   &animeTitle=<title>            (optional, improves cache hit)
//   &episodeNumber=<number>        (optional, improves cache hit)
//
// Returns the Indonesian (.vtt) subtitle translated via Google Translate AI
// and cached on the vttnime server. If not yet cached, translation is triggered.
// Content-Type: text/vtt
router.get("/anime/samehadaku/subtitle/ai", async (req: Request, res: Response) => {
  const vttUrl = req.query.url as string;
  if (!vttUrl) return err(res, 400, "Query param 'url' is required (English VTT URL)");

  const animeTitle = (req.query.animeTitle as string) || "";
  const episodeNumber = (req.query.episodeNumber as string) || "1";

  try {
    // Build vttnime path — try cached first, falls back to on-demand translate
    const qs = new URLSearchParams({
      apikey: VTTNIME_KEY,
      url: vttUrl,
      ...(animeTitle ? { animeTitle } : {}),
      episodeNumber,
    });

    // First: check if cached
    const cached = await planaText(`/api/vttnime/check-cache?${qs.toString()}`);

    if (cached.status === 200 && cached.text.startsWith("WEBVTT")) {
      // Strip sankanime watermark and return clean VTT
      const clean = cached.text.replace(/^WEBVTT[^\n]*/, "WEBVTT").trimStart();
      res.setHeader("Content-Type", "text/vtt; charset=utf-8");
      res.setHeader("Access-Control-Allow-Origin", "*");
      return res.send(clean);
    }

    // Not cached: trigger on-demand translation via main vttnime endpoint
    const onDemand = await planaText(`/api/vttnime?${qs.toString()}`);

    if (onDemand.status === 200 && onDemand.text.startsWith("WEBVTT")) {
      const clean = onDemand.text.replace(/^WEBVTT[^\n]*/, "WEBVTT").trimStart();
      res.setHeader("Content-Type", "text/vtt; charset=utf-8");
      res.setHeader("Access-Control-Allow-Origin", "*");
      return res.send(clean);
    }

    // Both endpoints failed
    return err(res, 502, `AI subtitle unavailable (vttnime status ${onDemand.status})`);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Internal error";
    return err(res, 502, msg);
  }
});

// ─── CUSTOM SUBTITLE (manual Indonesian VTT) ─────────────────────────────────
// GET /anime/samehadaku/subtitle/custom
//   ?id=<episodeId>    (format: animeId--ep--episodeNumber, contoh: one-piece-100--ep--1)
//
// Membaca dari data/custom-subtitles.json, lalu proxy VTT-nya.
// Isi file JSON dengan key animeId--ep--N → { url, label, addedAt }
router.get("/anime/samehadaku/subtitle/custom", async (req: Request, res: Response) => {
  const id = req.query.id as string;
  if (!id) return err(res, 400, "Query param 'id' is required (contoh: one-piece-100--ep--1)");

  const subs = loadCustomSubs();
  const entry = subs[id];

  if (!entry) {
    return err(res, 404, `Subtitle untuk '${id}' belum tersedia. Tambahkan ke custom-subtitles.json`);
  }

  try {
    const resp = await fetch(entry.url, {
      headers: { "User-Agent": "Mozilla/5.0" },
    });
    if (!resp.ok) return err(res, 502, `Gagal mengambil VTT dari URL (status ${resp.status})`);
    const vttText = await resp.text();
    if (!vttText.startsWith("WEBVTT")) return err(res, 502, "URL bukan file VTT yang valid");

    res.setHeader("Content-Type", "text/vtt; charset=utf-8");
    res.setHeader("Access-Control-Allow-Origin", "*");
    return res.send(vttText);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Internal error";
    return err(res, 502, msg);
  }
});

// ─── CUSTOM SUBTITLE LIST ─────────────────────────────────────────────────────
// GET /anime/samehadaku/subtitle/custom/list
// Menampilkan semua episode yang sudah ada subtitle custom-nya
router.get("/anime/samehadaku/subtitle/custom/list", (_req: Request, res: Response) => {
  const subs = loadCustomSubs();
  ok(res, {
    total: Object.keys(subs).length,
    episodes: Object.entries(subs).map(([id, entry]) => ({
      id,
      label: entry.label,
      url: entry.url,
      addedAt: entry.addedAt,
    })),
  });
});

export default router;
