import { getDb } from "./db";
import { plana, planaText } from "./plananimek";

// ─── Types ─────────────────────────────────────────────────────────────────────

interface AzAnime {
  id: string;
  data_id: string;
  poster: string;
  title: string;
  japanese_title: string;
  description: string;
  tvInfo: { showType: string; duration: string; sub?: string; dub?: string; eps?: string };
}

interface PlanEpisode {
  episode_no: number;
  id: string;
  title: string;
  japanese_title: string;
  filler: boolean;
}

interface AnimeInfoData {
  adultContent: boolean;
  data_id: string;
  id: string;
  sankalist: string;
  anilistId: number;
  malId: number;
  title: string;
  japanese_title: string;
  synonyms: string;
  poster: string;
  showType: string;
  animeInfo: Record<string, unknown>;
  charactersVoiceActors?: unknown[];
  recommended_data?: unknown[];
  related_data?: unknown[];
  popular_data?: unknown[];
}

// ─── State (shared for progress tracking) ──────────────────────────────────────

export interface SyncState {
  running: boolean;
  phase: string;
  total: number;
  done: number;
  errors: number;
  startedAt: string | null;
  finishedAt: string | null;
  lastError: string | null;
}

export const syncState: SyncState = {
  running: false,
  phase: "idle",
  total: 0,
  done: 0,
  errors: 0,
  startedAt: null,
  finishedAt: null,
  lastError: null,
};

// ─── Concurrency helper ────────────────────────────────────────────────────────

function pLimit(concurrency: number) {
  const queue: Array<() => void> = [];
  let active = 0;

  function next() {
    if (active < concurrency && queue.length > 0) {
      active++;
      const fn = queue.shift()!;
      fn();
    }
  }

  return function run<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      queue.push(() => {
        fn()
          .then(resolve)
          .catch(reject)
          .finally(() => {
            active--;
            next();
          });
      });
      next();
    });
  };
}

// ─── Az-list: fetch all anime IDs ─────────────────────────────────────────────

async function fetchAllAnimeIds(): Promise<AzAnime[]> {
  const firstPage = await plana<{ results: { totalPages: number; data: AzAnime[] } }>(
    "/plananimek/api/az-list?page=1"
  );
  const totalPages = firstPage.results.totalPages;
  const all: AzAnime[] = [...(firstPage.results.data || [])];

  const limit = pLimit(10);
  const rest = Array.from({ length: totalPages - 1 }, (_, i) => i + 2);
  await Promise.all(
    rest.map((page) =>
      limit(async () => {
        const res = await plana<{ results: { data: AzAnime[] } }>(
          `/plananimek/api/az-list?page=${page}`
        );
        all.push(...(res.results.data || []));
      })
    )
  );
  return all;
}

// ─── Fetch full anime info (info + episodes) ───────────────────────────────────

async function fetchAnimeDoc(animeId: string): Promise<{
  info: AnimeInfoData;
  episodes: PlanEpisode[];
}> {
  const [infoRes, epsRes] = await Promise.all([
    plana<{ results: { data: AnimeInfoData } }>(`/plananimek/api/info?id=${animeId}`),
    plana<{ results: { episodes: PlanEpisode[] } }>(`/plananimek/api/episodes/${animeId}`),
  ]);
  return {
    info: infoRes.results.data,
    episodes: epsRes.results.episodes || [],
  };
}

// ─── Fetch episode stream data (subtitle URLs + server metadata) ────────────────
// Returns only m3u8/mp4 sources. Subtitles are stable URLs, m3u8 expires.

async function planaWithRetry<T>(path: string): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 1500 * attempt));
    try { return await plana<T>(path); } catch (e: unknown) {
      const msg = String(e);
      if (msg.includes("403") || msg.includes("429")) { lastError = e; continue; }
      throw e;
    }
  }
  throw lastError;
}

