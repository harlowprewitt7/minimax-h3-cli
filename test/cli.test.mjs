// Drives main() with a fake fetch: no key, network or money involved.
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { main } from "../lib/cli.mjs";
import { buildBody, cost } from "../lib/request.mjs";

function sink() {
  const s = { text: "", write(chunk) { s.text += chunk; return true; } };
  return s;
}

function fakeApi(statuses = [{ status: "done", progress: 100, usage: { billed_seconds: 6 } }]) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, method: init.method ?? "GET", headers: init.headers ?? {}, body: init.body });
    const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
    if (url.endsWith("/videos/generations")) return json(202, { request_id: "vid_1" });
    if (url.endsWith("/videos/vid_1")) return json(200, statuses.shift());
    if (url.endsWith("/videos/vid_1/content")) return new Response("MP4!", { status: 200 });
    if (url.endsWith("/media/uploads")) return json(200, { upload_url: "https://bucket.test/put", media_url: "https://cdn.test/face.png" });
    if (url === "https://bucket.test/put") return new Response("", { status: 200 });
    if (url.endsWith("/models")) return json(200, { object: "list", data: [{ id: "minimax-h3" }, { id: "wan-3" }] });
    return json(404, { error: { code: "not_found" } });
  };
  return { calls, fetchImpl };
}

async function run(argv, fetchImpl, env = { H3_API_KEY: "k" }) {
  const stdout = sink(), stderr = sink();
  const code = await main(argv, { stdout, stderr, env, fetchImpl, sleep: async () => {} });
  return { code, out: stdout.text, err: stderr.text };
}

test("dry run prints the body and the price without any request", async () => {
  const { calls, fetchImpl } = fakeApi();
  const r = await run(["generate", "A heron lands on a misty pond", "--duration", "10", "--resolution", "2k", "--dry-run"], fetchImpl);
  assert.equal(r.code, 0);
  assert.deepEqual(JSON.parse(r.out), { model: "minimax-h3", prompt: "A heron lands on a misty pond", duration: 10,
    resolution: "2k", aspect_ratio: "16:9" });
  assert.match(r.err, /\$0\.640/);
  assert.equal(calls.length, 0);
});

test("generate uploads local files, submits, polls and saves", async () => {
  const dir = await mkdtemp(join(tmpdir(), "h3-"));
  const face = join(dir, "face.png");
  await writeFile(face, "PNG");
  const out = join(dir, "clip.mp4");
  const { calls, fetchImpl } = fakeApi([{ status: "pending", progress: 50 }, { status: "done", usage: { billed_seconds: 6 } }]);
  const r = await run(["generate", "@Image 1 smiles", "--image", face, "--duration", "6", "--out", out], fetchImpl);
  assert.equal(r.code, 0, r.err);
  assert.equal(await readFile(out, "utf8"), "MP4!");
  assert.deepEqual(calls.map((c) => c.method + " " + c.url.replace("https://argolink.io/v1", "")), [
    "POST /media/uploads", "PUT https://bucket.test/put", "POST /videos/generations",
    "GET /videos/vid_1", "GET /videos/vid_1", "GET /videos/vid_1/content"]);
  assert.equal(calls[1].headers.Authorization, undefined);
  assert.equal(calls[2].headers.Authorization, "Bearer k");
  assert.deepEqual(JSON.parse(calls[2].body).reference_images, [{ url: "https://cdn.test/face.png" }]);
  assert.match(r.out, /billed 6 s/);
});

test("model rules are enforced before anything is sent", async () => {
  const { calls, fetchImpl } = fakeApi();
  for (const argv of [
    ["generate", "x", "--resolution", "720p"],
    ["generate", "x", "--duration", "16"],
    ["generate", "x", "--audio", "https://a.test/beat.mp3"],
    ["generate", "x", "--first-frame", "https://a.test/f.png", "--image", "https://a.test/i.png"],
    ["generate", "x", "--first-frame", "https://a.test/f.png", "--ratio", "16:9"],
    ["generate", "x", "--ratio", "adaptive"],
  ]) {
    const r = await run(argv, fetchImpl);
    assert.equal(r.code, 2, `${argv.join(" ")} -> ${r.err}`);
  }
  assert.equal(calls.length, 0);
});

test("failed jobs exit 1 and say whether a retry is safe", async () => {
  const { fetchImpl } = fakeApi([{ status: "failed", error: { code: "capacity_unavailable", retryable: true } }]);
  const r = await run(["wait", "vid_1"], fetchImpl);
  assert.equal(r.code, 1);
  assert.match(r.err, /capacity_unavailable.*safe to resubmit/);
});

test("--async prints the id; --timeout leaves the job running with exit 3", async () => {
  let api = fakeApi();
  let r = await run(["generate", "x", "--async", "--json"], api.fetchImpl);
  assert.deepEqual(JSON.parse(r.out), { request_id: "vid_1" });
  api = fakeApi([{ status: "pending", progress: 1 }]);
  r = await run(["wait", "vid_1", "--timeout", "0"], api.fetchImpl);
  assert.equal(r.code, 3);
});

test("cost, models and missing key", async () => {
  const { fetchImpl } = fakeApi();
  assert.match((await run(["cost", "--duration", "8", "--ref-video-seconds", "5.9"], fetchImpl)).out, /\$0\.507 \(13 billed/);
  assert.match((await run(["models"], fetchImpl, {})).out, /minimax-h3/);
  const noKey = await run(["status", "vid_1"], fetchImpl, {});
  assert.equal(noKey.code, 1);
  assert.match(noKey.err, /H3_API_KEY/);
});

test("request rules match the model page", () => {
  assert.equal(buildBody({ prompt: "x", firstFrame: "https://a.test/1.png", lastFrame: "https://a.test/2.png" }).aspect_ratio, "adaptive");
  assert.equal(buildBody({ prompt: "x", videos: ["https://a.test/v.mp4"], ratio: "adaptive" }).aspect_ratio, "adaptive");
  assert.deepEqual(cost(15, "2k"), { billed_seconds: 15, usd: 0.96 });
});
