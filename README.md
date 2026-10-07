# MiniMax H3 CLI — generate MiniMax H3 videos from the terminal

`h3` is an unofficial, zero-dependency Node.js command line for the MiniMax H3 video model: one command uploads your local frames and references, submits the job, waits and saves the MP4. It talks to any server that implements the async `/v1/videos` API and defaults to [ArgoLink](https://argolink.io/gh-minimax-h3-cli), where MiniMax H3 costs $0.039/s at 768p and $0.064/s at 2K.

Not affiliated with MiniMax. MiniMax's own CLI is [`mmx`](https://github.com/MiniMax-AI/cli); see [h3 or mmx?](#h3-or-mmx).

[Install](#install) · [Quick start](#quick-start) · [Commands](#commands) · [Modes](#one-command-per-mode) · [Scripting](#scripting) · [Prices](#what-it-costs) · [FAQ](#faq)

<sub>Last checked: 2026-10-07 (model limits from the MiniMax H3 model page, prices from the pages linked below).</sub>

## Install

Node.js 18.3 or newer. No dependencies.

```bash
npm install -g github:harlowprewitt7/minimax-h3-cli    # puts `h3` on your PATH
# or run it from a checkout
git clone https://github.com/harlowprewitt7/minimax-h3-cli && cd minimax-h3-cli && ./bin/h3.mjs --help
```

## Quick start

```bash
export H3_API_KEY=your-key            # an ArgoLink API key
h3 generate "A heron lands on a misty pond at dawn, slow motion" --duration 6 --out heron.mp4
```

The output has this shape:

```text
submitted <request_id> (6 s at 768p, about $0.234)
<request_id> pending 37%, ~128s left
saved heron.mp4 (billed 6 s)
```

Add `--dry-run` to print the exact request body and its price without sending anything.

## Commands

| Command | What it does | API calls |
|---|---|---|
| `h3 generate "prompt" [options]` | validate, upload local files, submit, wait, download | `POST /media/uploads` (per local file), `POST /videos/generations`, `GET /videos/{id}` …, `GET /videos/{id}/content` |
| `h3 status <id>` | one status read | `GET /videos/{id}` |
| `h3 wait <id> [--out FILE]` | poll until done, then download | `GET /videos/{id}` …, `/content` |
| `h3 download <id> [--out FILE]` | save a finished MP4 | `GET /videos/{id}/content` |
| `h3 upload <file> --kind image\|video\|audio` | print a `media_url` (valid seven days) | `POST /media/uploads`, signed `PUT` |
| `h3 cost --duration N [--resolution R] [--ref-video-seconds S]` | price a job offline | none |
| `h3 models` | list the model IDs the server sells (no key needed) | `GET /models` |

`generate` options:

| Option | Values | Default |
|---|---|---|
| `--duration` | 4–15 whole seconds | 5 |
| `--resolution` | `768p`, `2k` (nothing else exists for H3) | `768p` |
| `--ratio` | `21:9` `16:9` `4:3` `1:1` `3:4` `9:16`; `adaptive` with references | `16:9` |
| `--first-frame`, `--last-frame` | JPEG/PNG path or https URL | — |
| `--image`, `--video`, `--audio` | repeatable references: ≤ 9 images, ≤ 3 clips, ≤ 3 tracks, ≤ 12 in all | — |
| `--out` | output file | `h3-<request_id>.mp4` |
| `--async` | print the request ID and exit | off |
| `--timeout` | stop waiting after N seconds (the job keeps running) | none |
| `--json` | one JSON object on stdout | off |

Environment:

| Variable | Meaning |
|---|---|
| `H3_API_KEY` | Bearer key; required by every command except `cost` and `models` |
| `H3_BASE_URL` | API root, default `https://argolink.io/v1` |
| `H3_POLL_SECONDS` | seconds between status reads, default 10 |

Exit codes: `0` done, `1` API error or the job `failed` / `expired`, `2` invalid arguments (nothing was sent), `3` still pending when `--timeout` ran out.

## One command per mode

```bash
# Text to video, 2K ultrawide
h3 generate "Drone shot over terraced rice fields after rain, mist in the valleys" --resolution 2k --ratio 21:9 --duration 8

# First frame: the still sets the shape, so no --ratio
h3 generate "The portrait turns its head and smiles, hair moving in a breeze" --first-frame ./portrait.png

# First and last frame
h3 generate "The bare tree blossoms as the seasons pass" --first-frame winter.png --last-frame spring.png --duration 10

# References: name them @Image 1, @Video 1, @Audio 1 in the prompt
h3 generate "The robot in @Image 1 dances like @Video 1 to the beat of @Audio 1" \
  --image robot.png --video moves-6s.mp4 --audio beat.mp3 --duration 10
```

Local paths are uploaded through the free media-upload ticket first; https URLs are passed through. Reference clips and tracks must run 2–15 s each and 15 s in total per kind; images are JPEG or PNG up to 20 MiB, clips MP4 or MOV up to 100 MiB, audio WAV or MP3 up to 15 MB.

## Scripting

```bash
# Fire off a batch without waiting, then collect the results
while IFS= read -r prompt; do
  h3 generate "$prompt" --duration 5 --async --json | jq -r .request_id >> jobs.txt
done < prompts.txt
while IFS= read -r id; do h3 wait "$id" --out "$id.mp4"; done < jobs.txt

# Budget check before a run
h3 cost --duration 8 --resolution 2k --ref-video-seconds 5    # $0.832 (13 billed seconds)
```

A submit is never repeated automatically. If a network error hides the answer to `generate`, look for the job before resubmitting; a failed job's message ends with `(safe to resubmit)` when the API marks it retryable.

## What it costs

`h3 cost` uses the ArgoLink rates; billed seconds are the output length plus the reference clips' total length (fraction dropped). Reference images and audio are free, and failed or expired jobs are not billed.

| Provider | 768p per second | 2K per second | 6 s at 768p |
|---|---:|---:|---:|
| **[ArgoLink](https://argolink.io/en/models/minimax-h3)** | **$0.039** | **$0.064** | **$0.234** |
| [MiniMax pay-as-you-go](https://platform.minimax.io/docs/guides/pricing-paygo) | $0.08 | $0.13 | $0.48 |
| [fal.ai](https://fal.ai/models/minimax/h3/text-to-video) | $0.06 | $0.13 | $0.36 |
| [Replicate](https://replicate.com/minimax/h3) | $0.08 | $0.13 | $0.48 |

<sub>All pages read 2026-10-07.</sub>

## h3 or mmx?

| | `h3` (this repo) | `mmx` (MiniMax's official CLI) |
|---|---|---|
| Install | `npm install -g github:harlowprewitt7/minimax-h3-cli` | `npm install -g mmx-cli` |
| Talks to | any `/v1/videos` server; default ArgoLink | MiniMax's own API (`api.minimax.io`, `api.minimaxi.com`) |
| Account | an API key for that server | a MiniMax account; its README states it requires a MiniMax Token Plan |
| H3 calls | `POST /v1/videos/generations`, `GET /v1/videos/{id}` | `POST /v2/video_generation`, `GET /v2/query/video_generation/{task_id}` |
| Scope | MiniMax H3 video only | text, image, video, speech, vision, search |

`mmx` honors `MINIMAX_BASE_URL`, but it still calls MiniMax's own paths, so it cannot drive a `/v1/videos` server; and `h3` cannot drive MiniMax's task API. (mmx source checked 2026-10-07: `src/client/endpoints.ts`.)

## FAQ

**Why does `--resolution 720p` fail?**
MiniMax H3 renders two tiers, 768p and 2K. `h3` stops the request locally with exit code 2, before the API would return 400.

**Why is `--audio` alone rejected?**
On MiniMax H3 an audio reference needs at least one reference image or clip beside it.

**Can I get a silent file?**
The model always adds a stereo soundtrack. Remove it after download: `ffmpeg -i in.mp4 -an -c:v copy out.mp4`.

**Where does a long job go if I hit Ctrl-C?**
It keeps running on the server. Copy the request ID from the first line and run `h3 wait <id>` later.

**Does `h3` work with other models?**
It is written for `minimax-h3` and enforces that model's limits. For a generic tool, any MCP client or a plain `curl` against `/v1/videos/generations` works with other model IDs.

## Development

```bash
npm test     # node --test: a fake fetch stands in for the API, no key or network needed
```

## License

MIT
