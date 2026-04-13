import { Router, type IRouter, type Request, type Response } from "express";
import { startSync, syncState } from "../lib/scraper";
import { getDb } from "../lib/db";
import { plana, getIndoSubtitleUrl, decodeServerId as decodeServerIdLib } from "../lib/plananimek";

const router: IRouter = Router();

// ─── Deep Stream Sync helpers ─────────────────────────────────────────────────

const WORKER_COUNT  = 10;   // parallel worker chains
const WORKER_DELAY  = 500;  // ms between plana requests PER worker (10 workers → 20 req/s)
const GLOBAL_DELAY  = 300;  // ms for non-worker plana calls (episode list fetch, etc.)

// Global throttle chain — used only for episode-list fetches and other non-stream calls
let globalChain = Promise.resolve();
function globalThrottle(): Promise<void> {
  globalChain = globalChain.then(() => new Promise((r) => setTimeout(r, GLOBAL_DELAY)));
  return globalChain;
}

// Creates a per-worker vttnime throttle (1 call per VTTNIME_DELAY ms per worker)
const VTTNIME_DELAY = 500; // ms between vttnime calls PER worker (was 1000 — vttnime cache hits fast)
function makeVttnimeThrottle(delayMs = VTTNIME_DELAY) {
  let chain = Promise.resolve();
  return function vtThrottle(): Promise<void> {
    chain = chain.then(() => new Promise((r) => setTimeout(r, delayMs)));
    return chain;
  };
}

// Throttled wrapper for getIndoSubtitleUrl
async function getIndoSubThrottled(
  engVttUrl: string,
  animeTitle: string,
  episodeNumber: string,
  vtThrottle: () => Promise<void>,
  opts: { cacheOnly?: boolean } = {}
): Promise<string | null> {
  await vtThrottle();
  try {
    return await getIndoSubtitleUrl(engVttUrl, animeTitle, episodeNumber, opts);
  } catch { return null; }
}

// Creates an independent throttle function for one worker
function makeWorkerThrottle(delayMs = WORKER_DELAY) {
  let chain = Promise.resolve();
  return function throttle(): Promise<void> {
    chain = chain.then(() => new Promise((r) => setTimeout(r, delayMs)));
    return chain;
  };
}

// Generic "throttled plana" with retry — accepts any throttle function
async function planaWithThrottle<T>(
  path: string,
  throttle: () => Promise<void>,
  tries = 2
): Promise<T> {
  await throttle();   // ONE slot per request — retries do NOT re-throttle
  let lastErr: unknown;
  for (let i = 0; i < tries; i++) {
    try { return await plana<T>(path); }
    catch (e: unknown) {
      lastErr = e;
      const msg = String(e);
      if (msg.includes("401") || msg.includes("403") || msg.includes("429")) {
        await new Promise((r) => setTimeout(r, 2000 * (i + 1))); // 2s, 4s
        continue;
      }
      throw e;
    }
  }
  throw lastErr;
}

// Backward-compat wrapper for non-worker callers
async function planaT<T>(path: string, tries = 2): Promise<T> {
  return planaWithThrottle<T>(path, globalThrottle, tries);
}

type StreamApiRes = {
  results: {
    streamingLink?: {
      sources?: Array<{ file: string; type: string }>;
      link?: { file?: string; type?: string };
      tracks?: Array<{ file: string; label: string; kind: string }>;
    };
    servers?: Array<{ serverName: string; type: string; serverId?: string }>;
  };
};

const NON_SUB_KINDS = new Set(["thumbnails", "chapters", "metadata", "fonts", "preview"]);

function classifyTracks(tracks: Array<{ file: string; label: string; kind: string }>) {
  let subEn: string | null = null, subId: string | null = null;
  let anyOther: string | null = null; // catch-all: any subtitle not EN/ID
  for (const t of tracks) {
    const kind = (t.kind ?? "").toLowerCase().trim();
    const label = (t.label ?? "").toLowerCase().trim();
    if (!t.file || NON_SUB_KINDS.has(kind)) continue;
    // Explicitly skip sprite/image-based tracks
    if (t.file.includes(".png") || t.file.includes(".jpg") || t.file.includes(".webp")) continue;
    if (label.includes("english") || label === "en" || label === "eng") {
      subEn = subEn ?? t.file;
    } else if (label.includes("indonesia") || label === "id" || label === "ind") {
      subId = subId ?? t.file;
    } else if (label.includes("sub") || label === "" || kind === "subtitles" || kind === "captions") {
      subEn = subEn ?? t.file; // unlabeled or "sub" → assume EN
    } else {
      anyOther = anyOther ?? t.file; // any other language track
    }
  }
  // If still no EN/ID, use any other available subtitle as subEn
  if (!subEn && !subId && anyOther) subEn = anyOther;
  return { subEn, subId };
}

// Servers to try after HD-1 (keep short — fewer calls per no-sub episode)
const FALLBACK_SERVERS = ["HD-2", "HD-3", "Vidstreaming"];


type StreamResult = {
  streamUrl: string | null; streamType: string | null;
  subtitleEn: string | null; subtitleId: string | null; serverUsed: string;
};

