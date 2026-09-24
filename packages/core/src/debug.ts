/**
 * Debug mode (Claude Code). Off by default; toggled with
 * `context-optimizer debug on|off`. While it is on, the PreCompact hook still
 * runs the optimizer but never blocks or replaces Claude's native compaction,
 * and the PostCompact hook captures the native summary. Both results land in
 * one folder per compaction so they can be compared later:
 *
 *   <data dir>/debug/<session-id>/index.md        one linked row per compaction
 *   <data dir>/debug/<session-id>/<stamp>/
 *     plugin.txt      the optimizer's result
 *     native.txt      Claude's own compact summary
 *     evaluation.md   written by /context-optimizer:evaluate in a new session
 *     meta.json       sizes and status, for the report and the CLI
 */
import fs from "node:fs"
import path from "node:path"
import process from "node:process"

import { readStoredConfig, writeStoredConfig } from "./config.js"
import { debugDir } from "./paths.js"
import type { OptimizerResult } from "./payload.js"

export const DEBUG_FILES = Object.freeze({
  plugin: "plugin.txt",
  native: "native.txt",
  evaluation: "evaluation.md",
  meta: "meta.json",
})

// ponytail: a plugin run whose native compaction never followed (e.g. it
// failed) must not be paired with an unrelated compaction much later.
const PAIR_MAX_AGE_MS = 60 * 60 * 1000

export interface DebugMeta {
  sessionID: string
  stamp: string
  trigger: string
  originalChars: number
  pluginChars: number | null
  /** "optimized", "no_optimization", "failed", "skipped", or "missing" (no PreCompact run). */
  pluginStatus: string
  pluginReason: string
  nativeChars: number | null
}

/** The CONTEXT_OPTIMIZER_DEBUG env var wins over the stored `debug` flag. */
export function isDebugEnabled(): boolean {
  const env = process.env.CONTEXT_OPTIMIZER_DEBUG
  if (env && env.trim()) return /^(1|true|on|yes)$/i.test(env.trim())
  return readStoredConfig().debug === true
}

export function setDebugEnabled(enabled: boolean): void {
  const { debug: _previous, ...rest } = readStoredConfig()
  writeStoredConfig(enabled ? { ...rest, debug: true } : rest)
}

export function debugSessionDir(sessionID: string): string {
  return path.join(debugDir(), (sessionID || "unknown").replace(/[^\w.-]/g, "_"))
}

/** Sortable and filesystem-safe, e.g. 2026-09-24T10-15-30-123Z. */
function newStamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-")
}

function readMeta(dir: string): DebugMeta | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, DEBUG_FILES.meta), "utf8"))
  } catch {
    return null
  }
}

function writeMeta(dir: string, meta: DebugMeta): void {
  fs.writeFileSync(path.join(dir, DEBUG_FILES.meta), `${JSON.stringify(meta, null, 2)}\n`, "utf8")
}

function compactionDirs(sessionDir: string): string[] {
  try {
    return fs
      .readdirSync(sessionDir)
      .filter((name) => fs.existsSync(path.join(sessionDir, name, DEBUG_FILES.meta)))
      .sort()
  } catch {
    return []
  }
}

/** PreCompact side: store the plugin result (or why there is none) in a new compaction folder. */
export function recordPluginDebug(
  sessionID: string,
  trigger: string,
  result: OptimizerResult,
  originalChars = 0,
): string {
  const stamp = newStamp()
  const dir = path.join(debugSessionDir(sessionID), stamp)
  fs.mkdirSync(dir, { recursive: true })

  const optimized = result.ok && result.optimizedContext ? result.optimizedContext : ""
  if (optimized) fs.writeFileSync(path.join(dir, DEBUG_FILES.plugin), optimized, "utf8")
  writeMeta(dir, {
    sessionID,
    stamp,
    trigger,
    originalChars: Number.isFinite(result.initialSize) ? (result.initialSize as number) : originalChars,
    pluginChars: optimized ? optimized.length : null,
    pluginStatus: optimized ? "optimized" : result.status || (result.ok ? "no_optimization" : "failed"),
    pluginReason: optimized ? "" : result.reason || result.message || "",
    nativeChars: null,
  })
  return dir
}

/** The newest compaction folder of a session that is still waiting for its native summary. */
function pendingDir(sessionDir: string): string | null {
  const newest = compactionDirs(sessionDir).pop()
  if (!newest) return null
  const dir = path.join(sessionDir, newest)
  if (fs.existsSync(path.join(dir, DEBUG_FILES.native))) return null
  if (Date.now() - fs.statSync(path.join(dir, DEBUG_FILES.meta)).mtimeMs > PAIR_MAX_AGE_MS) return null
  return dir
}

