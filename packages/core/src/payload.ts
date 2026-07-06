import { resolveEffectiveConfig } from "./config.js"

export const DEFAULT_ERROR_PREFIXES = ["[error]", "[context-optimizer] error"]
export const DEFAULT_PROTECTED_PREFIXES = ["protected:"]
export const AUTO_COMPRESSION_THRESHOLD_CHARS = 4000
export const DEFAULT_QUERY = "Optimize the most relevant context for compaction."

export interface OptimizerPayload {
  model: string
  query: string
  docs: string[]
  errorDocs: string[]
  protectedDocs: string[]
  size: number
  options: Record<string, unknown>
}

export interface OptimizerResult {
  ok: boolean
  optimizedContext?: string
  initialSize?: number
  finalSize?: number
  status?: string
  reason?: string
  errorCode?: string
  message?: string
}

export function matchesPrefix(value: string, prefixes: string[]): boolean {
  return prefixes.some((prefix) => value.toLowerCase().startsWith(prefix.toLowerCase()))
}

export function buildPayload(
  input: Record<string, any> = {},
  output: Record<string, any> = {},
): OptimizerPayload {
  const model = input.model || output.model || ""
  const options: Record<string, unknown> = {
    ...(input.options && typeof input.options === "object" ? input.options : {}),
    ...(output.options && typeof output.options === "object" ? output.options : {}),
  }
  const context: string[] = Array.isArray(output.context)
    ? output.context.filter((value: unknown): value is string => typeof value === "string" && !!value.trim())
    : []
  const size = context.reduce((total, value) => total + value.length, 0)
  const errorDocs = context.filter((value) => matchesPrefix(value.trim(), DEFAULT_ERROR_PREFIXES))
  const protectedDocs = context.filter((value) => matchesPrefix(value.trim(), DEFAULT_PROTECTED_PREFIXES))
  const docs = context.filter(
    (value) =>
      !matchesPrefix(value.trim(), DEFAULT_ERROR_PREFIXES) &&
      !matchesPrefix(value.trim(), DEFAULT_PROTECTED_PREFIXES),
  )
  const modelLimits = resolveEffectiveConfig().model_limits
  const modelLimit = model && modelLimits && typeof modelLimits === "object" ? modelLimits[model] : null

  if (size >= AUTO_COMPRESSION_THRESHOLD_CHARS && modelLimit && typeof modelLimit === "object") {
    for (const [key, value] of Object.entries(modelLimit)) {
      options[key] = value
    }
  }

  return {
    model,
    query: output.prompt || input.prompt || DEFAULT_QUERY,
    docs,
    errorDocs,
    protectedDocs,
    size,
    options,
  }
}

export function summarizeContext(payload: Partial<OptimizerPayload> = {}) {
  const docs = Array.isArray(payload.docs) ? payload.docs : []
  const errorDocs = Array.isArray(payload.errorDocs) ? payload.errorDocs : []
  const protectedDocs = Array.isArray(payload.protectedDocs) ? payload.protectedDocs : []
  const size = Number.isFinite(payload.size)
    ? (payload.size as number)
    : docs.reduce((total, value) => total + String(value).length, 0)

  return {
    docs: docs.length,
    errorDocs: errorDocs.length,
    protectedDocs: protectedDocs.length,
    size,
    query: payload.query || DEFAULT_QUERY,
    model: payload.model || "",
  }
}

export function formatSizeSummary(initialSize?: number, finalSize?: number): string {
  if (!Number.isFinite(initialSize) || !Number.isFinite(finalSize)) return ""

  const saved = (initialSize as number) - (finalSize as number)
  const percent = (initialSize as number) > 0 ? Math.round((saved / (initialSize as number)) * 100) : 0
  return `Initial size: ${initialSize} chars, final size: ${finalSize} chars, saved: ${saved} chars (${percent}%)`
}

function formatMissingSizeDetail(result: OptimizerResult): string {
  const parts: string[] = []
  if (!Number.isFinite(result.initialSize)) parts.push(`initial_size=${String(result.initialSize)}`)
  if (!Number.isFinite(result.finalSize)) parts.push(`final_size=${String(result.finalSize)}`)
  return parts.length ? ` (${parts.join(", ")})` : ""
}

export function formatOutcomeMessage(result: OptimizerResult = { ok: false }): string {
  const summary = formatSizeSummary(result.initialSize, result.finalSize)

  if (summary) {
    return `[context-optimizer] optimized context emitted. ${summary}`
  }

  if (result?.status === "no_optimization") {
    return `[context-optimizer] no optimization applied: ${result.reason || "the optimizer found no safer or smaller replacement for the current context."}`
  }

  if (result?.status === "failed") {
    const details: string[] = []
    if (Number.isFinite(result.initialSize)) details.push(`size=${result.initialSize} chars`)
    const detailText = details.length ? ` (${details.join(", ")})` : ""
    return `[context-optimizer] optimization skipped: ${result.reason || result.message || "the optimizer could not complete."}${detailText}`
  }

  if (result?.ok === true) {
    return `[context-optimizer] optimization completed, but savings summary was unavailable because size metadata was missing or non-numeric.${formatMissingSizeDetail(result)}`
  }

  return `[context-optimizer] optimization completed without a measurable savings summary.`
}

/**
 * Fail open: only replace the original context when the optimizer produced a
 * real optimized replacement. Failures and no-op results leave context intact.
 */
export function applyOptimizedContext(output: Record<string, any> | undefined, result: OptimizerResult): void {
  if (!output || !result?.optimizedContext) return

  const summary = formatSizeSummary(result.initialSize, result.finalSize)
  const statusLine = summary
    ? `[context-optimizer] optimized context emitted. ${summary}`
    : `[context-optimizer] optimization completed, but savings summary was unavailable because size metadata was missing or non-numeric.${formatMissingSizeDetail(result)}`

  output.context = [statusLine, `## Optimized Context\n\n${result.optimizedContext}`]
}