async function fetchEpisodeStreamData(plananimekEpId: string): Promise<{
  streamUrl: string | null;
  streamType: string | null;
  subtitleEn: string | null;
  subtitleId: string | null;
  servers: Array<{ serverName: string; type: string; data_id: string; url: string | null; streamType: string | null }>;
}> {
  type StreamRes = {
    results: {
      streamingLink: {
        link?: { file?: string; type?: string };
        tracks?: Array<{ file: string; label: string; kind: string }>;
      };
      servers: Array<{ type: string; data_id: string; serverName: string }>;
    };
  };

  // Step 1: fetch HD-1 sub → get server list + subtitles + HD-1 URL
  const first = await planaWithRetry<StreamRes>(
    `/plananimek/api/stream?id=${encodeURIComponent(plananimekEpId)}&server=HD-1&type=sub`
  );

  const sl = first.results?.streamingLink;
  const tracks = sl?.tracks ?? [];
  const engTrack = tracks.find((t) => t.label?.toLowerCase().includes("english"));
  const idTrack  = tracks.find((t) => t.label?.toLowerCase().includes("indonesia"));
  const serverList = first.results?.servers || [];

  // Build a map: "ServerName|type" → url from HD-1 call (we already have HD-1 sub)
  const urlMap = new Map<string, { url: string | null; streamType: string | null }>();
  urlMap.set("HD-1|sub", { url: sl?.link?.file ?? null, streamType: sl?.link?.type ?? null });

  // Step 2: fetch URLs for all other servers concurrently (concurrency=3)
  const others = serverList.filter((s) => !(s.serverName === "HD-1" && s.type === "sub"));
  const svrLimit = pLimit(3);
  await Promise.all(
    others.map((s) =>
      svrLimit(async () => {
        try {
          const r = await planaWithRetry<StreamRes>(
            `/plananimek/api/stream?id=${encodeURIComponent(plananimekEpId)}&server=${encodeURIComponent(s.serverName)}&type=${encodeURIComponent(s.type)}`
          );
          const link = r.results?.streamingLink?.link;
          urlMap.set(`${s.serverName}|${s.type}`, { url: link?.file ?? null, streamType: link?.type ?? null });
        } catch {
          urlMap.set(`${s.serverName}|${s.type}`, { url: null, streamType: null });
        }
      })
    )
  );

  const servers = serverList.map((s) => {
    const key = `${s.serverName}|${s.type}`;
    const entry = urlMap.get(key) ?? { url: null, streamType: null };
    return { serverName: s.serverName, type: s.type, data_id: s.data_id, url: entry.url, streamType: entry.streamType };
  });

  return {
    streamUrl:  urlMap.get("HD-1|sub")?.url ?? null,
    streamType: urlMap.get("HD-1|sub")?.streamType ?? null,
    subtitleEn: engTrack?.file ?? null,
    subtitleId: idTrack?.file ?? null,
    servers,
  };
}

// ─── Fetch Indonesian subtitle via vttnime → paste.rs → R2 ────────────────────

const VTTNIME_KEY = "Arshia7812";
const R2_CDN = "https://v0-cloudflare-r2-endpoints.vercel.app";
const indoSubCache = new Map<string, string>();

async function getIndoSubUrl(
  engVttUrl: string,
  animeSlug: string,
  epId: string
): Promise<string | null> {
  const cacheKey = `${animeSlug}:${epId}`;
  if (indoSubCache.has(cacheKey)) return indoSubCache.get(cacheKey)!;

  const qs = new URLSearchParams({ apikey: VTTNIME_KEY, url: engVttUrl, episodeNumber: epId });

  for (const path of [`/api/vttnime/check-cache?${qs}`, `/api/vttnime?${qs}`]) {
    try {
      const { text, status } = await planaText(path);
      if (status === 200 && text.startsWith("WEBVTT")) {
        const clean = text.replace(/^WEBVTT[^\n]*/, "WEBVTT").trimStart();

        // Upload to paste.rs
        const pr = await fetch("https://paste.rs/", {
          method: "POST",
          body: clean,
          headers: { "Content-Type": "text/plain" },
        });
        if (!pr.ok) return null;
        const pasteUrl = (await pr.text()).trim();
        const pasteFile = pasteUrl.split("/").pop() ?? "";
        const pasteVtt = pasteFile.endsWith(".vtt") ? pasteFile : `${pasteFile}.vtt`;

        // Get R2 CDN URL
        const slug = `${animeSlug}-episode-${epId}.vtt`;
        const cr = await fetch(`${R2_CDN}/${pasteVtt}?title=${encodeURIComponent(slug)}`);
        if (!cr.ok) return null;
        const cd = (await cr.json()) as { success: boolean; data?: { url: string } };
        if (!cd.success || !cd.data?.url) return null;

        indoSubCache.set(cacheKey, cd.data.url);
        return cd.data.url;
      }
    } catch {
      // continue
    }
  }
  return null;
}

// ─── Main sync ─────────────────────────────────────────────────────────────────

export async function startSync(options: {
  fetchEpisodeStreams?: boolean;
  concurrency?: number;
  onlyAnimeId?: string;
}) {
  if (syncState.running) return { error: "Sync already running" };

  syncState.running = true;
  syncState.done = 0;
  syncState.errors = 0;
  syncState.startedAt = new Date().toISOString();
  syncState.finishedAt = null;
  syncState.lastError = null;

  const fetchEpisodeStreams = options.fetchEpisodeStreams ?? false;
  const concurrency = options.concurrency ?? 8;

  // Run in background (non-blocking)
  runSync(fetchEpisodeStreams, concurrency, options.onlyAnimeId).catch((e) => {
    syncState.lastError = String(e);
    syncState.running = false;
    syncState.finishedAt = new Date().toISOString();
    syncState.phase = "failed";
  });

  return { started: true };
}

