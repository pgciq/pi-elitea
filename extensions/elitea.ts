// ELITEA provider — https://next.elitea.ai
//
// Auth (env vars only — no browser SSO):
//   ELITEA_API_TOKEN  — Personal Access Token (PAT). Required.
//                       Obtain via Settings → Personal Tokens → + in the ELITEA UI.
//   ELITEA_BASE_URL   — Override instance URL. Default: https://next.elitea.ai
//   ELITEA_PROJECT_ID — Value sent as "OpenAI-Project" header. Default: "1"
//   ELITEA_MODEL      — Static fallback model id when live model discovery fails.
//
// Model discovery: GET {base}/llm/v1/models (standard OpenAI format).
// Falls back to a seed model list when discovery fails or no token is present.
//
// All models (including Claude variants) are served through ELITEA's
// OpenAI-compatible gateway — no separate Anthropic Messages routing needed.

const DEFAULT_ELITEA_URL = "https://next.elitea.ai";
const DEFAULT_PROJECT_ID = "1";

// ---------------------------------------------------------------------------
// Model-type filters — skip non-chat models (embedding / TTS / image / etc.)
// ---------------------------------------------------------------------------

const SKIP_PATTERNS = [
  /embedding/i,
  /-tts($|-)/i,
  /transcribe/i,
  /^gpt-image/i,
  /^dall-e/i,
  /^whisper/i,
];

function isChatModel(id: string) {
  return !SKIP_PATTERNS.some((p) => p.test(id));
}

// ---------------------------------------------------------------------------
// Model metadata helpers
// ---------------------------------------------------------------------------

/** True for any Claude model — covers direct IDs and AWS Bedrock prefixes:
 *  eu.anthropic.claude-*  /  bedrock/converse/eu.anthropic.claude-*  */
function isClaude(id: string) {
  return /claude/i.test(id);
}

function detectLimits(id: string) {
  if (isClaude(id))            return { contextWindow: 200_000, maxTokens: 64_000 };
  if (/gemini/.test(id))       return { contextWindow: 1_048_576, maxTokens: 65_536 };
  if (/gpt-4\.1/.test(id))     return { contextWindow: 1_048_576, maxTokens: 32_768 };
  if (/gpt-5\.[56]/.test(id))  return { contextWindow: 1_050_000, maxTokens: 128_000 };
  if (/gpt-5/.test(id))        return { contextWindow: 400_000,   maxTokens: 128_000 };
  if (/gpt-4o/.test(id))       return { contextWindow: 128_000,   maxTokens: 16_384 };
  if (/^o[134]-/.test(id))     return { contextWindow: 200_000,   maxTokens: 100_000 };
  if (/deepseek/.test(id))     return { contextWindow: 65_536,    maxTokens: 65_536 };
  if (/qwen/.test(id))         return { contextWindow: 262_144,   maxTokens: 131_072 };
  return                              { contextWindow: 128_000,   maxTokens: 4_096 };
}

function isReasoningModel(id: string) {
  return (
    isClaude(id)          ||
    /gemini/.test(id)     ||
    /gpt-5/.test(id)      ||
    /^o[134]-/.test(id)   ||
    id === "o1"           ||
    /deepseek/.test(id)
  );
}

function buildModel(id: string, label?: string) {
  const entry: any = {
    id,
    name: label || id,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    ...detectLimits(id),
  };

  if (isReasoningModel(id)) {
    entry.reasoning = true;
    entry.thinkingLevelMap = {
      off: null,
      minimal: "low",
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: "xhigh",
      max: "max",
    };
  }

  return entry;
}

// ---------------------------------------------------------------------------
// Model discovery
// ---------------------------------------------------------------------------

