import fs from "node:fs"
import path from "node:path"
import process from "node:process"

import { configPath, resultsCsvPath } from "./paths.js"

export const DEFAULT_TIMEOUT_MS = 300000
export const DEFAULT_MIN_COMPACTION_CHARS = 2000
export const DEFAULT_COMPRESSION_RATE = 0.5
export const DEFAULT_MAX_CHUNKS = 6
export const DEFAULT_DEDUPE_THRESHOLD = 0.9
export const DEFAULT_PRUNE_BUDGET_CHARS = 4000
export const DEFAULT_AUTO_COMPRESSION_CHARS = 4000
export const DEFAULT_RERANKER_MODEL = "BAAI/bge-reranker-large"
export const DEFAULT_EMBED_MODEL = "all-MiniLM-L6-v2"
// Empty means "let the Python bridge auto-select by device" (xlm-roberta-large on
// CUDA, bert-base on CPU); we only forward an explicit override.
export const DEFAULT_COMPRESSOR_MODEL = ""
export const SAFE_CONFIG_KEYS = Object.freeze([
  "timeout_ms",
  "min_chars",
  "compression_rate",
  "max_chunks",
  "dedupe_threshold",
  "total_prune_budget_chars",
  "auto_compression_chars",
  "reranker_model",
  "embed_model",
  "compressor_model",
  "model_limits",
] as const)

/** Keys whose value is a free-form string rather than a positive number or JSON. */
export const STRING_CONFIG_KEYS = Object.freeze(["reranker_model", "embed_model", "compressor_model"] as const)

export type ModelLimits = Record<string, Record<string, unknown>>

export interface EffectiveConfig {
  timeout_ms: number
  min_chars: number
  compression_rate: number
  max_chunks: number
  dedupe_threshold: number
  total_prune_budget_chars: number
  auto_compression_chars: number
  reranker_model: string
  embed_model: string
  compressor_model: string
  model_limits: ModelLimits
}

export function parseNumeric(value: unknown, fallback = 0): number {
  const parsed = typeof value === "string" ? Number.parseFloat(value) : Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

export function normalizeConfigKey(key: unknown): string | null {
  const normalized = String(key || "").trim().toLowerCase()
  return (SAFE_CONFIG_KEYS as readonly string[]).includes(normalized) ? normalized : null
}

export function parseJsonValue<T extends object>(raw: unknown, fallback: T): T {
  if (!raw) return fallback
  if (typeof raw === "object") return raw as T

  try {
    const parsed = JSON.parse(String(raw))
    return parsed && typeof parsed === "object" ? (parsed as T) : fallback
  } catch {
    return fallback
  }
}

export function readStoredConfig(): Record<string, unknown> {
  try {
    return parseJsonValue(fs.readFileSync(configPath(), "utf8"), {})
  } catch {
    return {}
  }
}

export function writeStoredConfig(config: Record<string, unknown>): void {
  const file = configPath()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, "utf8")
}

export function removeStoredConfig(): void {
  try {
    fs.rmSync(configPath(), { force: true })
  } catch {
    // Best effort reset.
  }
}

