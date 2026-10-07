// `h3` command dispatcher. main() takes its I/O as arguments so the tests can drive it.
import { writeFile } from "node:fs/promises";
import { basename } from "node:path";
import { parseArgs } from "node:util";

import { ApiError, createApi } from "./api.mjs";
import { UsageError, assetUrls, buildBody, cost } from "./request.mjs";

export const VERSION = "1.0.0";
const EXIT = { ok: 0, failed: 1, usage: 2, pending: 3 };

const HELP = `h3 ${VERSION} - MiniMax H3 video generation from the terminal (unofficial)

Usage
  h3 generate "prompt" [options]     submit, wait, download (local files are uploaded first)
  h3 status <request_id>             one status read
  h3 wait <request_id> [--out FILE]  poll until done, then download
  h3 download <request_id> [--out FILE]
  h3 upload <file> --kind image|video|audio   print a media_url for a local file
  h3 cost --duration N [--resolution 768p|2k] [--ref-video-seconds S]
  h3 models                          list model IDs served at H3_BASE_URL (no key needed)

generate options
  --duration N         4-15 seconds (default 5)
  --resolution R       768p (default) or 2k
  --ratio R            21:9 16:9 4:3 1:1 3:4 9:16; adaptive with references
  --first-frame IMG    first frame (JPEG/PNG path or https URL)
  --last-frame IMG     last frame, needs --first-frame
  --image IMG          reference image, repeatable (@Image 1, @Image 2, ...)
  --video CLIP         reference clip 2-15 s, repeatable (billed like output)
  --audio TRACK        reference audio 2-15 s, repeatable, needs an image or video
  --out FILE           where to save the MP4 (default h3-<request_id>.mp4)
  --async              print the request_id and exit without waiting
  --dry-run            print the request body and cost; send nothing
  --timeout SECONDS    stop waiting after this long (exit 3, job keeps running)
  --json               machine-readable output

Environment
  H3_API_KEY (required for generate/status/wait/download/upload)
  H3_BASE_URL (default https://argolink.io/v1), H3_POLL_SECONDS (default 10)`;

const OPTIONS = {
  prompt: { type: "string" }, duration: { type: "string" }, resolution: { type: "string" },
  ratio: { type: "string" }, "first-frame": { type: "string" }, "last-frame": { type: "string" },
  image: { type: "string", multiple: true }, video: { type: "string", multiple: true },
  audio: { type: "string", multiple: true }, out: { type: "string" }, async: { type: "boolean" },
  "dry-run": { type: "boolean" }, timeout: { type: "string" }, json: { type: "boolean" },
  kind: { type: "string" }, "ref-video-seconds": { type: "string" }, help: { type: "boolean", short: "h" },
  version: { type: "boolean", short: "v" },
};

const isLocal = (value) => typeof value === "string" && !value.startsWith("https://");