// fetchBestStream accepts a per-worker throttle function — tries all servers until subtitle found
async function fetchBestStream(
  epId: string,
  throttle: () => Promise<void>
): Promise<StreamResult | null> {
  let bestStreamUrl: string | null = null;
  let bestStreamType: string | null = null;
  let bestServerUsed = "HD-1";
  let serverListFromApi: string[] = [];

  // ── Pass 1: HD-1 ─────────────────────────────────────────────────────────
  try {
    const r = await planaWithThrottle<StreamApiRes>(
      `/plananimek/api/stream?id=${encodeURIComponent(epId)}&server=HD-1&type=sub`, throttle, 2
    );
    const sl = r.results?.streamingLink;
    const url  = sl?.sources?.[0]?.file ?? sl?.link?.file ?? null;
    const type = sl?.sources?.[0]?.type ?? sl?.link?.type ?? null;
    if (url) { bestStreamUrl = url; bestStreamType = type; bestServerUsed = "HD-1"; }
    serverListFromApi = (r.results?.servers ?? []).map((s) => s.serverName).filter((s) => s !== "HD-1");
    const { subEn, subId } = classifyTracks(sl?.tracks ?? []);
    if (subEn || subId) return { streamUrl: url, streamType: type, subtitleEn: subEn, subtitleId: subId, serverUsed: "HD-1" };
  } catch { /* HD-1 failed — continue */ }

  // ── Pass 2: a few fast fallbacks only (dynamic from API first, then hardcoded) ─
  // Keep the list short — fewer calls per no-sub episode = higher throughput
  const dynamicFallbacks = serverListFromApi.filter((s) => !FALLBACK_SERVERS.includes(s));
  const fallbacks = [...new Set([...dynamicFallbacks, ...FALLBACK_SERVERS])].slice(0, 5);
  for (const sName of fallbacks) {
    try {
      const r = await planaWithThrottle<StreamApiRes>(
        `/plananimek/api/stream?id=${encodeURIComponent(epId)}&server=${encodeURIComponent(sName)}&type=sub`,
        throttle, 1
      );
      const sl = r.results?.streamingLink;
      const url  = sl?.sources?.[0]?.file ?? sl?.link?.file ?? null;
      const type = sl?.sources?.[0]?.type ?? sl?.link?.type ?? null;
      if (url && !bestStreamUrl) { bestStreamUrl = url; bestStreamType = type; bestServerUsed = sName; }
      const { subEn, subId } = classifyTracks(sl?.tracks ?? []);
      if (subEn || subId) return { streamUrl: url ?? bestStreamUrl, streamType: type ?? bestStreamType, subtitleEn: subEn, subtitleId: subId, serverUsed: sName };
    } catch { /* try next */ }
  }

  // No subtitle found — save best stream URL anyway (subtitle will be retried next run)
  if (bestStreamUrl) return { streamUrl: bestStreamUrl, streamType: bestStreamType, subtitleEn: null, subtitleId: null, serverUsed: bestServerUsed };
  return null;
}

// Simple pLimit helper
function makePLimit(concurrency: number) {
  const queue: Array<() => void> = [];
  let active = 0;
  function next() {
    if (active < concurrency && queue.length > 0) { active++; queue.shift()!(); }
  }
  return function run<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      queue.push(() => { fn().then(resolve).catch(reject).finally(() => { active--; next(); }); });
      next();
    });
  };
}

// ─── Deep Stream Sync state ───────────────────────────────────────────────────

const deepStreamState = {
  running: false,
  phase: "idle" as string,
  total: 0, done: 0,
  withSub: 0, noStream: 0, errors: 0,
  startedAt: null as Date | null,
  finishedAt: null as Date | null,
  workers: [] as string[],   // per-worker current anime
};