async function runSync(
  fetchEpisodeStreams: boolean,
  concurrency: number,
  onlyAnimeId?: string
) {
  const db = await getDb();
  const col = db.collection("animeall");
  await col.createIndex({ id: 1 }, { unique: true });
  await col.createIndex({ title: "text" });

  let animeList: AzAnime[];

  if (onlyAnimeId) {
    animeList = [{ id: onlyAnimeId } as AzAnime];
    syncState.total = 1;
    syncState.phase = `syncing single anime: ${onlyAnimeId}`;
  } else {
    syncState.phase = "fetching anime list";
    animeList = await fetchAllAnimeIds();
    syncState.total = animeList.length;
    syncState.phase = "syncing anime info";
  }

  const limit = pLimit(concurrency);

  await Promise.all(
    animeList.map((azAnime) =>
      limit(async () => {
        const animeId = azAnime.id;
        try {
          const { info, episodes } = await fetchAnimeDoc(animeId);

          // Default server list (populated without API call — deep sync fills data_id)
          const DEFAULT_SERVERS = [
            { serverName: "HD-1", type: "sub" },
            { serverName: "HD-2", type: "sub" },
            { serverName: "HD-1", type: "dub" },
            { serverName: "HD-2", type: "dub" },
          ];

          const doc: Record<string, unknown> = {
            id: info.id ?? animeId,
            data_id: info.data_id,
            sankalist: info.sankalist,
            anilistId: info.anilistId,
            malId: info.malId,
            title: info.title,
            japanese_title: info.japanese_title,
            synonyms: info.synonyms,
            poster: info.poster,
            showType: info.showType,
            animeInfo: info.animeInfo,
            charactersVoiceActors: info.charactersVoiceActors ?? [],
            related: info.related_data ?? [],
            recommended: info.recommended_data ?? [],
            episodes: episodes.map((ep) => ({
              episode_no:  ep.episode_no,
              plananimekId: ep.id,
              title:        ep.title,
              japanese_title: ep.japanese_title,
              filler:       ep.filler,
              streamUrl:   null as string | null,  // m3u8/mp4 — filled by deep sync
              streamType:  null as string | null,  // "hls" | "mp4"
              subtitleEn:  null as string | null,  // filled by deep sync
              subtitleId:  null as string | null,  // filled by deep sync
              servers:     DEFAULT_SERVERS,        // filled with real data_id by deep sync
            })),
            episodeCount: episodes.length,
            syncedAt: new Date(),
            streamSyncedAt: null,
          };

          // Save basic anime doc first (immediately accessible in DB)
          await col.updateOne({ id: animeId }, { $set: doc }, { upsert: true });

          // Phase 2 (optional): fetch stream data per episode and update MongoDB directly
          if (fetchEpisodeStreams && episodes.length > 0) {
            syncState.phase = `stream sync: ${info.title} (${episodes.length} eps)`;
            const epLimit = pLimit(2); // concurrency=2 (each ep fetches ~12 server URLs)

            await Promise.all(
              episodes.map((ep, epIdx) =>
                epLimit(async () => {
                  try {
                    const stream = await fetchEpisodeStreamData(ep.id);
                    let subtitleId = stream.subtitleId;
                    if (!subtitleId && stream.subtitleEn) {
                      const epIdNum = ep.id.split("?ep=")[1] ?? ep.episode_no.toString();
                      subtitleId = await getIndoSubUrl(stream.subtitleEn, animeId, epIdNum);
                    }

                    // Update this specific episode's stream fields in-place
                    await col.updateOne(
                      { id: animeId },
                      {
                        $set: {
                          [`episodes.${epIdx}.streamUrl`]:  stream.streamUrl,
                          [`episodes.${epIdx}.streamType`]: stream.streamType,
                          [`episodes.${epIdx}.subtitleEn`]: stream.subtitleEn,
                          [`episodes.${epIdx}.subtitleId`]: subtitleId ?? null,
                          [`episodes.${epIdx}.servers`]:    stream.servers,
                          streamSyncedAt: new Date(),
                        },
                      }
                    );
                  } catch {
                    // Keep existing null/default values — don't fail the whole anime
                  }
                })
              )
            );
          }
          syncState.done++;
        } catch (e: unknown) {
          syncState.errors++;
          syncState.lastError = `${animeId}: ${String(e)}`;
        }
      })
    )
  );

  syncState.running = false;
  syncState.finishedAt = new Date().toISOString();
  syncState.phase = "done";
}