async function fetchEliteaModels(baseUrl: string, token: string, projectId: string) {
  const res = await fetch(`${baseUrl}/llm/v1/models`, {
    headers: {
      Authorization: `Bearer ${token}`,
      "OpenAI-Project": projectId,
    },
    redirect: "follow",
  });

  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);

  const json = await res.json();
  // Standard OpenAI: { object: "list", data: [...] }
  const list: any[] = Array.isArray(json) ? json : Array.isArray(json?.data) ? json.data : [];
  if (list.length === 0) throw new Error("empty model list");

  return list
    .filter((m) => m?.id && isChatModel(m.id))
    .map((m) => buildModel(m.id, m.name || m.display_name));
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default async function (pi) {
  const baseUrl   = (process.env.ELITEA_BASE_URL   || DEFAULT_ELITEA_URL).replace(/\/+$/, "");
  const token     =  process.env.ELITEA_API_TOKEN  || "";
  const projectId =  process.env.ELITEA_PROJECT_ID || DEFAULT_PROJECT_ID;

  // ---- Model discovery -----------------------------------------------------

  let entries: any[] = [];

  if (token) {
    try {
      entries = await fetchEliteaModels(baseUrl, token, projectId);
    } catch (error) {
      console.error(
        `[elitea] Live model discovery failed (${
          error instanceof Error ? error.message : String(error)
        }). Using seed list.`
      );
    }
  } else {
    console.error(
      "[elitea] ELITEA_API_TOKEN is not set — provider registered with seed models only.\n" +
      "         Get a PAT from: Settings → Personal Tokens → + → Generate."
    );
  }

  // ---- Fallback / seed models (matches observed live list) -----------------

  if (entries.length === 0 && process.env.ELITEA_MODEL) {
    entries = [buildModel(process.env.ELITEA_MODEL)];
  }

  if (entries.length === 0) {
    const SEED_MODELS = [
      "gpt-5.4-mini",
      "gpt-5.4",
      "gpt-5.2",
      "gpt-5-mini",
      "gpt-5.6-luna",
      "gpt-4.1",
      "gpt-4o-2024-11-20",
      "eu.anthropic.claude-sonnet-4-6",
      "eu.anthropic.claude-sonnet-5",
      "eu.anthropic.claude-haiku-4-5-20251001-v1:0",
    ];
    entries = SEED_MODELS.map((id) => buildModel(id));
  }

  // ---- Provider registration -----------------------------------------------
  //
  // apiKey resolves $ELITEA_API_TOKEN at request time → Authorization: Bearer {token}.
  // headers adds the required OpenAI-Project scoping header.

  const models = entries.map((entry) => ({
    ...entry,
    compat: { ...entry.compat, supportsReasoningEffort: true },
  }));

  pi.registerProvider("elitea", {
    name: "ELITEA",
    baseUrl: `${baseUrl}/llm/v1`,
    api: "openai-completions",
    apiKey: "$ELITEA_API_TOKEN",
    headers: {
      "OpenAI-Project": projectId,
    },
    models,
  });

  // ---- Commands ------------------------------------------------------------

  registerModelsCommand(pi, () =>
    (pi.modelRegistry?.getAvailable?.() ?? []).filter((m) => m.provider === "elitea")
  );
}

// ---------------------------------------------------------------------------
// /elitea-models — browsable model table
// ---------------------------------------------------------------------------

function fmtSize(n: number) {
  if (!n) return "—";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000)     return `${Math.round(n / 1_000)}K`;
  return String(n);
}

function buildModelsMarkdown(models: any[]) {
  const rows = [...models].sort((a, b) => a.id.localeCompare(b.id));
  const lines = [
    "# ELITEA models",
    "",
    "| Model | Reasoning | Context | Max Output |",
    "|---|---|---|---|",
    ...rows.map(
      (m) => `| ${m.id} | ${m.reasoning ? "✓" : ""} | ${fmtSize(m.contextWindow)} | ${fmtSize(m.maxTokens)} |`
    ),
  ];
  return lines.join("\n");
}

function registerModelsCommand(pi, getModels: () => any[]) {
  pi.registerCommand("elitea-models", {
    description: "List available ELITEA models with context window and reasoning info.",
    handler: async (_args, ctx) => {
      const models = getModels();
      if (models.length === 0) {
        const msg = "No ELITEA models found. Is ELITEA_API_TOKEN set?";
        if (ctx.hasUI) ctx.ui.notify(msg, "warning");
        else console.log(msg);
        return;
      }
      const markdown = buildModelsMarkdown(models);
      if (ctx.mode === "tui") {
        pi.appendEntry("elitea-models", { markdown });
      } else if (ctx.hasUI) {
        ctx.ui.notify(markdown, "info");
      } else {
        console.log(markdown);
      }
    },
  });

  try {
    const { getMarkdownTheme } = require("@earendil-works/pi-coding-agent");
    const { Markdown } = require("@earendil-works/pi-tui");
    pi.registerEntryRenderer("elitea-models", (entry) => {
      return new Markdown(entry.data.markdown, 1, 0, getMarkdownTheme());
    });
  } catch {
    // Optional TUI renderer — skip if peer dep unavailable.
  }
}