// ── Single anime processor — called by each worker ────────────────────────────
async function processOneAnime(
  animeId: string,
  throttle: () => Promise<void>,
  workerIdx: number
): Promise<void> {
  const db  = await getDb();
  const col = db.collection("animeall");
  const pg  = db.collection("syncprogress");
  deepStreamState.workers[workerIdx] = animeId;

  const anime = await col.findOne({ id: animeId }, { projection: { episodes: 1, episodeCount: 1 } });
  let episodes: Array<Record<string, unknown>> = (anime?.episodes as Array<Record<string, unknown>>) ?? [];
  const knownEpCount: number = (anime?.episodeCount as number) ?? -1;

  // Only fetch episode list from plana if:
  //  - episodes array is empty AND
  //  - episodeCount is unknown (-1) or DB says > 0 (but array is missing)
  // Skip fetch if DB already confirmed episodeCount === 0 (avoid slow globalThrottle call)
  if (episodes.length === 0 && knownEpCount !== 0) {
    try {
      const r = await planaWithThrottle<{
        results: { episodes: Array<{ id: string; episode_no: number; title: string; filler: boolean }> }
      }>(`/plananimek/api/episodes/${encodeURIComponent(animeId)}`, globalThrottle, 3);
      const rawEps = r.results?.episodes ?? [];
      episodes = rawEps.map((ep) => ({
        episode_no: ep.episode_no, plananimekId: ep.id, title: ep.title, filler: ep.filler,
        streamUrl: null, streamType: null, subtitleEn: null, subtitleId: null, serverUsed: null,
      }));
      if (episodes.length > 0)
        await col.updateOne({ id: animeId }, { $set: { episodes, episodeCount: episodes.length, syncedAt: new Date() } }, { upsert: true });
    } catch { /* skip */ }
  }

  // No episodes → mark done immediately
  if (episodes.length === 0) {
    await pg.updateOne({ _id: "deepSync" }, { $addToSet: { doneAnimeIds: animeId }, $inc: { doneCount: 1 } }, { upsert: true });
    deepStreamState.done++;
    return;
  }

  // Filter episodes that still need streams/subtitles
  const needsStream = episodes
    .map((ep, idx) => ({ ep, idx }))
    .filter(({ ep }) => {
      const id = ep.plananimekId ?? ep.id;
      return id && (!ep.streamUrl || !(ep.subtitleEn || ep.subtitleId));
    });

  if (needsStream.length === 0) {
    await col.updateOne({ id: animeId }, { $set: { streamSyncedAt: new Date() } });
    await pg.updateOne({ _id: "deepSync" }, { $addToSet: { doneAnimeIds: animeId }, $inc: { doneCount: 1 } }, { upsert: true });
    deepStreamState.done++;
    return;
  }

  // Mark start of stream sync for this anime
  await col.updateOne({ id: animeId }, { $set: { streamSyncedAt: new Date() } }, { upsert: true });

  // Process episodes concurrently (within this worker's throttle chain)
  const epLimit = makePLimit(3); // 3 concurrent eps per worker (queued into worker throttle)
  await Promise.all(
    needsStream.map(({ ep, idx }) =>
      epLimit(async () => {
        const epId = (ep.plananimekId ?? ep.id) as string;
        try {
          const r = await fetchBestStream(epId, throttle);
          if (!r) { deepStreamState.noStream++; return; }
          // Build update — NEVER overwrite existing subtitle with null
          const setFields: Record<string, unknown> = {
            [`episodes.${idx}.streamUrl`]:  r.streamUrl,
            [`episodes.${idx}.streamType`]: r.streamType,
            [`episodes.${idx}.serverUsed`]: r.serverUsed,
            streamSyncedAt: new Date(),
          };
          if (r.subtitleEn) setFields[`episodes.${idx}.subtitleEn`] = r.subtitleEn;
          if (r.subtitleId) setFields[`episodes.${idx}.subtitleId`] = r.subtitleId;
          await col.updateOne({ id: animeId }, { $set: setFields });
          if (r.subtitleEn || r.subtitleId) deepStreamState.withSub++;
          else deepStreamState.noStream++;
        } catch { deepStreamState.errors++; }
      })
    )
  );

  // Mark anime fully done
  await pg.updateOne(
    { _id: "deepSync" },
    { $addToSet: { doneAnimeIds: animeId }, $inc: { doneCount: 1 } },
    { upsert: true }
  );
  deepStreamState.done++;
}

// ── Main sync orchestrator — partitions work across WORKER_COUNT parallel chains ──
async function doDeepStreamSync() {
  if (deepStreamState.running) return;
  deepStreamState.running = true;
  deepStreamState.startedAt = new Date();
  deepStreamState.errors = 0; deepStreamState.withSub = 0; deepStreamState.noStream = 0;
  deepStreamState.workers = Array(WORKER_COUNT).fill("idle");

  try {
    const db  = await getDb();

    // Load existing progress
    const progDoc = await db.collection("syncprogress").findOne({ _id: "deepSync" });
    const doneSet  = new Set<string>(progDoc?.doneAnimeIds ?? []);
    deepStreamState.done  = doneSet.size;

    // All anime IDs
    const allIds = (await db.collection("animeall").find({}, { projection: { id: 1 } }).toArray())
      .map((a: Record<string, unknown>) => a.id as string)
      .filter(Boolean);
    deepStreamState.total = allIds.length;

    const pending = allIds.filter((id: string) => !doneSet.has(id));
    deepStreamState.phase = `running — ${pending.length} pending, ${WORKER_COUNT} workers`;

    // Partition pending anime into WORKER_COUNT round-robin buckets
    const buckets: string[][] = Array.from({ length: WORKER_COUNT }, () => []);
    pending.forEach((id, i) => buckets[i % WORKER_COUNT].push(id));

    // Run all workers in parallel — each worker has its own throttle chain
    await Promise.all(
      buckets.map(async (bucket, workerIdx) => {
        const throttle = makeWorkerThrottle(WORKER_DELAY);
        for (const animeId of bucket) {
          if (!deepStreamState.running) break;
          try {
            await processOneAnime(animeId, throttle, workerIdx);
          } catch (e: unknown) {
            deepStreamState.errors++;
            deepStreamState.workers[workerIdx] = `ERR:${animeId}`;
          }
        }
        deepStreamState.workers[workerIdx] = "done";
      })
    );
  } catch (e: unknown) {
    deepStreamState.phase = `error: ${String(e).slice(0, 100)}`;
  } finally {
    deepStreamState.running = false;
    deepStreamState.finishedAt = new Date();
    if (!deepStreamState.phase.startsWith("error")) deepStreamState.phase = "done";
  }
}

// ─── Retry Sync — fixes episodes with missing streamUrl / subtitleEn / subtitleId ─

