// Thin client for the async /v1/videos protocol. `fetch` is injectable for tests.
import { readFile, stat } from "node:fs/promises";
import { extname } from "node:path";

export class ApiError extends Error {
  constructor(message, status, body) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

export const MIME = {
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
  ".mp4": "video/mp4", ".mov": "video/quicktime",
  ".mp3": "audio/mpeg", ".wav": "audio/wav",
};

export function createApi({ apiKey, baseUrl, fetchImpl = globalThis.fetch, timeoutMs = 120_000 }) {
  const base = baseUrl.replace(/\/+$/, "");

  async function call(method, path, body, { auth = true, raw = false } = {}) {
    if (auth && !apiKey) throw new ApiError("H3_API_KEY is not set", 0);
    const res = await fetchImpl(base + path, {
      method,
      headers: {
        ...(auth ? { Authorization: `Bearer ${apiKey}` } : {}),
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      const text = await res.text();
      let parsed = text;
      try { parsed = JSON.parse(text); } catch {}
      const e = parsed?.error;
      const reason = e ? [e.code, e.message].filter(Boolean).join(": ") : String(text).slice(0, 200);
      throw new ApiError(`${method} ${path} -> HTTP ${res.status}${reason ? ` ${reason}` : ""}`, res.status, parsed);
    }
    return raw ? Buffer.from(await res.arrayBuffer()) : res.json();
  }

  return {
    async submit(body) {
      const answer = await call("POST", "/videos/generations", body);
      if (!answer?.request_id) throw new ApiError("submit answered without request_id", 0, answer);
      return answer.request_id;
    },
    status: (id) => call("GET", `/videos/${encodeURIComponent(id)}`),
    content: (id) => call("GET", `/videos/${encodeURIComponent(id)}/content`, undefined, { raw: true }),
    models: () => call("GET", "/models", undefined, { auth: false }),
    async upload(path, kind) {
      const contentType = MIME[extname(path).toLowerCase()];
      if (!contentType || !contentType.startsWith(kind)) {
        throw new ApiError(`${path}: expected a ${kind} file (${Object.keys(MIME).join(" ")})`, 0);
      }
      const { size } = await stat(path);
      const ticket = await call("POST", "/media/uploads", { model: "minimax-h3", type: kind, content_type: contentType, size_bytes: size });
      const put = await fetchImpl(ticket.upload_url, {
        method: "PUT", headers: { "Content-Type": contentType }, body: await readFile(path),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!put.ok) throw new ApiError(`upload of ${path} -> HTTP ${put.status}`, put.status);
      return ticket.media_url;
    },
  };
}
