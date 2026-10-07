// MiniMax H3 request rules, as published on the model page (checked 2026-10-07).
// Everything here runs before a request leaves the machine, so a bad call costs nothing.

export const MODEL = "minimax-h3";
export const TIERS = { "768p": 0.039, "2k": 0.064 }; // USD per billed second
export const RATIOS = ["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"];
export const LIMITS = { minSeconds: 4, maxSeconds: 15, promptChars: 7000, images: 9, videos: 3, audios: 3, total: 12 };

export class UsageError extends Error {}

export function buildBody(o) {
  const prompt = (o.prompt ?? "").trim();
  if (!prompt) throw new UsageError("a prompt is required (positional or --prompt)");
  if (prompt.length > LIMITS.promptChars) {
    throw new UsageError(`the prompt has ${prompt.length} characters; MiniMax H3 takes up to ${LIMITS.promptChars}`);
  }
  const duration = o.duration === undefined ? 5 : Number(o.duration);
  if (!Number.isInteger(duration) || duration < LIMITS.minSeconds || duration > LIMITS.maxSeconds) {
    throw new UsageError(`--duration must be a whole number from ${LIMITS.minSeconds} to ${LIMITS.maxSeconds}`);
  }
  const resolution = String(o.resolution ?? "768p").toLowerCase();
  if (!(resolution in TIERS)) {
    throw new UsageError(`--resolution ${o.resolution} is not offered; MiniMax H3 renders 768p or 2k`);
  }
  const images = o.images ?? [], videos = o.videos ?? [], audios = o.audios ?? [];
  const body = { model: MODEL, prompt, duration, resolution };

  if (o.firstFrame || o.lastFrame) {
    if (!o.firstFrame) throw new UsageError("--last-frame needs --first-frame");
    if (images.length || videos.length || audios.length) {
      throw new UsageError("frames cannot be combined with --image, --video or --audio references");
    }
    if (o.ratio && o.ratio !== "adaptive") {
      throw new UsageError("frame mode follows the first frame's shape: drop --ratio or use --ratio adaptive");
    }
    body.aspect_ratio = "adaptive";
    body.start_image = { url: o.firstFrame };
    if (o.lastFrame) body.end_image = { url: o.lastFrame };
    return body;
  }

  if (images.length > LIMITS.images || videos.length > LIMITS.videos || audios.length > LIMITS.audios) {
    throw new UsageError("at most 9 --image, 3 --video and 3 --audio references");
  }
  if (images.length + videos.length + audios.length > LIMITS.total) {
    throw new UsageError("at most 12 references in total");
  }
  if (audios.length && !images.length && !videos.length) {
    throw new UsageError("--audio needs at least one --image or --video beside it");
  }
  const hasRefs = images.length + videos.length + audios.length > 0;
  const ratio = o.ratio ?? "16:9";
  if (!RATIOS.includes(ratio) && !(ratio === "adaptive" && hasRefs)) {
    throw new UsageError(`--ratio ${ratio} is not accepted; use ${RATIOS.join(", ")}${hasRefs ? " or adaptive" : ""}`);
  }
  body.aspect_ratio = ratio;
  if (images.length) body.reference_images = images.map((url) => ({ url }));
  if (videos.length) body.reference_videos = videos.map((url) => ({ url }));
  if (audios.length) body.reference_audios = audios.map((url) => ({ url }));
  return body;
}

export function cost(duration, resolution = "768p", referenceVideoSeconds = 0) {
  const rate = TIERS[String(resolution).toLowerCase()];
  if (rate === undefined) throw new UsageError(`unknown tier ${resolution}`);
  const billed = Number(duration) + Math.floor(Number(referenceVideoSeconds) || 0);
  return { billed_seconds: billed, usd: Math.round(billed * rate * 10000) / 10000 };
}

export function assetUrls(body) {
  return [body.start_image?.url, body.end_image?.url,
    ...(body.reference_images ?? []).map((a) => a.url),
    ...(body.reference_videos ?? []).map((a) => a.url),
    ...(body.reference_audios ?? []).map((a) => a.url)].filter(Boolean);
}