const retryStreamState = {
  running: false,
  phase: "idle" as string,
  totalAnime: 0, doneAnime: 0,
  totalEps: 0,   doneEps: 0,
  fixedStream: 0, fixedSubEn: 0, fixedSubId: 0,
  noStreamFound: 0, errors: 0,
  startedAt: null as Date | null,
  finishedAt: null as Date | null,
  workers: [] as string[],
};

// Try all servers available for an episode until we find stream + both subtitles
async function retryOneEpisode(
  epId: string,
  storedServers: Array<{ serverName: string; type: string; serverId?: string }>,
  existing: { streamUrl: string | null; subtitleEn: string | null; subtitleId: string | null },
  throttle: () => Promise<void>
): Promise<{ url: string | null; streamType: string | null; subEn: string | null; subId: string | null; serverUsed: string | null }> {
  let bestUrl    = existing.streamUrl;
  let bestType: string | null = null;
  let bestSubEn  = existing.subtitleEn;
  let bestSubId  = existing.subtitleId;
  let bestServer: string | null = null;

  // Already complete — nothing to do
  if (bestUrl && bestSubEn && bestSubId) return { url: bestUrl, streamType: null, subEn: bestSubEn, subId: bestSubId, serverUsed: null };

  // Build server list: sub-type first, then dub-type
  // Use stored servers if available, otherwise fall back to hardcoded list
  type SrvEntry = { serverName: string; type: string; epId: string };
  let serversToTry: SrvEntry[] = [];

  if (storedServers.length > 0) {
    for (const srv of storedServers) {
      // Decode serverId to get the actual episode ID for this server
      let resolvedEpId = epId;
      if (srv.serverId) {
        const dec = decodeServerIdLib(srv.serverId);
        if (dec?.e) resolvedEpId = dec.e;
      }
      serversToTry.push({ serverName: srv.serverName, type: srv.type, epId: resolvedEpId });
    }
    // sub first, then dub
    serversToTry.sort((a, b) => (a.type === "sub" ? -1 : 1) - (b.type === "sub" ? -1 : 1));
  } else {
    // No stored servers — try standard list
    const standard = ["HD-1", "HD-2", "HD-3", "Vidstreaming", "StreamWish", "Mp4Upload"];
    for (const s of standard) serversToTry.push({ serverName: s, type: "sub", epId });
  }

  for (const srv of serversToTry) {
    // Skip if we already have everything we need
    if (bestUrl && bestSubEn && bestSubId) break;
    try {
      const r = await planaWithThrottle<StreamApiRes>(
        `/plananimek/api/stream?id=${encodeURIComponent(srv.epId)}&server=${encodeURIComponent(srv.serverName)}&type=${encodeURIComponent(srv.type)}`,
        throttle, 1
      );
      const sl = r.results?.streamingLink;
      const url  = sl?.sources?.[0]?.file ?? sl?.link?.file ?? null;
      const type = sl?.sources?.[0]?.type ?? sl?.link?.type ?? null;
      if (url && !bestUrl) { bestUrl = url; bestType = type; bestServer = srv.serverName; }
      const { subEn, subId } = classifyTracks(sl?.tracks ?? []);
      if (subEn && !bestSubEn) bestSubEn = subEn;
      if (subId && !bestSubId) bestSubId = subId;
      if (!bestServer && (subEn || subId)) bestServer = srv.serverName;
    } catch { /* try next server */ }
  }

  return { url: bestUrl, streamType: bestType, subEn: bestSubEn, subId: bestSubId, serverUsed: bestServer };
}