export async function main(argv, io) {
  const { stdout, stderr, env = {}, fetchImpl, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = io;
  const say = (line) => stdout.write(line + "\n");
  const note = (line) => stderr.write(line + "\n");
  let args;
  try {
    args = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true });
  } catch (error) {
    note(`h3: ${error.message}\n\n${HELP}`);
    return EXIT.usage;
  }
  const { values: o, positionals } = args;
  const [command, ...rest] = positionals;
  if (o.version) { say(VERSION); return EXIT.ok; }
  if (o.help || !command || command === "help") { say(HELP); return command || o.help ? EXIT.ok : EXIT.usage; }

  const api = createApi({ apiKey: env.H3_API_KEY, baseUrl: env.H3_BASE_URL || "https://argolink.io/v1", fetchImpl });
  const pollMs = Number(env.H3_POLL_SECONDS || 10) * 1000;
  const emit = (human, data) => (o.json ? say(JSON.stringify(data)) : say(human));

  async function waitFor(id) {
    const deadline = o.timeout ? Date.now() + Number(o.timeout) * 1000 : Infinity;
    for (;;) {
      const job = await api.status(id);
      if (job.status === "done") return job;
      if (job.status === "failed" || job.status === "expired") {
        const err = job.error ?? {};
        throw new ApiError(`job ${id} ${job.status}${err.code ? `: ${err.code}` : ""}${err.message ? ` - ${err.message}` : ""}` +
          (err.retryable === true ? " (safe to resubmit)" : ""), 0, job);
      }
      if (Date.now() >= deadline) return null;
      const eta = job.estimated_seconds_remaining !== undefined ? `, ~${job.estimated_seconds_remaining}s left` : "";
      note(`${id} ${job.status} ${job.progress ?? 0}%${eta}`);
      await sleep(pollMs);
    }
  }

  async function save(id, job, out) {
    const file = out || `h3-${id}.mp4`;
    await writeFile(file, await api.content(id));
    emit(`saved ${file} (billed ${job?.usage?.billed_seconds ?? "?"} s)`, { request_id: id, file, usage: job?.usage ?? null });
  }

  try {
    switch (command) {
      case "generate": {
        const spec = {
          prompt: o.prompt ?? rest.join(" "), duration: o.duration, resolution: o.resolution, ratio: o.ratio,
          firstFrame: o["first-frame"], lastFrame: o["last-frame"],
          images: o.image ?? [], videos: o.video ?? [], audios: o.audio ?? [],
        };
        const placeholder = (v) => (isLocal(v) ? `https://upload.invalid/${basename(v)}` : v);
        const preview = buildBody({ ...spec, firstFrame: spec.firstFrame && placeholder(spec.firstFrame),
          lastFrame: spec.lastFrame && placeholder(spec.lastFrame), images: spec.images.map(placeholder),
          videos: spec.videos.map(placeholder), audios: spec.audios.map(placeholder) });
        const price = cost(preview.duration, preview.resolution);
        if (o["dry-run"]) {
          say(JSON.stringify(preview, null, 2));
          note(`cost: $${price.usd.toFixed(3)} for ${price.billed_seconds} s, plus any reference-video seconds`);
          return EXIT.ok;
        }
        const up = async (v, kind) => (isLocal(v) ? api.upload(v, kind) : v);
        const body = buildBody({ ...spec,
          firstFrame: spec.firstFrame && (await up(spec.firstFrame, "image")),
          lastFrame: spec.lastFrame && (await up(spec.lastFrame, "image")),
          images: await Promise.all(spec.images.map((v) => up(v, "image"))),
          videos: await Promise.all(spec.videos.map((v) => up(v, "video"))),
          audios: await Promise.all(spec.audios.map((v) => up(v, "audio"))) });
        const bad = assetUrls(body).filter((u) => !u.startsWith("https://"));
        if (bad.length) throw new UsageError(`not uploaded: ${bad.join(", ")}`);
        const id = await api.submit(body);
        note(`submitted ${id} (${body.duration} s at ${body.resolution}, about $${price.usd.toFixed(3)})`);
        if (o.async) { emit(id, { request_id: id }); return EXIT.ok; }
        const job = await waitFor(id);
        if (!job) { emit(`still running: h3 wait ${id}`, { request_id: id, status: "pending" }); return EXIT.pending; }
        await save(id, job, o.out);
        return EXIT.ok;
      }
      case "status": {
        const id = need(rest[0], "request_id");
        const job = await api.status(id);
        emit(`${id} ${job.status}${job.progress !== undefined ? ` ${job.progress}%` : ""}`, job);
        return job.status === "failed" || job.status === "expired" ? EXIT.failed : EXIT.ok;
      }
      case "wait": {
        const id = need(rest[0], "request_id");
        const job = await waitFor(id);
        if (!job) { emit(`still running: h3 wait ${id}`, { request_id: id, status: "pending" }); return EXIT.pending; }
        await save(id, job, o.out);
        return EXIT.ok;
      }
      case "download": {
        const id = need(rest[0], "request_id");
        await save(id, null, o.out);
        return EXIT.ok;
      }
      case "upload": {
        const file = need(rest[0], "file");
        if (!["image", "video", "audio"].includes(o.kind)) throw new UsageError("--kind image|video|audio is required");
        const url = await api.upload(file, o.kind);
        emit(url, { media_url: url });
        return EXIT.ok;
      }
      case "cost": {
        const result = cost(need(o.duration, "--duration"), o.resolution ?? "768p", o["ref-video-seconds"] ?? 0);
        emit(`$${result.usd.toFixed(3)} (${result.billed_seconds} billed seconds)`, result);
        return EXIT.ok;
      }
      case "models": {
        const ids = (await api.models()).data?.map((m) => m.id) ?? [];
        emit(ids.join("\n") + (ids.includes("minimax-h3") ? "" : "\n(minimax-h3 is not listed here)"), { models: ids });
        return EXIT.ok;
      }
      default:
        throw new UsageError(`unknown command "${command}"`);
    }
  } catch (error) {
    if (error instanceof UsageError) { note(`h3: ${error.message}`); return EXIT.usage; }
    if (error instanceof ApiError) { note(`h3: ${error.message}`); return EXIT.failed; }
    throw error;
  }
}

function need(value, what) {
  if (value === undefined || value === "") throw new UsageError(`${what} is required`);
  return value;
}