/** PostCompact side: store Claude's summary next to the plugin result and build the user report. */
export function recordNativeDebug(
  sessionID: string,
  trigger: string,
  summary: string,
): { dir: string; meta: DebugMeta; report: string } {
  const sessionDir = debugSessionDir(sessionID)
  let dir = pendingDir(sessionDir)
  let meta = dir ? readMeta(dir) : null
  if (!dir || !meta) {
    const stamp = newStamp()
    dir = path.join(sessionDir, stamp)
    fs.mkdirSync(dir, { recursive: true })
    meta = {
      sessionID,
      stamp,
      trigger,
      originalChars: 0,
      pluginChars: null,
      pluginStatus: "missing",
      pluginReason: "no PreCompact run was recorded for this compaction",
      nativeChars: null,
    }
  }

  fs.writeFileSync(path.join(dir, DEBUG_FILES.native), summary, "utf8")
  meta = { ...meta, trigger: meta.trigger || trigger, nativeChars: summary.length }
  writeMeta(dir, meta)
  appendIndex(sessionDir, meta)
  return { dir, meta, report: formatDebugReport(meta, dir) }
}

const fmt = (n: number) => n.toLocaleString("en-US")

/** Plugin size as a percentage of the native size, e.g. "49%". */
export function pluginVsNative(meta: Pick<DebugMeta, "pluginChars" | "nativeChars">): string {
  if (meta.pluginChars === null || !meta.nativeChars) return "n/a"
  return `${Math.round((meta.pluginChars / meta.nativeChars) * 100)}%`
}

export function formatDebugReport(meta: DebugMeta, dir: string): string {
  const lines = [`[context-optimizer debug] ${meta.trigger || "unknown"} compaction: native and plugin results saved.`]
  lines.push(`Native compact: ${fmt(meta.nativeChars ?? 0)} chars`)
  if (meta.pluginChars !== null) {
    const ratio = meta.nativeChars ? meta.pluginChars / meta.nativeChars : 0
    const direction = !meta.nativeChars
      ? ""
      : ratio <= 1
        ? ` (${Math.round((1 - ratio) * 100)}% smaller)`
        : ` (${Math.round((ratio - 1) * 100)}% larger)`
    lines.push(`Plugin result:  ${fmt(meta.pluginChars)} chars, ${pluginVsNative(meta)} of the native size${direction}`)
  } else {
    lines.push(`Plugin result:  none (${meta.pluginStatus}${meta.pluginReason ? `: ${meta.pluginReason}` : ""})`)
  }
  if (meta.originalChars) lines.push(`Original context: ${fmt(meta.originalChars)} chars`)
  lines.push(`Files: ${dir}`)
  lines.push(`Compare them in a new session with /context-optimizer:evaluate ${meta.sessionID}`)
  return lines.join("\n")
}

function appendIndex(sessionDir: string, meta: DebugMeta): void {
  const file = path.join(sessionDir, "index.md")
  const link = (name: string) => `[${name.replace(/\.\w+$/, "")}](${meta.stamp}/${name})`
  const links = [
    meta.pluginChars !== null ? link(DEBUG_FILES.plugin) : "",
    link(DEBUG_FILES.native),
    link(DEBUG_FILES.evaluation),
  ].filter(Boolean)
  const row = [
    meta.stamp,
    meta.trigger || "unknown",
    meta.originalChars ? fmt(meta.originalChars) : "",
    fmt(meta.nativeChars ?? 0),
    meta.pluginChars !== null ? fmt(meta.pluginChars) : meta.pluginStatus,
    pluginVsNative(meta),
    links.join(" · "),
  ]
  const header = fs.existsSync(file)
    ? ""
    : `# Debug compactions for session ${meta.sessionID}\n\n` +
      "| compaction | trigger | original chars | native chars | plugin chars | plugin vs native | files |\n" +
      "| :--- | :--- | ---: | ---: | ---: | ---: | :--- |\n"
  fs.appendFileSync(file, `${header}| ${row.join(" | ")} |\n`, "utf8")
}

export interface DebugCompaction extends DebugMeta {
  dir: string
  plugin: string | null
  native: string
  evaluation: string
  evaluationExists: boolean
}

/**
 * The newest compaction that has a native summary, in the given session or
 * (without one) across all sessions.
 */
export function findDebugCompaction(sessionID?: string): DebugCompaction | null {
  let sessionDirs: string[]
  if (sessionID) {
    sessionDirs = [debugSessionDir(sessionID)]
  } else {
    try {
      sessionDirs = fs.readdirSync(debugDir()).map((name) => path.join(debugDir(), name))
    } catch {
      return null
    }
  }

  const candidates = sessionDirs
    .flatMap((sessionDir) => compactionDirs(sessionDir).map((stamp) => ({ stamp, dir: path.join(sessionDir, stamp) })))
    .filter(({ dir }) => fs.existsSync(path.join(dir, DEBUG_FILES.native)))
    .sort((a, b) => a.stamp.localeCompare(b.stamp))

  const latest = candidates.pop()
  const meta = latest ? readMeta(latest.dir) : null
  if (!latest || !meta) return null

  const plugin = path.join(latest.dir, DEBUG_FILES.plugin)
  const evaluation = path.join(latest.dir, DEBUG_FILES.evaluation)
  return {
    ...meta,
    dir: latest.dir,
    plugin: fs.existsSync(plugin) ? plugin : null,
    native: path.join(latest.dir, DEBUG_FILES.native),
    evaluation,
    evaluationExists: fs.existsSync(evaluation),
  }
}