// Process one anime in retry sync — 3 phases based on what's missing
async function processOneAnimeRetry(
  animeId: string,
  throttle: () => Promise<void>,
  vtThrottle: () => Promise<void>,
  workerIdx: number
): Promise<void> {
  const db  = await getDb();
  const col = db.collection("animeall");
  retryStreamState.workers[workerIdx] = animeId;

  const anime = await col.findOne({ id: animeId }, { projection: { episodes: 1, title: 1 } });
  const episodes: Array<Record<string, unknown>> = (anime?.episodes as Array<Record<string, unknown>>) ?? [];
  const animeTitle: string = (anime?.title as string) ?? animeId;

  // Separate episodes into groups based on what they need
  type EpEntry = { ep: Record<string, unknown>; idx: number };
  const needsStream: EpEntry[] = [];       // streamUrl == null → fetch stream + EN + translate ID
  const needsSubEn:  EpEntry[] = [];       // has stream, no subtitleEn → fetch EN + translate ID
  const needsSubId:  EpEntry[] = [];       // has stream + EN, no subtitleId → ONLY vttnime translate

  for (let idx = 0; idx < episodes.length; idx++) {
    const ep = episodes[idx];
    const epId = (ep.plananimekId ?? ep.id) as string | undefined;
    if (!epId) continue;
    if (!ep.streamUrl)                      needsStream.push({ ep, idx });
    else if (!ep.subtitleEn)                needsSubEn.push({ ep, idx });
    else if (!ep.subtitleId && ep.subtitleEn) needsSubId.push({ ep, idx });
  }

  if (!needsStream.length && !needsSubEn.length && !needsSubId.length) {
    retryStreamState.doneAnime++;
    return;
  }

  const epLimit   = makePLimit(3); // Phase A+B: 3 concurrent (involves plana stream calls — rate-limited)
  const epLimitC  = makePLimit(5); // Phase C:   5 concurrent (vttnime only — faster, no plana calls)

  // ── Phase A+B: Episodes needing stream fetch (then vttnime for ID) ───────────
  const needsFetch = [...needsStream, ...needsSubEn];
  await Promise.all(
    needsFetch.map(({ ep, idx }) =>
      epLimit(async () => {
        const epId = (ep.plananimekId ?? ep.id) as string;
        const storedServers = (ep.servers as Array<{ serverName: string; type: string; serverId?: string }>) ?? [];
        const existing = {
          streamUrl:  (ep.streamUrl  as string | null) ?? null,
          subtitleEn: (ep.subtitleEn as string | null) ?? null,
          subtitleId: (ep.subtitleId as string | null) ?? null,
        };
        try {
          const r = await retryOneEpisode(epId, storedServers, existing, throttle);
          const setFields: Record<string, unknown> = {};
          if (r.url       && !existing.streamUrl)  { setFields[`episodes.${idx}.streamUrl`]  = r.url;       retryStreamState.fixedStream++; }
          if (r.streamType)                          setFields[`episodes.${idx}.streamType`] = r.streamType;
          if (r.serverUsed)                          setFields[`episodes.${idx}.serverUsed`] = r.serverUsed;
          if (r.subEn     && !existing.subtitleEn) { setFields[`episodes.${idx}.subtitleEn`] = r.subEn;      retryStreamState.fixedSubEn++; }
          if (r.subId     && !existing.subtitleId) { setFields[`episodes.${idx}.subtitleId`] = r.subId;      retryStreamState.fixedSubId++; }
          if (Object.keys(setFields).length > 0)
            await col.updateOne({ id: animeId }, { $set: setFields });

          // If we now have EN subtitle but still no ID → vttnime translate
          const newSubEn = r.subEn ?? existing.subtitleEn;
          const newSubId = r.subId ?? existing.subtitleId;
          if (newSubEn && !newSubId) {
            const idUrl = await getIndoSubThrottled(newSubEn, animeTitle, String(ep.episode_no ?? idx + 1), vtThrottle);
            if (idUrl) {
              await col.updateOne({ id: animeId }, { $set: { [`episodes.${idx}.subtitleId`]: idUrl } });
              retryStreamState.fixedSubId++;
            }
          }
          retryStreamState.doneEps++;
        } catch { retryStreamState.errors++; }
      })
    )
  );

  // ── Phase C: Episodes with EN subtitle but no ID → vttnime cache-only (no slow translation) ─
  await Promise.all(
    needsSubId.map(({ ep, idx }) =>
      epLimitC(async () => {
        const engUrl = ep.subtitleEn as string;
        try {
          // cacheOnly=true: only try check-cache (fast ~200ms), skip slow 10s+ translation endpoint
          const idUrl = await getIndoSubThrottled(engUrl, animeTitle, String(ep.episode_no ?? idx + 1), vtThrottle, { cacheOnly: true });
          if (idUrl) {
            await col.updateOne({ id: animeId }, { $set: { [`episodes.${idx}.subtitleId`]: idUrl } });
            retryStreamState.fixedSubId++;
          } else {
            retryStreamState.noStreamFound++;
          }
          retryStreamState.doneEps++;
        } catch { retryStreamState.errors++; }
      })
    )
  );

  retryStreamState.doneAnime++;
}

// Orchestrate retry across 10 workers
async function doRetrySync() {
  if (retryStreamState.running) return;
  retryStreamState.running = true;
  retryStreamState.startedAt = new Date();
  retryStreamState.fixedStream = 0; retryStreamState.fixedSubEn = 0; retryStreamState.fixedSubId = 0;
  retryStreamState.noStreamFound = 0; retryStreamState.errors = 0;
  retryStreamState.doneAnime = 0; retryStreamState.doneEps = 0;
  retryStreamState.workers = Array(WORKER_COUNT).fill("idle");

  try {
    const db  = await getDb();
    const col = db.collection("animeall");

    // Find all anime with at least one episode missing stream, EN subtitle, or ID subtitle
    const problematic = await col.find(
      {
        $or: [
          // Missing stream URL entirely
          { "episodes": { $elemMatch: { plananimekId: { $ne: null }, streamUrl: null } } },
          // Has stream but missing EN subtitle
          { "episodes": { $elemMatch: { plananimekId: { $ne: null }, streamUrl: { $ne: null }, subtitleEn: null } } },
          // Has EN subtitle but missing ID subtitle (vttnime can fix this)
          { "episodes": { $elemMatch: { plananimekId: { $ne: null }, subtitleEn: { $ne: null }, subtitleId: null } } },
        ]
      },
      { projection: { id: 1 } }
    ).toArray();

    const ids = problematic.map((a: Record<string, unknown>) => a.id as string).filter(Boolean);
    retryStreamState.totalAnime = ids.length;
    retryStreamState.phase = `running — ${ids.length} anime to retry, ${WORKER_COUNT} workers`;

    // Round-robin across workers
    const buckets: string[][] = Array.from({ length: WORKER_COUNT }, () => []);
    ids.forEach((id, i) => buckets[i % WORKER_COUNT].push(id));

    await Promise.all(
      buckets.map(async (bucket, workerIdx) => {
        const throttle   = makeWorkerThrottle(WORKER_DELAY);
        const vtThrottle = makeVttnimeThrottle(VTTNIME_DELAY);
        for (const animeId of bucket) {
          if (!retryStreamState.running) break;
          try {
            await processOneAnimeRetry(animeId, throttle, vtThrottle, workerIdx);
          } catch { retryStreamState.errors++; }
        }
        retryStreamState.workers[workerIdx] = "done";
      })
    );
  } catch (e: unknown) {
    retryStreamState.phase = `error: ${String(e).slice(0, 100)}`;
  } finally {
    retryStreamState.running = false;
    retryStreamState.finishedAt = new Date();
    if (!retryStreamState.phase.startsWith("error")) retryStreamState.phase = "done";
  }
}

