# pi-elitea

Pi extension for the [ELITEA](https://next.elitea.ai) enterprise AI gateway.

- **Rich model discovery** via `GET /api/v2/configurations/models/{project}` — accurate context windows, vision/reasoning flags, tier info.
- **PAT auth** — Personal Access Token, no browser SSO required.
- **`OpenAI-Project` header** — project scoping baked in.
- **`/elitea-usage`** — monthly spend, token breakdown, per-model and daily tables.
- **Status bar** — live `💰 $spend | Xk tok` indicator while an ELITEA model is active.
- **Offline-safe startup** — model discovery has a timeout and can be disabled with `ELITEA_OFFLINE=1`.

## Install

```bash
pi install npm:pi-elitea
```

## Configuration

### 1 — Get a PAT

**Settings → Personal Tokens → + → name → expiration → Generate → copy** (shown once).

### 2 — Environment variables

| Variable | Description |
|---|---|
| `ELITEA_API_TOKEN` | **Required.** Personal Access Token. https://next.elitea.ai/app/settings/tokens |
| `ELITEA_USAGE_PROJECT_ID` | **Recommended.** Numeric ELITEA project ID (e.g. `4321`). Enables rich model discovery, https://next.elitea.ai/app/settings/project-general `/elitea-usage`, and the status bar. |
| `ELITEA_BASE_URL` | Override instance URL. Default: `https://next.elitea.ai`. |
| `ELITEA_PROJECT_ID` | `OpenAI-Project` header value. Default: `"1"`. |
| `ELITEA_MODEL` | Static fallback model id when discovery fails. |
| `ELITEA_OFFLINE` | Set to `1`/`true` to skip startup model discovery and use seed models. |

```bash
export ELITEA_API_TOKEN="your-pat-here" # https://next.elitea.ai/app/settings/tokens
export ELITEA_USAGE_PROJECT_ID="4321"   # your ELITEA workspace project ID, https://next.elitea.ai/app/settings/project-general

# Optional: use seed/static models without contacting ELITEA during startup
export ELITEA_OFFLINE="1"
```

## Usage

```bash
pi --model elitea/gpt-5.4-mini    "hello"
pi --model elitea/gpt-5.6-luna    "explain recursion"
pi --model elitea/eu.anthropic.claude-sonnet-5  "write a haiku"
```

## Model discovery (non-blocking)

`pi-elitea` registers a **seed** model list synchronously at load (so pi starts instantly) and refreshes the full catalog **in the background** via pi's `refreshModels` callback — it never blocks startup on `GET /api/v2/configurations/models/{project}` or the LLM models endpoint.

- The seed list is always available immediately, even offline or without `ELITEA_USAGE_PROJECT_ID`.
- Background discovery (rich metadata: context window, vision/reasoning flags, tier) replaces the seed list once the API responds; the result is persisted to pi's provider cache so it survives restarts.
- Every network call is bounded by a timeout and degrades to the seed list on any failure. Discovery can be skipped entirely with `ELITEA_OFFLINE=1`.

### Image generation

ELITEA exposes `gpt-image-1.5` through `POST /llm/v1/images/generations` (not chat completions). The extension supplements the rich configuration catalog with image models from `/llm/v1/models`, calls the verified image endpoint, saves results under `.pi/generated-images/`, reports the saved path as a clickable `file://` link in the TUI, and adds a TUI-only `Image` entry for supported terminals. Print/RPC mode reports the saved path as plain text.

The standard model catalog also advertises `gpt-4o-mini-transcribe` (ASR) and `gpt-4o-mini-tts` (TTS). The corresponding OpenAI-compatible paths are `/llm/v1/audio/transcriptions` and `/llm/v1/audio/speech`; requests with the current workspace token returned `403 Forbidden`, so ASR/TTS remain discovery-only until endpoint access is confirmed.

## Commands

| Command | Description |
|---|---|
| `/elitea-models` | Full model table: display name, reasoning, vision, tier, context window, max output. |
| `/elitea-capabilities [image\|video\|audio\|vision\|reasoning\|tools]` | List each ELITEA model's capabilities (vision / image / video / audio / tools / reasoning) read from its metadata; an optional filter narrows the table. |
| `/elitea-usage [project\|user] [YYYYMM]` | Monthly spend, token breakdown, per-model and daily tables. |

```bash
/elitea-models
/elitea-capabilities image     # only image-generation models

/elitea-usage                  # project scope, current month
/elitea-usage user             # your personal usage
/elitea-usage project 202607   # project usage for a past month
```

## Status Bar

While an `elitea/*` model is active, the footer shows a live spend indicator refreshed every 10 minutes:

- **With limit:** `💰 $0.0223/$50.00 (0.0%)`
- **Unlimited:** `💰 $0.0223 | 35.6K tok`

## Provider

| Provider ID | Base URL | Auth |
|---|---|---|
| `elitea` | `{ELITEA_BASE_URL}/llm/v1` | `Authorization: Bearer $ELITEA_API_TOKEN` + `OpenAI-Project: {id}` |

## Development

```bash
npm version patch   # or minor / major
git push && git push --tags
```

## License

MIT
