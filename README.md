# pi-elitea

Pi extension for the [ELITEA](https://next.elitea.ai) enterprise AI gateway.

- **Rich model discovery** via `GET /api/v2/configurations/models/{project}` — accurate context windows, vision/reasoning flags, tier info.
- **PAT auth** — Personal Access Token, no browser SSO required.
- **`OpenAI-Project` header** — project scoping baked in.
- **`/elitea-usage`** — monthly spend, token breakdown, per-model and daily tables.
- **Status bar** — live `💰 $spend | Xk tok` indicator while an ELITEA model is active.

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
| `ELITEA_API_TOKEN` | **Required.** Personal Access Token. |
| `ELITEA_USAGE_PROJECT_ID` | **Recommended.** Numeric ELITEA project ID (e.g. `5868`). Enables rich model discovery, `/elitea-usage`, and the status bar. |
| `ELITEA_BASE_URL` | Override instance URL. Default: `https://next.elitea.ai`. |
| `ELITEA_PROJECT_ID` | `OpenAI-Project` header value. Default: `"1"`. |
| `ELITEA_MODEL` | Static fallback model id when discovery fails. |

```bash
export ELITEA_API_TOKEN="your-pat-here"
export ELITEA_USAGE_PROJECT_ID="5868"   # your ELITEA workspace project ID
```

## Usage

```bash
pi --model elitea/gpt-5.4-mini    "hello"
pi --model elitea/gpt-5.6-luna    "explain recursion"
pi --model elitea/eu.anthropic.claude-sonnet-5  "write a haiku"
```

## Commands

| Command | Description |
|---|---|
| `/elitea-models` | Full model table: display name, reasoning, vision, tier, context window, max output. |
| `/elitea-usage [project\|user] [YYYYMM]` | Monthly spend, token breakdown, per-model and daily tables. |

```bash
/elitea-models

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