// ─── POST /anime/admin/sync/streams ───────────────────────────────────────────
// Start deep stream sync (resume-aware, background, non-blocking)
router.post("/anime/admin/sync/streams", (_req: Request, res: Response) => {
  if (deepStreamState.running)
    return ok(res, { message: "Already running", state: deepStreamState });
  deepStreamState.running = false; // reset so doDeepStreamSync can start
  doDeepStreamSync();
  ok(res, { message: "Deep stream sync started", state: deepStreamState });
});

// ─── GET /anime/admin/sync/streams/status ─────────────────────────────────────
router.get("/anime/admin/sync/streams/status", (_req: Request, res: Response) => {
  const elapsed = deepStreamState.startedAt
    ? Math.round((Date.now() - deepStreamState.startedAt.getTime()) / 1000)
    : 0;
  const rate    = elapsed > 0 ? ((deepStreamState.done / elapsed) * 60).toFixed(1) : "0";
  const eta     = deepStreamState.done > 0 && elapsed > 0
    ? Math.round(((deepStreamState.total - deepStreamState.done) / deepStreamState.done) * elapsed / 60)
    : null;
  ok(res, {
    ...deepStreamState,
    elapsedSec: elapsed,
    ratePerMin: parseFloat(rate),
    etaMin: eta,
    workerCount: WORKER_COUNT,
  });
});

// ─── POST /anime/admin/sync/streams/stop ──────────────────────────────────────
router.post("/anime/admin/sync/streams/stop", (_req: Request, res: Response) => {
  deepStreamState.running = false;
  deepStreamState.phase = "stopped";
  ok(res, { message: "Stop requested", state: deepStreamState });
});

// ─── POST /anime/admin/sync/streams/retry ─────────────────────────────────────
// Retry all episodes missing streamUrl / subtitleEn / subtitleId
// Tries ALL stored servers (decoded from serverId) + standard fallbacks
router.post("/anime/admin/sync/streams/retry", (_req: Request, res: Response) => {
  if (retryStreamState.running)
    return ok(res, { message: "Retry already running", state: retryStreamState });
  doRetrySync();
  ok(res, { message: "Retry stream sync started", state: retryStreamState });
});

// Called on server boot — auto-resume retry if not already running
export function autoStartRetry() {
  if (!retryStreamState.running) {
    console.log("[boot] Auto-starting stream retry sync...");
    doRetrySync();
  }
}

// ─── GET /anime/admin/sync/streams/retry/status ───────────────────────────────
router.get("/anime/admin/sync/streams/retry/status", (_req: Request, res: Response) => {
  const elapsed = retryStreamState.startedAt
    ? Math.round((Date.now() - retryStreamState.startedAt.getTime()) / 1000)
    : 0;
  const rate = elapsed > 0 ? ((retryStreamState.doneAnime / elapsed) * 60).toFixed(1) : "0";
  ok(res, {
    ...retryStreamState,
    elapsedSec: elapsed,
    ratePerMin: parseFloat(rate),
  });
});

// ─── POST /anime/admin/sync/streams/retry/stop ────────────────────────────────
router.post("/anime/admin/sync/streams/retry/stop", (_req: Request, res: Response) => {
  retryStreamState.running = false;
  retryStreamState.phase = "stopped";
  ok(res, { message: "Retry stop requested", state: retryStreamState });
});

// ─── GET /anime/admin/test/stream ─────────────────────────────────────────────
// Test raw plana stream response for an episode
router.get("/anime/admin/test/stream", async (req: Request, res: Response) => {
  const epId     = req.query.epId as string;
  const server   = (req.query.server as string) ?? "HD-1";
  const type     = (req.query.type  as string) ?? "sub";
  if (!epId) return err(res, 400, "epId query param required");
  try {
    const r = await plana<StreamApiRes>(`/plananimek/api/stream?id=${encodeURIComponent(epId)}&server=${encodeURIComponent(server)}&type=${encodeURIComponent(type)}`);
    const sl = r.results?.streamingLink;
    ok(res, {
      url:     sl?.sources?.[0]?.file ?? sl?.link?.file ?? null,
      type:    sl?.sources?.[0]?.type ?? sl?.link?.type ?? null,
      tracks:  sl?.tracks ?? [],
      servers: (r.results?.servers ?? []).map(s => s.serverName),
    });
  } catch (e: unknown) { err(res, 502, String(e)); }
});

