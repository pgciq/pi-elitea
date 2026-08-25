// ELITEA provider — https://next.elitea.ai
//
// Auth (env vars only — no browser SSO):
//   ELITEA_API_TOKEN        — Personal Access Token (PAT). Required.
//                             Obtain via Settings → Personal Tokens → + in the ELITEA UI.
//   ELITEA_BASE_URL         — Override instance URL. Default: https://next.elitea.ai
//   ELITEA_PROJECT_ID       — Value sent as "OpenAI-Project" header. Default: "1"
//   ELITEA_USAGE_PROJECT_ID — Numeric ELITEA workspace project ID (e.g. 5868).
//                             Enables rich model discovery, /elitea-usage, and status bar.
//   ELITEA_MODEL            — Static fallback model id when live model discovery fails.
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
  return entry;
}

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------

async function fetchConfigModels(baseUrl: string, token: string, usageProjectId: string) {
  const url = `${baseUrl}/api/v2/configurations/models/${usageProjectId}?include_shared=true`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  const json = await res.json();
  const items: any[] = Array.isArray(json?.items) ? json.items : [];
  if (items.length === 0) throw new Error("empty model list");
  return { items, meta: json };
}

async function fetchLlmModels(baseUrl: string, token: string, projectId: string) {
  const res = await fetch(`${baseUrl}/llm/v1/models`, {
    headers: { Authorization: `Bearer ${token}`, "OpenAI-Project": projectId },
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  const json = await res.json();
  const list: any[] = Array.isArray(json) ? json : Array.isArray(json?.data) ? json.data : [];
  if (list.length === 0) throw new Error("empty model list");
  return list.filter((m) => m?.id && isChatModel(m.id)).map((m) => modelFromId(m.id, m.name));
}

async function fetchUsage(baseUrl: string, token: string, usageProjectId: string, scope = "project") {
  const url = `${baseUrl}/api/v2/elitea_core/usage/prompt_lib/${usageProjectId}/usage?scope=${scope}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  return res.json();
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default async function (pi) {
  const baseUrl        = (process.env.ELITEA_BASE_URL   || DEFAULT_ELITEA_URL).replace(/\/+$/, "");
  const token          =  process.env.ELITEA_API_TOKEN  || "";
  const projectId      =  process.env.ELITEA_PROJECT_ID || DEFAULT_PROJECT_ID;
  const usageProjectId =  process.env.ELITEA_USAGE_PROJECT_ID || "";

  // ---- Model discovery (rich → fallback → seed) ----------------------------

  let entries: any[]  = [];
  let configMeta: any = null;  // default model names from configurations API

  if (token) {
    // Preferred: configurations API (rich metadata, accurate limits)
    if (usageProjectId) {
      try {
        const { items, meta } = await fetchConfigModels(baseUrl, token, usageProjectId);
        entries    = items.map((item) => modelFromConfig(item, baseUrl, projectId));
        configMeta = meta;
      } catch (err) {
        console.error(`[elitea] Configurations API failed (${err instanceof Error ? err.message : err}), trying /llm/v1/models.`);
      }
    }
    // Fallback: basic list — no Claude routing or adaptive-thinking metadata here
    if (entries.length === 0) {
      try {
        entries = await fetchLlmModels(baseUrl, token, projectId);
      } catch (err) {
        console.error(`[elitea] Model discovery failed (${err instanceof Error ? err.message : err}). Using seed list.`);
      }
    }
  } else {
    console.error(
      "[elitea] ELITEA_API_TOKEN is not set — using seed models.\n" +
      "         Get a PAT from: Settings → Personal Tokens → + → Generate."
    );
  }

  // ---- Seed fallback -------------------------------------------------------

  if (entries.length === 0 && process.env.ELITEA_MODEL)
    entries = [modelFromId(process.env.ELITEA_MODEL)];

  if (entries.length === 0) {
    entries = [
      "gpt-5.4-mini", "gpt-5.4", "gpt-5.2", "gpt-5-mini", "gpt-5.6-luna",
      "gpt-4.1", "gpt-4o-2024-11-20",
      "eu.anthropic.claude-sonnet-4-6", "eu.anthropic.claude-sonnet-5",
      "eu.anthropic.claude-haiku-4-5-20251001-v1:0",
    ].map((id) => modelFromId(id));
  }

  // ---- Provider registration -----------------------------------------------

  const models = entries.map(({ _tier, _default, ...entry }) => {
    // Claude uses anthropic-messages — don't add supportsReasoningEffort (triggers
    // reasoning_effort → ELITEA converts to thinking.type:enabled → Bedrock 400).
    if (entry.api === "anthropic-messages") return entry;
    return { ...entry, compat: { ...entry.compat, supportsReasoningEffort: true } };
  });

  pi.registerProvider("elitea", {
    name: "ELITEA",
    baseUrl: `${baseUrl}/llm/v1`,
    api: "openai-completions",
    apiKey: "$ELITEA_API_TOKEN",
    headers: { "OpenAI-Project": projectId },
    models,
  });

  // ---- Commands & status bar -----------------------------------------------

  const getAuth = () => ({
    baseUrl,
    token: process.env.ELITEA_API_TOKEN || token,
    usageProjectId,
  });

  // Pass enriched entries (with _tier/_default) to the models command
  registerModelsCommand(pi, entries, configMeta,
    () => (pi.modelRegistry?.getAvailable?.() ?? []).filter((m) => m.provider === "elitea")
  );

  if (usageProjectId) {
    registerUsageCommand(pi, getAuth);
    registerUsageStatusBar(pi, getAuth);
  } else {
    console.error(
      "[elitea] ELITEA_USAGE_PROJECT_ID not set — /elitea-usage and status bar disabled.\n" +
      "         Set it to your numeric ELITEA project ID (e.g. ELITEA_USAGE_PROJECT_ID=5868)."
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
// /elitea-models — full model table with tier/vision/default info
// ---------------------------------------------------------------------------

function registerModelsCommand(pi, rawEntries: any[], configMeta: any, getRegistered: () => any[]) {
  pi.registerCommand("elitea-models", {
    description: "List available ELITEA models with metadata (tier, vision, context window).",
    handler: async (_args, ctx) => {
      // Prefer the live registry (post-startup), fall back to entries from factory
      const live = getRegistered();
      const rows = (live.length > 0 ? live : rawEntries)
        .slice()
        .sort((a, b) => a.id.localeCompare(b.id));

      // Build a lookup for tier/default/vision from rawEntries
      const meta: Record<string, any> = {};
      for (const e of rawEntries) meta[e.id] = e;

      const lines = [
        "# ELITEA models",
        "",
      ];

      if (configMeta?.default_model_name) {
        lines.push(
          `_Default: **${configMeta.default_model_name}** · ` +
          `Low-tier default: **${configMeta.low_tier_default_model_name ?? "—"}** · ` +
          `High-tier default: **${configMeta.high_tier_default_model_name ?? "—"}**_`,
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
        const res = await fetch(url, {
          headers: { Authorization: `Bearer ${token}` },
          redirect: "follow",
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
