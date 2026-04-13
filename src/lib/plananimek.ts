import crypto from "crypto";

const Bt = "c2Fua2FuaW1laXN0aGViZXN0";
const We = "8f56ca8844878b4d9a70adaf7276b1d2";
const Ht = "9e4fe5bcee1ae034cba1e584109d019b423dda50";
const fe = "d3b07384d113edec49eaa6238ad5ff00";
const BASE = "https://www.sankavollerei.com";

function buildHeaders(method: string, pathname: string) {
  const ts = Math.floor(Date.now() + Math.random() * 30000 + 10000).toString();
  const nonce = Math.random().toString(36).substring(2, 15);
  const sig = crypto
    .createHmac("sha256", Ht)
    .update(`${method.toUpperCase()}:${pathname}:${ts}:${nonce}:${fe}:${Bt}`)
    .digest("hex");
  return {
    "x-timestamp": ts,
    "x-nonce": nonce,
    Authorization: We,
    "x-session": fe,
    "x-signature": sig,
    Origin: "https://sankanime.com",
    Referer: "https://sankanime.com/",
    "User-Agent": "Mozilla/5.0 (Linux; Android 10; K) Chrome/137",
    Accept: "application/json",
  };
}

export async function plana<T = unknown>(path: string): Promise<T> {
  const url = `${BASE}${path}`;
  const pathname = path.split("?")[0];
  const headers = buildHeaders("GET", pathname);
  const res = await fetch(url, { headers });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Plananimek ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json() as Promise<T>;
}

export async function planaText(path: string): Promise<{ text: string; status: number }> {
  const url = `${BASE}${path}`;
  const pathname = path.split("?")[0];
  const headers = buildHeaders("GET", pathname);
  const res = await fetch(url, { headers });
  const text = await res.text();
  return { text, status: res.status };
}

const VTTNIME_API_KEY = "Arshia7812";
const R2_CDN = "https://v0-cloudflare-r2-endpoints.vercel.app";

// In-memory cache: engVttUrl → cdn.animeplay.me URL (per process lifetime)
const indoSubCache = new Map<string, string>();

/**
 * Full pipeline:
 * 1. Upload VTT content to paste.rs → get hash ID (e.g. "0ZD1D.vtt")
 * 2. Call Vercel R2 endpoint with just the ID + ?title=filename.vtt
 * 3. Get back final CDN URL from cdn.animeplay.me
 */
async function uploadToR2CDN(content: string, title: string): Promise<string> {
  // Step 1: upload to paste.rs
  const pasteRes = await fetch("https://paste.rs/", {
    method: "POST",
    body: content,
    headers: { "Content-Type": "text/plain" },
  });
  if (!pasteRes.ok) throw new Error(`paste.rs upload failed: ${pasteRes.status}`);
  const pasteUrl = (await pasteRes.text()).trim();

  // Extract just the filename part (e.g. "0ZD1D" from "https://paste.rs/0ZD1D")
  const pasteId = pasteUrl.split("/").pop() ?? "";
  const pasteFile = pasteId.endsWith(".vtt") ? pasteId : `${pasteId}.vtt`;

  // Step 2: hand off to Vercel R2 CDN endpoint
  const cdnRes = await fetch(
    `${R2_CDN}/${pasteFile}?title=${encodeURIComponent(title)}`
  );
  if (!cdnRes.ok) throw new Error(`R2 CDN endpoint failed: ${cdnRes.status}`);

  const cdnData = (await cdnRes.json()) as {
    success: boolean;
    data?: { url: string };
  };
  if (!cdnData.success || !cdnData.data?.url) {
    throw new Error("R2 CDN returned no URL");
  }

  // Step 3: return final CDN URL (cdn.animeplay.me/...)
  return cdnData.data.url;
}

/**
 * Translates an English VTT URL to Indonesian via vttnime AI,
 * uploads the result through paste.rs → Vercel R2 → cdn.animeplay.me,
 * and returns the final CDN URL. Results are cached in-memory by engVttUrl.
 */
export async function getIndoSubtitleUrl(
  engVttUrl: string,
  animeTitle = "",
  episodeNumber = "1",
  opts: { cacheOnly?: boolean } = {}
): Promise<string | null> {
  if (indoSubCache.has(engVttUrl)) return indoSubCache.get(engVttUrl)!;

  const qs = new URLSearchParams({
    apikey: VTTNIME_API_KEY,
    url: engVttUrl,
    ...(animeTitle ? { animeTitle } : {}),
    episodeNumber,
  });

  // Build a clean filename from animeTitle + episodeNumber
  const slug = animeTitle
    ? `${animeTitle.toLowerCase().replace(/\s+/g, "-")}-episode-${episodeNumber}.vtt`
    : `subtitle-ep${episodeNumber}.vtt`;

  // Try check-cache first (fast ~200ms). If cacheOnly=true, skip the slow translation endpoint.
  const paths = opts.cacheOnly
    ? [`/api/vttnime/check-cache?${qs}`]
    : [`/api/vttnime/check-cache?${qs}`, `/api/vttnime?${qs}`];

  for (const path of paths) {
    try {
      const { text, status } = await planaText(path);
      if (status === 200 && text.startsWith("WEBVTT")) {
        const clean = text.replace(/^WEBVTT[^\n]*/, "WEBVTT").trimStart();
        const cdnUrl = await uploadToR2CDN(clean, slug);
        indoSubCache.set(engVttUrl, cdnUrl);
        return cdnUrl;
      }
    } catch {
      // continue to next path
    }
  }
  return null;
}

export function encodeServerId(episodeId: string, serverName: string, type: string): string {
  const payload = JSON.stringify({ e: episodeId, s: serverName, t: type });
  return Buffer.from(payload).toString("base64url");
}

export function decodeServerId(serverId: string): { e: string; s: string; t: string } | null {
  try {
    const raw = Buffer.from(serverId, "base64url").toString("utf-8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function todayDate(): string {
  return new Date().toISOString().split("T")[0];
}