/** Env vars win over the stored config file, which wins over defaults. */
export function resolveEffectiveConfig(): EffectiveConfig {
  const stored = readStoredConfig()
  return {
    timeout_ms: parseNumeric(
      process.env.CONTEXT_OPTIMIZER_TIMEOUT_MS,
      parseNumeric(stored.timeout_ms, DEFAULT_TIMEOUT_MS),
    ),
    min_chars: parseNumeric(
      process.env.CONTEXT_OPTIMIZER_MIN_CHARS,
      parseNumeric(stored.min_chars, DEFAULT_MIN_COMPACTION_CHARS),
    ),
    compression_rate: parseNumeric(
      process.env.CONTEXT_OPTIMIZER_COMPRESSION_RATE,
      parseNumeric(stored.compression_rate, DEFAULT_COMPRESSION_RATE),
    ),
    // Python slices with max_chunks, so it must be an int even from a stray env/float.
    max_chunks: Math.max(
      1,
      Math.round(
        parseNumeric(
          process.env.CONTEXT_OPTIMIZER_MAX_CHUNKS,
          parseNumeric(stored.max_chunks, DEFAULT_MAX_CHUNKS),
        ),
      ),
    ),
    dedupe_threshold: parseNumeric(
      process.env.CONTEXT_OPTIMIZER_DEDUPE_THRESHOLD,
      parseNumeric(stored.dedupe_threshold, DEFAULT_DEDUPE_THRESHOLD),
    ),
    total_prune_budget_chars: Math.max(
      1,
      Math.round(
        parseNumeric(
          process.env.CONTEXT_OPTIMIZER_PRUNE_BUDGET_CHARS,
          parseNumeric(stored.total_prune_budget_chars, DEFAULT_PRUNE_BUDGET_CHARS),
        ),
      ),
    ),
    auto_compression_chars: Math.max(
      0,
      Math.round(
        parseNumeric(
          process.env.CONTEXT_OPTIMIZER_AUTO_COMPRESSION_CHARS,
          parseNumeric(stored.auto_compression_chars, DEFAULT_AUTO_COMPRESSION_CHARS),
        ),
      ),
    ),
    reranker_model: String(
      process.env.CONTEXT_OPTIMIZER_RERANKER_MODEL || stored.reranker_model || DEFAULT_RERANKER_MODEL,
    ),
    embed_model: String(process.env.CONTEXT_OPTIMIZER_EMBED_MODEL || stored.embed_model || DEFAULT_EMBED_MODEL),
    compressor_model: String(
      process.env.CONTEXT_OPTIMIZER_COMPRESSOR_MODEL || stored.compressor_model || DEFAULT_COMPRESSOR_MODEL,
    ),
    model_limits: parseJsonValue<ModelLimits>(
      process.env.CONTEXT_OPTIMIZER_MODEL_LIMITS,
      parseJsonValue<ModelLimits>(stored.model_limits, {}),
    ),
  }
}

/**
 * Optimizer tuning knobs forwarded to the Python bridge as a base layer of options.
 * Keys match ContextOptimizer.__init__ kwargs; auto_compression_chars is TS-only and excluded.
 */
export function optimizerOptionsFromConfig(config: EffectiveConfig): Record<string, unknown> {
  const options: Record<string, unknown> = {
    compression_rate: config.compression_rate,
    max_chunks: config.max_chunks,
    dedupe_threshold: config.dedupe_threshold,
    total_prune_budget_chars: config.total_prune_budget_chars,
    reranker_model: config.reranker_model,
    embed_model: config.embed_model,
  }
  // Its default is device-dependent and resolved in Python, so only forward an override.
  if (config.compressor_model) options.compressor_model = config.compressor_model
  return options
}

export interface ParsedConfigValue {
  ok: boolean
  value?: unknown
  error?: string
}

/** Validate + coerce a `config set <key> <value>` argument. Shared by every adapter's config command. */
export function parseConfigValue(key: string, raw: string): ParsedConfigValue {
  if (key === "model_limits") {
    const value = parseJsonValue(raw, null as unknown as object)
    if (!value || typeof value !== "object") return { ok: false, error: "model_limits must be valid JSON." }
    return { ok: true, value }
  }

  if ((STRING_CONFIG_KEYS as readonly string[]).includes(key)) {
    const value = raw.trim()
    if (!value) return { ok: false, error: `${key} must be a non-empty string.` }
    return { ok: true, value }
  }

  const num = parseNumeric(raw, Number.NaN)
  if (!Number.isFinite(num) || num <= 0) {
    return { ok: false, error: `${key} must be a positive number.` }
  }

  if (key === "max_chunks" && !Number.isInteger(num)) {
    return { ok: false, error: "max_chunks must be a positive integer." }
  }

  if ((key === "compression_rate" || key === "dedupe_threshold") && num > 1) {
    return { ok: false, error: `${key} must be between 0 and 1.` }
  }

  return { ok: true, value: num }
}

const RESULTS_CSV_HEADER = "timestamp,cli,session_id,trigger,initial_chars,result_chars,saved_chars"

