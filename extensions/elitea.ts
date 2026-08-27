// ELITEA provider — https://next.elitea.ai
//
// Auth (env vars only — no browser SSO):
//   ELITEA_API_TOKEN        — Personal Access Token (PAT). Required. https://next.elitea.ai/app/settings/tokens
//                             Obtain via Settings → Personal Tokens → + in the ELITEA UI.
//   ELITEA_BASE_URL         — Override instance URL. Default: https://next.elitea.ai
//   ELITEA_PROJECT_ID       — Value sent as "OpenAI-Project" header. Default: "1"
//   ELITEA_USAGE_PROJECT_ID — Numeric ELITEA workspace project ID (e.g. 4321). from https://next.elitea.ai/app/settings/project-general
//                             Enables rich model discovery, /elitea-usage, and status bar.
//   ELITEA_MODEL            — Static fallback model id when live model discovery fails.
//   ELITEA_OFFLINE          — Set to 1/true/yes to skip startup model discovery.
//
// Model discovery (preferred): GET {base}/api/v2/configurations/models/{project}?include_shared=true
//   → rich metadata: display_name, context_window, max_output_tokens, supports_reasoning,
//     supports_vision, low_tier / high_tier, default.
// Fallback:                    GET {base}/llm/v1/models  (standard OpenAI list)
// Usage API:                   GET {base}/api/v2/elitea_core/usage/prompt_lib/{project}/usage
//
// All models are served through ELITEA's OpenAI-compatible gateway.

const DEFAULT_ELITEA_URL = "https://next.elitea.ai";
const DEFAULT_PROJECT_ID = "1";
// Model discovery runs during extension initialization. Keep an unavailable
// network from blocking Pi startup for an unbounded amount of time.
const FETCH_TIMEOUT_MS = 5_000;

function isOfflineMode() {
  return /^(1|true|yes)$/i.test(process.env.ELITEA_OFFLINE || "");
}