// ─── GET /anime/admin/test/vttnime ────────────────────────────────────────────
// Test vttnime response for a given EN subtitle URL
router.get("/anime/admin/test/vttnime", async (req: Request, res: Response) => {
  const { planaText } = await import("../lib/plananimek");
  const url = req.query.url as string;
  if (!url) return err(res, 400, "url query param required");
  const qs = new URLSearchParams({ apikey: "Arshia7812", url });
  try {
    const cache = await planaText(`/api/vttnime/check-cache?${qs}`);
    const trans = cache.status !== 200 || !cache.text.startsWith("WEBVTT")
      ? await planaText(`/api/vttnime?${qs}`)
      : null;
    ok(res, {
      cacheStatus:   cache.status,
      cacheOk:       cache.status === 200 && cache.text.startsWith("WEBVTT"),
      cachePreview:  cache.text.slice(0, 150),
      transStatus:   trans?.status ?? null,
      transOk:       trans ? trans.status === 200 && trans.text.startsWith("WEBVTT") : null,
      transPreview:  trans?.text.slice(0, 150) ?? null,
    });
  } catch (e: unknown) { err(res, 502, String(e)); }
});

function ok(res: Response, data: unknown) {
  res.json({ success: true, results: data });
}
function err(res: Response, status: number, msg: string) {
  res.status(status).json({ success: false, error: msg });
}

// ─── POST /anime/admin/sync ────────────────────────────────────────────────────
// Mulai sync semua anime ke MongoDB animeall collection
// Body (opsional):
//   { fetchEpisodeStreams: true }   → juga fetch stream/subtitle per episode (lambat!)
//   { concurrency: 8 }             → jumlah request paralel
//   { animeId: "one-piece-100" }   → sync hanya 1 anime
router.post("/anime/admin/sync", async (req: Request, res: Response) => {
  const fetchEpisodeStreams = req.body?.fetchEpisodeStreams === true;
  const concurrency = Number(req.body?.concurrency) || 8;
  const onlyAnimeId = req.body?.animeId as string | undefined;

  const result = await startSync({ fetchEpisodeStreams, concurrency, onlyAnimeId });
  if ("error" in result) return err(res, 409, result.error);
  ok(res, {
    message: onlyAnimeId
      ? `Sync started for anime: ${onlyAnimeId}`
      : `Sync started for all anime (fetchEpisodeStreams=${fetchEpisodeStreams}, concurrency=${concurrency})`,
    status: syncState,
  });
});

// ─── GET /anime/admin/sync/status ─────────────────────────────────────────────
// Lihat progress sync yang sedang berjalan
router.get("/anime/admin/sync/status", (_req: Request, res: Response) => {
  ok(res, syncState);
});

// ─── GET /anime/admin/db/stats ────────────────────────────────────────────────
// Statistik koleksi animeall di MongoDB
router.get("/anime/admin/db/stats", async (_req: Request, res: Response) => {
  try {
    const db = await getDb();
    const col = db.collection("animeall");
    const [total, withStreams, recent] = await Promise.all([
      col.countDocuments(),
      col.countDocuments({ streamSyncedAt: { $ne: null } }),
      col.find({}, { projection: { id: 1, title: 1, episodeCount: 1, syncedAt: 1 } })
        .sort({ syncedAt: -1 })
        .limit(5)
        .toArray(),
    ]);
    ok(res, { total, withStreams, recentlySynced: recent });
  } catch (e: unknown) {
    err(res, 502, String(e));
  }
});

// ─── GET /anime/admin/db/anime/:id ────────────────────────────────────────────
// Lihat data anime di MongoDB
router.get("/anime/admin/db/anime/:id", async (req: Request, res: Response) => {
  try {
    const db = await getDb();
    const doc = await db.collection("animeall").findOne({ id: req.params.id });
    if (!doc) return err(res, 404, `${req.params.id} tidak ditemukan di database`);
    ok(res, doc);
  } catch (e: unknown) {
    err(res, 502, String(e));
  }
});

// ─── POST /anime/admin/sync/episodes ──────────────────────────────────────────
// Sync stream + subtitle untuk anime tertentu (deep sync per episode)
// Body: { animeId: "one-piece-100" }
router.post("/anime/admin/sync/episodes", async (req: Request, res: Response) => {
  const animeId = req.body?.animeId as string;
  if (!animeId) return err(res, 400, "Body 'animeId' required");

  const result = await startSync({
    fetchEpisodeStreams: true,
    concurrency: 4,
    onlyAnimeId: animeId,
  });
  if ("error" in result) return err(res, 409, result.error);
  ok(res, { message: `Deep sync (with streams) started for: ${animeId}`, status: syncState });
});

