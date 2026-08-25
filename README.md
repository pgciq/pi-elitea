# pi-elitea

Pi extension for the [ELITEA](https://next.elitea.ai) enterprise AI gateway.

- **Dynamic model discovery** via `GET {base}/llm/v1/models` — all deployed models load automatically.
- **PAT auth** — Personal Access Token, no browser SSO required.
- **`OpenAI-Project` header** — project scoping baked in.
- **Protocol routing** — Claude models use native Anthropic Messages, everything else uses OpenAI Chat Completions.

## Install

### From npm (recommended)
```bash
pi install npm:pi-elitea
```

### From git
```bash
pi install git:github.com/pgciq/pi-elitea
```

### Local path
```bash
pi install /path/to/pi-elitea
```

## Configuration

### 1 — Get a PAT

In the ELITEA UI: **Settings → Personal Tokens → + → name it → set expiration → Generate → copy immediately** (shown only once).

### 2 — Set environment variables

| Variable | Description |
|---|---|
| `ELITEA_API_TOKEN` | **Required.** Personal Access Token (PAT). |
| `ELITEA_BASE_URL` | Override instance URL. Default: `https://next.elitea.ai`. |
| `ELITEA_PROJECT_ID` | Value sent as `OpenAI-Project` header. Default: `"1"`. |
| `ELITEA_MODEL` | Static fallback model id when live model discovery fails. |

```bash
# ~/.bashrc / ~/.zshrc / Windows environment
export ELITEA_API_TOKEN="your-pat-here"
export ELITEA_PROJECT_ID="5868"      # optional, defaults to "1"
```

## Usage

```bash
# OpenAI-compatible models
pi --model elitea/gpt-5.4-mini "hello"
pi --model elitea/gemini-2.5-flash "explain recursion"

# Claude models (native Anthropic Messages)
pi --model elitea/claude-sonnet-4-5 "write a haiku about recursion"
```

## Commands

| Command | Description |
|---|---|
| `/elitea-models` | List all available ELITEA models with context window and reasoning capability. |

```bash
/elitea-models
```

## Provider

| Provider ID | Base URL | Auth |
|---|---|---|
| `elitea` | `{ELITEA_BASE_URL}/llm/v1` | `Authorization: Bearer $ELITEA_API_TOKEN` + `OpenAI-Project: $ELITEA_PROJECT_ID` |

Non-Claude models use OpenAI Chat Completions. Claude models use native Anthropic Messages at `{base}/llm`.

## License

MIT