export interface ResultRow {
  timestamp: string
  cli: string
  sessionID: string
  trigger: string
  initialChars: number
  resultChars: number
  savedChars: number
}

function csvField(value: unknown): string {
  // ponytail: session ids/cli names never legitimately contain CSV control chars; strip instead of quoting
  return String(value ?? "").replace(/[",\r\n]/g, "_")
}

/** Append one compaction result to the shared results CSV. `cli` is "claude-code", "opencode", or "cli". */
export function recordOptimizationStats(
  sessionID: string | undefined,
  result: { initialSize?: unknown; finalSize?: unknown },
  cli = "cli",
  trigger = "",
): void {
  const initialChars = Math.max(0, parseNumeric(result?.initialSize, 0))
  const resultChars = Math.max(0, parseNumeric(result?.finalSize, 0))
  const savedChars = Math.max(0, initialChars - resultChars)

  const file = resultsCsvPath()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const row = [
    new Date().toISOString(),
    csvField(cli),
    csvField(sessionID || "global"),
    csvField(trigger),
    initialChars,
    resultChars,
    savedChars,
  ].join(",")
  const prefix = fs.existsSync(file) ? "" : `${RESULTS_CSV_HEADER}\n`
  fs.appendFileSync(file, `${prefix}${row}\n`, "utf8")
}

export function readResults(): ResultRow[] {
  try {
    const rows: ResultRow[] = []
    for (const line of fs.readFileSync(resultsCsvPath(), "utf8").split("\n").slice(1)) {
      if (!line.trim()) continue
      const [timestamp, cli, sessionID, trigger, initial, result, saved] = line.split(",")
      rows.push({
        timestamp: timestamp || "",
        cli: cli || "",
        sessionID: sessionID || "",
        trigger: trigger || "",
        initialChars: parseNumeric(initial, 0),
        resultChars: parseNumeric(result, 0),
        savedChars: parseNumeric(saved, 0),
      })
    }
    return rows
  } catch {
    return []
  }
}

/**
 * Render the results CSV as an aligned text table. Columns: last compact,
 * the latest compact's session, today (local calendar day), week (trailing
 * 7 days), month (trailing 30 days), overall.
 */
export function formatStatsTable(rows: ResultRow[], now = new Date()): string {
  const latest = rows[rows.length - 1]
  const dayMs = 24 * 60 * 60 * 1000
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const windows: Array<[string, (row: ResultRow) => boolean]> = [
    ["last", (row) => row === latest],
    ["session", (row) => !!latest && row.sessionID === latest.sessionID],
    ["today", (row) => Date.parse(row.timestamp) >= startOfToday],
    ["week", (row) => now.getTime() - Date.parse(row.timestamp) < 7 * dayMs],
    ["month", (row) => now.getTime() - Date.parse(row.timestamp) < 30 * dayMs],
    ["overall", () => true],
  ]

  const fmt = (n: number) => n.toLocaleString("en-US")
  const columns = windows.map(([, match]) => {
    const selected = rows.filter(match)
    const initial = selected.reduce((total, row) => total + row.initialChars, 0)
    const result = selected.reduce((total, row) => total + row.resultChars, 0)
    const saved = selected.reduce((total, row) => total + row.savedChars, 0)
    return [
      fmt(selected.length),
      fmt(initial),
      fmt(result),
      fmt(saved),
      initial > 0 ? `${Math.round((saved / initial) * 100)}%` : "0%",
    ]
  })

  const metrics = ["compactions", "initial chars", "result chars", "saved chars", "saved %"]
  const table = [
    ["metric", ...windows.map(([label]) => label)],
    ...metrics.map((metric, index) => [metric, ...columns.map((column) => column[index])]),
  ]
  const widths = table[0].map((_, col) => Math.max(...table.map((row) => row[col].length)))
  return table
    .map((row) =>
      row
        .map((cell, col) => (col === 0 ? cell.padEnd(widths[col]) : cell.padStart(widths[col])))
        .join("  "),
    )
    .join("\n")
}