// ─── Genre & Schedule sync state ──────────────────────────────────────────────
const genreScheduleState = {
  running: false,
  phase: "idle" as string,
  genresDone: 0,
  genresTotal: 0,
  scheduleDone: false,
  errors: [] as string[],
  startedAt: null as Date | null,
  finishedAt: null as Date | null,
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function doGenreScheduleSync() {
  if (genreScheduleState.running) return;
  genreScheduleState.running = true;
  genreScheduleState.startedAt = new Date();
  genreScheduleState.errors = [];
  genreScheduleState.genresDone = 0;
  genreScheduleState.scheduleDone = false;

  try {
    const db = await getDb();

    // ── 1. Schedule sync ────────────────────────────────────────────────────
    genreScheduleState.phase = "schedule";
    const DAY_NAMES = ["sunday","monday","tuesday","wednesday","thursday","friday","saturday"];
    const schedCol = db.collection("schedule");
    const animeAll = db.collection("animeall");
    const now = new Date();
    const dow = now.getDay();

    for (let d = 0; d < 7; d++) {
      const date = new Date(now);
      date.setDate(now.getDate() - dow + d);
      const dateStr = date.toISOString().split("T")[0];
      const day = DAY_NAMES[d];
      try {
        await sleep(300);
        const data = await plana<{ results: unknown }>(`/plananimek/api/schedule?date=${dateStr}`);
        const items: Record<string, unknown>[] = Array.isArray(data.results) ? data.results as Record<string, unknown>[] : [];
        const ids = items.map((a) => a.id as string);
        const existing = await animeAll.find({ id: { $in: ids } }, { projection: { id: 1, poster: 1 } }).toArray();
        const posterMap: Record<string, string | null> = {};
        existing.forEach((a) => { posterMap[a.id] = a.poster ?? null; });
        const animeList = items.map((a) => ({
          id:          a.id as string,
          title:       a.title as string,
          thumbnail:   posterMap[a.id as string] ?? null,
          time:        a.time ?? null,
          episode_no:  a.episode_no ?? null,
          releaseDate: a.releaseDate ?? dateStr,
        }));
        await schedCol.updateOne({ _id: day }, { $set: { day, date: dateStr, updatedAt: new Date(), totalAnime: animeList.length, anime: animeList } }, { upsert: true });
      } catch (e: unknown) {
        genreScheduleState.errors.push(`schedule/${day}: ${String(e).slice(0, 80)}`);
      }
    }
    genreScheduleState.scheduleDone = true;

    // ── 2. Genre sync ───────────────────────────────────────────────────────
    genreScheduleState.phase = "genres";
    const home = await plana<{ results: { genres: string[] } }>("/plananimek/api/");
    const genres: string[] = home.results?.genres ?? [];
    genreScheduleState.genresTotal = genres.length;
    const genreCol = db.collection("anime_genre");

    for (const slug of genres) {
      const existing = await genreCol.findOne({ _id: slug }, { projection: { totalAnime: 1 } });
      if (existing && (existing.totalAnime as number) > 0) {
        genreScheduleState.genresDone++;
        continue;
      }
      genreScheduleState.phase = `genre:${slug}`;
      try {
        await sleep(300);
        const p1 = await plana<{ results: { totalPages: number; data: Record<string, unknown>[] } }>(`/plananimek/api/genre/${slug}?page=1`);
        const totalPages = p1.results?.totalPages ?? 1;
        const allAnime = (p1.results?.data ?? []).map((a) => ({ id: a.id, title: a.title, thumbnail: a.poster ?? null }));

        for (let pg = 2; pg <= totalPages; pg++) {
          await sleep(250);
          try {
            const d = await plana<{ results: { data: Record<string, unknown>[] } }>(`/plananimek/api/genre/${slug}?page=${pg}`);
            (d.results?.data ?? []).forEach((a) => allAnime.push({ id: a.id, title: a.title, thumbnail: a.poster ?? null }));
          } catch (e: unknown) {
            genreScheduleState.errors.push(`genre/${slug}/p${pg}: ${String(e).slice(0,40)}`);
          }
        }

        const name = slug.charAt(0).toUpperCase() + slug.slice(1).replace(/-/g, " ");
        await genreCol.updateOne({ _id: slug }, { $set: { slug, name, updatedAt: new Date(), totalAnime: allAnime.length, anime: allAnime } }, { upsert: true });
        genreScheduleState.genresDone++;
      } catch (e: unknown) {
        genreScheduleState.errors.push(`genre/${slug}: ${String(e).slice(0, 80)}`);
        genreScheduleState.genresDone++;
      }
    }
  } catch (e: unknown) {
    genreScheduleState.errors.push(`fatal: ${String(e).slice(0, 100)}`);
  } finally {
    genreScheduleState.running = false;
    genreScheduleState.phase = "done";
    genreScheduleState.finishedAt = new Date();
  }
}

// ─── POST /anime/admin/sync/genre-schedule ─────────────────────────────────────
// Start genre & schedule sync (background, non-blocking)
router.post("/anime/admin/sync/genre-schedule", (_req: Request, res: Response) => {
  if (genreScheduleState.running) {
    return ok(res, { message: "Already running", state: genreScheduleState });
  }
  doGenreScheduleSync(); // fire-and-forget
  ok(res, { message: "Genre & schedule sync started", state: genreScheduleState });
});

// ─── GET /anime/admin/sync/genre-schedule/status ───────────────────────────────
router.get("/anime/admin/sync/genre-schedule/status", (_req: Request, res: Response) => {
  ok(res, genreScheduleState);
});

export default router;
