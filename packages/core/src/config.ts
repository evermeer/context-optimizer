import fs from "node:fs"
import path from "node:path"
import process from "node:process"

import { configPath, statsPath } from "./paths.js"

export const DEFAULT_TIMEOUT_MS = 120000
export const DEFAULT_MIN_COMPACTION_CHARS = 2000
export const SAFE_CONFIG_KEYS = Object.freeze(["timeout_ms", "min_chars", "model_limits"] as const)

export type ModelLimits = Record<string, Record<string, unknown>>

export interface EffectiveConfig {
  timeout_ms: number
  min_chars: number
  model_limits: ModelLimits
}

export function parseNumeric(value: unknown, fallback = 0): number {
  const parsed = typeof value === "string" ? Number.parseFloat(value) : Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
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
    model_limits: parseJsonValue<ModelLimits>(
      process.env.CONTEXT_OPTIMIZER_MODEL_LIMITS,
      parseJsonValue<ModelLimits>(stored.model_limits, {}),
    ),
  }
}

export interface StoredStats {
  totalPrunedChars: number
  totalOptimizations: number
  sessions: Record<string, boolean>
}

export function readStoredStats(): StoredStats {
  try {
    const parsed = parseJsonValue<Record<string, unknown>>(fs.readFileSync(statsPath(), "utf8"), {})
    const sessions =
      parsed.sessions && typeof parsed.sessions === "object"
        ? (parsed.sessions as Record<string, boolean>)
        : {}

    return {
      totalPrunedChars: parseNumeric(parsed.totalPrunedChars, 0),
      totalOptimizations: parseNumeric(parsed.totalOptimizations, 0),
      sessions,
    }
  } catch {
    return { totalPrunedChars: 0, totalOptimizations: 0, sessions: {} }
  }
}

export function writeStoredStats(stats: StoredStats): void {
  const file = statsPath()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${JSON.stringify(stats, null, 2)}\n`, "utf8")
}

export function recordOptimizationStats(
  sessionID: string | undefined,
  result: { initialSize?: unknown; finalSize?: unknown },
): void {
  const stats = readStoredStats()
  const prunedChars = Math.max(0, parseNumeric(result?.initialSize, 0) - parseNumeric(result?.finalSize, 0))

  stats.totalPrunedChars += prunedChars
  stats.totalOptimizations += 1
  stats.sessions[sessionID || "global"] = true

  writeStoredStats(stats)
}