function apiFetch(url: string, headers: Record<string, string>) {
  return fetch(url, {
    headers,
    redirect: "follow",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
}

// ---------------------------------------------------------------------------
// Model conversion
// ---------------------------------------------------------------------------

/** Claude models served via Bedrock need adaptive thinking, not standard enabled. */
function needsAdaptiveThinking(name: string) {
  return /claude-sonnet-5/i.test(name)
    || /claude-sonnet-4-[6-9]/i.test(name)
    || /claude-opus-4-[6-9]/i.test(name)
    || /claude-opus-5/i.test(name);
}

function modelFromConfig(item: any, baseUrl: string, projectId: string) {
  const isClaude = /claude/i.test(item.name);
  const adaptive = isClaude && needsAdaptiveThinking(item.name);

  const entry: any = {
    id:            item.name,
    name:          item.display_name || item.name,
    reasoning:     !!item.supports_reasoning,
    input:         item.supports_vision ? ["text", "image"] : ["text"],
    cost:          { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: item.context_window  ?? 128_000,
    maxTokens:     item.max_output_tokens ?? 4_096,
    _tier:         item.high_tier ? "high" : item.low_tier ? "low" : "",
    _default:      !!item.default,
  };

  if (isClaude) {
    // Route all Claude models to native Anthropic Messages protocol.
    // ELITEA accepts Authorization: Bearer at /llm/v1/messages (ignores x-api-key).
    entry.api     = "anthropic-messages";
    // pi appends /v1/messages to baseUrl, so use /llm (not /llm/v1)
    // → https://next.elitea.ai/llm/v1/messages  ✓
    entry.baseUrl = `${baseUrl}/llm`;
    entry.headers = { Authorization: "Bearer $ELITEA_API_TOKEN", "OpenAI-Project": projectId };
    entry.compat = {
      supportsEagerToolInputStreaming: false,
      ...(adaptive ? { forceAdaptiveThinking: true } : {}),
    };
  }

  if (entry.reasoning) {
    entry.thinkingLevelMap = {
      off: null, minimal: "low", low: "low",
      medium: "medium", high: "high", xhigh: "xhigh", max: "max",
    };
  }

  // Surface the deployment's real capabilities (vision / image / audio /
  // reasoning) so Pi and /elitea-capabilities reflect what it can do.
  const supportsImageGen =
    !!item.supports_image_generation ||
    /^gpt-image/i.test(item.name) ||
    /^dall-e/i.test(item.name);
  const supportsAudio = /^whisper/i.test(item.name) || /-tts/i.test(item.name) || /^tts/i.test(item.name);
  entry.capabilities = {
    tools: true,
    vision: !!item.supports_vision,
    image: supportsImageGen,
    video: !!item.supports_video,
    audio: supportsAudio,
    reasoning: !!item.supports_reasoning,
  };

  return entry;
}

// Fallback: used when configurations API is unavailable
const SKIP_PATTERNS = [/embedding/i, /-tts($|-)/i, /transcribe/i, /^gpt-image/i, /^dall-e/i, /^whisper/i];

function isChatModel(id: string) { return !SKIP_PATTERNS.some((p) => p.test(id)); }

function detectLimits(id: string) {
  if (/claude/i.test(id))        return { contextWindow: 200_000,   maxTokens: 64_000 };
  if (/gemini/.test(id))         return { contextWindow: 1_048_576, maxTokens: 65_536 };
  if (/gpt-4\.1/.test(id))       return { contextWindow: 1_048_576, maxTokens: 32_768 };
  if (/gpt-5\.[56]/.test(id))    return { contextWindow: 1_050_000, maxTokens: 128_000 };
  if (/gpt-5/.test(id))          return { contextWindow: 400_000,   maxTokens: 128_000 };
  if (/gpt-4o/.test(id))         return { contextWindow: 128_000,   maxTokens: 16_384 };
  if (/^o[134]-/.test(id))       return { contextWindow: 200_000,   maxTokens: 100_000 };
  if (/deepseek/.test(id))       return { contextWindow: 65_536,    maxTokens: 65_536 };
  return                                { contextWindow: 128_000,   maxTokens: 4_096 };
}

function modelFromId(id: string, label?: string) {
  const reasoning = /claude/i.test(id) || /gemini/.test(id) || /gpt-5/.test(id) || /^o[134]-/.test(id) || /deepseek/.test(id);
  const entry: any = {
    id, name: label || id, reasoning,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    ...detectLimits(id),
    _tier: "", _default: false,
  };
  if (reasoning) {
    entry.thinkingLevelMap = {
      off: null, minimal: "low", low: "low",
      medium: "medium", high: "high", xhigh: "xhigh", max: "max",
    };
  }
  const supportsImageGen = /^gpt-image/i.test(id) || /^dall-e/i.test(id);
  const supportsAudio = /^whisper/i.test(id) || /-tts/i.test(id);
  entry.capabilities = {
    tools: true,
    vision: false,
    image: supportsImageGen,
    video: false,
    audio: supportsAudio,
    reasoning,
  };
  return entry;
}

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------

async function fetchConfigModels(baseUrl: string, token: string, usageProjectId: string) {
  const url = `${baseUrl}/api/v2/configurations/models/${usageProjectId}?include_shared=true`;
  const res = await apiFetch(url, {
    Authorization: `Bearer ${token}`,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  const json = await res.json();
  const items: any[] = Array.isArray(json?.items) ? json.items : [];
  if (items.length === 0) throw new Error("empty model list");
  return { items, meta: json };
}

async function fetchLlmModels(baseUrl: string, token: string, projectId: string) {
  const res = await apiFetch(`${baseUrl}/llm/v1/models`, {
    Authorization: `Bearer ${token}`,
    "OpenAI-Project": projectId,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  const json = await res.json();
  const list: any[] = Array.isArray(json) ? json : Array.isArray(json?.data) ? json.data : [];
  if (list.length === 0) throw new Error("empty model list");
  return list.filter((m) => m?.id && isChatModel(m.id)).map((m) => modelFromId(m.id, m.name));
}

async function fetchUsage(baseUrl: string, token: string, usageProjectId: string, scope = "project") {
  const url = `${baseUrl}/api/v2/elitea_core/usage/prompt_lib/${usageProjectId}/usage?scope=${scope}`;
  const res = await apiFetch(url, {
    Authorization: `Bearer ${token}`,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  return res.json();
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

// Seed model list used when live discovery is unavailable (startup / offline).
function seedEntries() {
  const ids = [
    "gpt-5.4-mini", "gpt-5.4", "gpt-5.2", "gpt-5-mini", "gpt-5.6-luna",
    "gpt-4.1", "gpt-4o-2024-11-20",
    "eu.anthropic.claude-sonnet-4-6", "eu.anthropic.claude-sonnet-5",
    "eu.anthropic.claude-haiku-4-5-20251001-v1:0",
  ];
  if (process.env.ELITEA_MODEL) ids.unshift(process.env.ELITEA_MODEL);
  return ids.map((id) => modelFromId(id));
}

export default function (pi) {
  const baseUrl        = (process.env.ELITEA_BASE_URL   || DEFAULT_ELITEA_URL).replace(/\/+$/, "");
  const token          =  process.env.ELITEA_API_TOKEN  || "";
  const projectId      =  process.env.ELITEA_PROJECT_ID || DEFAULT_PROJECT_ID;
  const usageProjectId =  process.env.ELITEA_USAGE_PROJECT_ID || "";
  const offline          = isOfflineMode();

  if (!token) {
    console.log(
      "[elitea] ELITEA_API_TOKEN is not set — using seed models.\n" +
      "         Get a PAT from: Settings → Personal Tokens → + → Generate."
    );
  } else if (offline) {
    console.log("[elitea] Offline mode enabled — using seed models.");
  }

  // Initial models come from the seed list so Pi is usable immediately. Live
  // discovery (configurations API → llm/v1/models) runs in the background via
  // refreshModels and never blocks startup. `discovery` is shared with the
  // /elitea-models command so tier/default metadata stays accurate post-discovery.
  const discovery: { entries: any[]; configMeta: any } = { entries: seedEntries(), configMeta: null };

  const modelsFromEntries = (es: any[]) =>
    es.map(({ _tier, _default, ...entry }) => {
      // Claude uses anthropic-messages — don't add supportsReasoningEffort.
      if (entry.api === "anthropic-messages") return entry;
      return { ...entry, compat: { ...entry.compat, supportsReasoningEffort: true } };
    });

  pi.registerProvider("elitea", {
    name: "ELITEA",
    baseUrl: `${baseUrl}/llm/v1`,
    api: "openai-completions",
    apiKey: "$ELITEA_API_TOKEN",
    headers: { "OpenAI-Project": projectId },
    models: modelsFromEntries(discovery.entries),

    async refreshModels({ signal, stored, publish, allowNetwork, credential }) {
      const cached = Array.isArray(stored?.models) ? stored.models : undefined;
      const seed = modelsFromEntries(seedEntries());
      // Pi's cache-only startup phase, or a cancelled refresh: return what we
      // already have without touching the network.
      if (allowNetwork === false || signal?.aborted) return cached?.length ? cached : seed;

      const apiToken = credential?.key ?? token;
      if (!apiToken || offline) return cached?.length ? cached : seed;

      let entries: any[] = [];
      try {
        // Preferred: configurations API (rich metadata, accurate limits)
        if (usageProjectId) {
          const { items, meta } = await fetchConfigModels(baseUrl, apiToken, usageProjectId);
          entries = items.map((item) => modelFromConfig(item, baseUrl, projectId));
          discovery.entries = entries;
          discovery.configMeta = meta;
        }
        // Fallback: basic OpenAI list — no Claude routing / adaptive-thinking metadata
        if (entries.length === 0) {
          entries = await fetchLlmModels(baseUrl, apiToken, projectId);
          discovery.entries = entries;
        }
      } catch (err) {
        // Discovery is optional; an unavailable gateway must not make startup
        // look like a failed extension. Keep the last good list.
        console.log(`[elitea] Model discovery unavailable (${err instanceof Error ? err.message : err}); keeping previous list.`);
        entries = [];
      }

      const resolved = entries.length > 0 ? entries
        : (process.env.ELITEA_MODEL ? [modelFromId(process.env.ELITEA_MODEL)] : []);
      const out = modelsFromEntries(resolved.length > 0 ? resolved : seedEntries());
      if (out.length > 0) {
        // Persist the catalog so it survives restarts & offline starts.
        await publish({ persist: { provider: "elitea", models: out } });
        return out;
      }
      return cached?.length ? cached : seed;
    },
  });

  // ---- Commands & status bar -----------------------------------------------

  const getAuth = () => ({
    baseUrl,
    token: process.env.ELITEA_API_TOKEN || token,
    usageProjectId,
  });

  // Pass the live discovery state (updated in refreshModels) to the models command
  registerModelsCommand(pi, discovery,
    () => (pi.modelRegistry?.getAvailable?.() ?? []).filter((m) => m.provider === "elitea")
  );
  registerCapabilitiesCommand(pi);

  if (usageProjectId) {
    registerUsageCommand(pi, getAuth);
    // The status bar refreshes automatically, so keep it disabled in offline
    // mode as well. The manual /elitea-usage command remains available.
    if (!offline) registerUsageStatusBar(pi, getAuth);
  } else {
    console.log(
      "[elitea] ELITEA_USAGE_PROJECT_ID not set — /elitea-usage and status bar disabled.\n" +
      "         Set it to your numeric ELITEA project ID (e.g. ELITEA_USAGE_PROJECT_ID=1234). From https://next.elitea.ai/app/settings/project-general"
    );
  }
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function makeMarkdownRenderer(pi, key: string) {
  try {
    const { getMarkdownTheme } = require("@earendil-works/pi-coding-agent");
    const { Markdown }         = require("@earendil-works/pi-tui");
    pi.registerEntryRenderer(key, (entry) =>
      new Markdown(entry.data.markdown, 1, 0, getMarkdownTheme())
    );
  } catch { /* optional */ }
}

function notifyOrPrint(ctx, msg: string, level = "warning") {
  if (ctx.hasUI) ctx.ui.notify(msg, level);
  else           console.log(msg);
}

function outputMarkdown(pi, ctx, key: string, markdown: string) {
  if (ctx.mode === "tui") pi.appendEntry(key, { markdown });
  else if (ctx.hasUI)     ctx.ui.notify(markdown, "info");
  else                    console.log(markdown);
}

function fmtSize(n: number) {
  if (!n)           return "—";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000)     return `${Math.round(n / 1_000)}K`;
  return String(n);
}

function fmtMoney(n: any, decimals = 4) {
  return typeof n === "number" ? `$${n.toFixed(decimals)}` : "—";
}

function fmtTokens(n: any) {
  if (typeof n !== "number") return "—";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000)     return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function fmtDate(iso: string | undefined) {
  if (!iso) return "—";
  return iso.replace("T", " ").replace(/(\+\d{2}:\d{2}|Z)$/, " UTC");
}

// ---------------------------------------------------------------------------
// /elitea-capabilities — per-model capability table
// ---------------------------------------------------------------------------

function registerCapabilitiesCommand(pi) {
  const flags = {
    reasoning: "reasoning",
    vision: "vision",
    image: "image",
    video: "video",
    audio: "audio",
    tools: "tools",
  };

  pi.registerCommand("elitea-capabilities", {
    description: "List ELITEA model capabilities (vision/image/video/audio/tools/reasoning); e.g. /elitea-capabilities image",
    handler: async (args, ctx) => {
      const tokens = (args || "").trim().split(/\s+/).filter(Boolean);
      const filter = tokens.find((token) => token in flags);
      const models = (pi.modelRegistry?.getAvailable?.() ?? []).filter((m) => m.provider === "elitea");

      const rows = models
        .map((model) => {
          const caps = model.capabilities ?? {};
          return {
            id: model.id,
            reasoning: caps.reasoning ? "✓" : "",
            vision: caps.vision ? "✓" : "",
            image: caps.image ? "✓" : "",
            video: caps.video ? "✓" : "",
            audio: caps.audio ? "✓" : "",
            tools: caps.tools ? "✓" : "",
          };
        })
        .filter((row) => !filter || row[flags[filter]] === "✓")
        .sort((a, b) => a.id.localeCompare(b.id));

      const markdown = [
        `# ELITEA model capabilities${filter ? ` (filter: ${filter})` : ""}`,
        "",
        "| Model | Reasoning | Vision | Image | Video | Audio | Tools |",
        "|---|:---:|:---:|:---:|:---:|:---:|:---:|",
        ...rows.map(
          (row) =>
            `| ${row.id} | ${row.reasoning || "—"} | ${row.vision || "—"} | ${row.image || "—"} | ${row.video || "—"} | ${row.audio || "—"} | ${row.tools || "—"} |`,
        ),
        "",
        "_Capabilities are read from each model's ELITEA metadata (supports_reasoning / supports_vision / supports_image_generation / naming patterns)._",
      ].join("\n");

      outputMarkdown(pi, ctx, "elitea-capabilities", markdown);
    },
  });
  makeMarkdownRenderer(pi, "elitea-capabilities");
}

// ---------------------------------------------------------------------------
// /elitea-models — full model table with tier/vision/default info
// ---------------------------------------------------------------------------

function registerModelsCommand(pi, discovery: { entries: any[]; configMeta: any }, getRegistered: () => any[]) {
  pi.registerCommand("elitea-models", {
    description: "List available ELITEA models with metadata (tier, vision, context window).",
    handler: async (_args, ctx) => {
      // Prefer the live registry (post-startup), fall back to the entries
      // captured by the factory / refreshed in refreshModels.
      const live = getRegistered();
      const rows = (live.length > 0 ? live : discovery.entries)
        .slice()
        .sort((a, b) => a.id.localeCompare(b.id));

      // Build a lookup for tier/default/vision from the captured entries
      const meta: Record<string, any> = {};
      for (const e of discovery.entries) meta[e.id] = e;

      const lines = [
        "# ELITEA models",
        "",
      ];

      if (discovery.configMeta?.default_model_name) {
        lines.push(
          `_Default: **${discovery.configMeta.default_model_name}** · ` +
          `Low-tier default: **${discovery.configMeta.low_tier_default_model_name ?? "—"}** · ` +
          `High-tier default: **${discovery.configMeta.high_tier_default_model_name ?? "—"}**_`,
          ""
        );
      }

      lines.push(
        "| Model | Display Name | Reasoning | Vision | Tier | Context | Max Out |",
        "|---|---|---|---|---|---|---|",
        ...rows.map((m) => {
          const extra  = meta[m.id] ?? m;
          const tier   = extra._tier    ?? "";
          const def    = extra._default ?? false;
          const vision = (extra.input ?? m.input ?? []).includes("image");
          const nameCell = def ? `**${m.name || m.id}** ⭐` : (m.name || m.id);
          return `| \`${m.id}\` | ${nameCell} | ${m.reasoning ? "✓" : ""} | ${vision ? "✓" : ""} | ${tier} | ${fmtSize(m.contextWindow)} | ${fmtSize(m.maxTokens)} |`;
        })
      );

      outputMarkdown(pi, ctx, "elitea-models", lines.join("\n"));
    },
  });
  makeMarkdownRenderer(pi, "elitea-models");
}

// ---------------------------------------------------------------------------
// /elitea-usage [project|user] [YYYYMM]
// ---------------------------------------------------------------------------

function buildUsageMarkdown(d: any) {
  const hasLimit  = typeof d.effective_limit === "number";
  const pctStr    = hasLimit && d.effective_limit > 0
    ? `${((d.spend / d.effective_limit) * 100).toFixed(1)}%`
    : "—";
  const warnStr   = d.warning_pct ? `${d.warning_pct}%` : "80%";

  const lines: string[] = [
    `# ELITEA Usage — ${d.period_start ?? "?"} → ${d.period_end ?? "?"}`,
    `_scope: **${d.scope}** · resets at ${fmtDate(d.resets_at)}_`,
    "",
    "## Summary",
    "",
    "| | |",
    "|---|---|",
    `| **Spend** | ${fmtMoney(d.spend)} |`,
    `| **Limit** | ${hasLimit ? fmtMoney(d.effective_limit) : "unlimited"} |`,
    `| **Remaining** | ${hasLimit ? fmtMoney(d.remaining) : "—"} |`,
    `| **Used** | ${pctStr}${hasLimit ? ` (warn at ${warnStr})` : ""} |`,
    `| **Requests** | ${d.api_requests ?? "—"} |`,
    "",
    "## Tokens",
    "",
    "| | |",
    "|---|---|",
    `| **Total** | ${fmtTokens(d.total_tokens)} |`,
    `| **Input** | ${fmtTokens(d.input_tokens)} |`,
    `| **Output** | ${fmtTokens(d.output_tokens)} |`,
    `| **Cache Read** | ${fmtTokens(d.cache_read_tokens)} |`,
    `| **Cache Write** | ${fmtTokens(d.cache_creation_tokens)} |`,
  ];

  if (Array.isArray(d.models) && d.models.length > 0) {
    lines.push(
      "", "## By Model", "",
      "| Model | Spend | Tokens | Requests |",
      "|---|---|---|---|",
      ...d.models
        .slice()
        .sort((a, b) => (b.spend ?? 0) - (a.spend ?? 0))
        .map((m) =>
          `| ${m.display_name || m.model} | ${fmtMoney(m.spend)} | ${fmtTokens(m.total_tokens)} | ${m.api_requests ?? "—"} |`
        )
    );
  }

  if (Array.isArray(d.daily) && d.daily.length > 0) {
    lines.push(
      "", "## Daily", "",
      "| Date | Spend | Tokens | In | Out | Requests |",
      "|---|---|---|---|---|---|",
      ...d.daily
        .slice()
        .sort((a, b) => a.date.localeCompare(b.date))
        .map((r) =>
          `| ${r.date} | ${fmtMoney(r.spend)} | ${fmtTokens(r.total_tokens)} | ${fmtTokens(r.input_tokens)} | ${fmtTokens(r.output_tokens)} | ${r.api_requests ?? "—"} |`
        )
    );
  }

  return lines.join("\n");
}

function registerUsageCommand(pi, getAuth: () => { baseUrl: string; token: string; usageProjectId: string }) {
  pi.registerCommand("elitea-usage", {
    description: "Show ELITEA usage/spend for this month. Args: [project|user] [YYYYMM]",
    getArgumentCompletions(prefix: string) {
      return [
        { value: "project", label: "project — whole project usage" },
        { value: "user",    label: "user    — your personal usage" },
      ].filter((o) => o.value.startsWith(prefix));
    },
    handler: async (args, ctx) => {
      const { baseUrl, token, usageProjectId } = getAuth();
      if (!token || !usageProjectId) {
        notifyOrPrint(ctx, "ELITEA_API_TOKEN or ELITEA_USAGE_PROJECT_ID not set.");
        return;
      }
      const parts   = (args || "").trim().split(/\s+/).filter(Boolean);
      const scope   = parts.find((p) => p === "user" || p === "project") ?? "project";
      const period  = parts.find((p) => /^\d{6}$/.test(p));

      let url = `${baseUrl}/api/v2/elitea_core/usage/prompt_lib/${usageProjectId}/usage?scope=${scope}`;
      if (period) url += `&period=${period}`;

      let data: any;
      try {
        const res = await apiFetch(url, {
          Authorization: `Bearer ${token}`,
        });
        if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
        data = await res.json();
      } catch (err) {
        notifyOrPrint(ctx, `Failed to fetch ELITEA usage: ${err instanceof Error ? err.message : String(err)}`);
        return;
      }

      outputMarkdown(pi, ctx, "elitea-usage", buildUsageMarkdown(data));
    },
  });
  makeMarkdownRenderer(pi, "elitea-usage");
}

// ---------------------------------------------------------------------------
// Status bar — compact spend / token indicator, refreshed every 10 min
// ---------------------------------------------------------------------------

const STATUS_KEY           = "elitea-usage";
const REFRESH_INTERVAL_MS  = 10 * 60 * 1_000;

function buildStatusText(d: any, theme: any): string | undefined {
  if (typeof d.spend !== "number") return undefined;
  const spend = `$${d.spend.toFixed(4)}`;

  let text: string;
  if (typeof d.effective_limit === "number" && d.effective_limit > 0) {
    const pct   = (d.spend / d.effective_limit) * 100;
    text        = `💰 ${spend}/${fmtMoney(d.effective_limit)} (${pct.toFixed(1)}%)`;
    const color = pct >= 90 ? "error" : pct >= (d.warning_pct ?? 80) ? "warning" : "dim";
    return theme?.fg(color, text) ?? text;
  }

  const tokens = typeof d.total_tokens === "number" ? ` | ${fmtTokens(d.total_tokens)} tok` : "";
  text = `💰 ${spend}${tokens}`;
  return theme?.fg("dim", text) ?? text;
}

function registerUsageStatusBar(pi, getAuth: () => { baseUrl: string; token: string; usageProjectId: string }) {
  let timer:    any;
  let inFlight: boolean = false;
  let active:   boolean = false;

  const isElitea = (model: any) => model?.provider === "elitea";

  async function refresh(ctx: any) {
    if (!active || inFlight) return;
    const { baseUrl, token, usageProjectId } = getAuth();
    if (!token || !usageProjectId) return;
    inFlight = true;
    try {
      const data   = await fetchUsage(baseUrl, token, usageProjectId, "project");
      const status = buildStatusText(data, ctx.ui?.theme);
      if (status) ctx.ui.setStatus(STATUS_KEY, status);
    } catch { /* best-effort */ }
    finally { inFlight = false; }
  }

  function setActive(now: boolean, ctx: any) {
    if (active === now) return;
    active = now;
    if (active) refresh(ctx); else ctx.ui.setStatus(STATUS_KEY, undefined);
  }

  pi.on("session_start",    (_, ctx)     => {
    active = isElitea(ctx.model);
    if (active) refresh(ctx);
    if (timer) clearInterval(timer);
    timer = setInterval(() => refresh(ctx), REFRESH_INTERVAL_MS);
  });
  pi.on("model_select",     (event, ctx) => setActive(isElitea(event.model), ctx));
  pi.on("session_shutdown", ()           => { if (timer) { clearInterval(timer); timer = undefined; } });
}
