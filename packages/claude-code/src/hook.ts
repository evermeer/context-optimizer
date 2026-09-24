#!/usr/bin/env node
/**
 * Claude Code adapter.
 *
 * Claude Code hooks cannot rewrite the compaction context directly, so this
 * adapter works in two phases:
 *  - "precompact":   runs on the PreCompact hook and optimizes the transcript
 *                    context via the Python bridge.
 *                    - manual /compact: stores the result per project and
 *                      blocks Claude's own compaction; the user runs /clear.
 *                    - auto-compact: stores the result per session and lets
 *                      Claude's compaction proceed.
 *  - "sessionstart": runs on the SessionStart hook (matcher "compact|clear")
 *                    and injects the stored optimized context into the fresh
 *                    session as additionalContext.
 *  - "postcompact":  runs on the PostCompact hook; only does work in debug
 *                    mode (see core/src/debug.ts).
 *
 * In debug mode precompact never blocks or hands off: Claude's native
 * compaction runs untouched, and the plugin result is saved next to the native
 * summary that postcompact captures, for a side-by-side comparison.
 *
 * Both phases fail open: on any error the hook does not block and Claude Code
 * proceeds untouched.
 */
import fs from "node:fs"
import path from "node:path"
import process from "node:process"
import { pathToFileURL } from "node:url"

import { runOptimizer } from "../../core/src/bridge.js"
import { recordOptimizationStats, resolveEffectiveConfig } from "../../core/src/config.js"
import { isDebugEnabled, recordNativeDebug, recordPluginDebug } from "../../core/src/debug.js"
import { writeLog } from "../../core/src/log.js"
import { claudeSessionDir } from "../../core/src/paths.js"
import { DEFAULT_QUERY, formatOutcomeMessage } from "../../core/src/payload.js"
import { isProtectedTool, PURGE_ERROR_TURNS, toolSignature } from "../../core/src/strategies.js"

// ponytail: only the newest transcript entries feed the optimizer; reranking
// thousands of old chunks is slow and the pre-prune budget discards them anyway.
const MAX_TRANSCRIPT_ENTRIES = 200

interface HookInput {
  session_id?: string
  transcript_path?: string
  trigger?: string
  source?: string
  custom_instructions?: string
  compact_summary?: string
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString("utf8")
}

function extractTexts(content: unknown): string[] {
  if (typeof content === "string") return content.trim() ? [content.trim()] : []
  if (!Array.isArray(content)) return []

  const texts: string[] = []
  for (const part of content) {
    if (part && typeof part === "object" && typeof (part as any).text === "string") {
      const text = (part as any).text.trim()
      if (text) texts.push(text)
    }
  }
  return texts
}

const MAX_TOOL_DOC_CHARS = 2000

interface DocItem {
  kind: "text" | "tool_result"
  text: string
  signature?: string
  isError?: boolean
  turn?: number
  protected?: boolean
}

/**
 * Converts a Claude Code transcript (JSONL) into optimizer docs, applying the
 * same strategies the OpenCode adapter runs live:
 *  - deduplication: identical tool calls (tool + parameters) keep only the
 *    newest result.
 *  - purgeErrors: errored tool results older than PURGE_ERROR_TURNS user
 *    turns are dropped.
 * Tool outputs used to be discarded entirely; now the surviving ones are fed
 * to the optimizer alongside the prose.
 */
export function transcriptToDocs(transcriptPath: string): string[] {
  const raw = fs.readFileSync(transcriptPath, "utf8")
  const items: DocItem[] = []
  const toolUses = new Map<string, { name: string; input: unknown }>()
  let currentTurn = 0

  for (const line of raw.split("\n")) {
    if (!line.trim()) continue
    try {
      const entry = JSON.parse(line)
      const content = entry?.message?.content

      for (const text of extractTexts(content)) {
        items.push({ kind: "text", text })
      }
      if (entry?.type === "user" && extractTexts(content).length > 0) {
        currentTurn += 1
      }

      if (!Array.isArray(content)) continue
      for (const part of content) {
        if (!part || typeof part !== "object") continue

        if (part.type === "tool_use" && typeof part.id === "string" && typeof part.name === "string") {
          toolUses.set(part.id, { name: part.name, input: part.input })
        }

        if (part.type === "tool_result" && typeof part.tool_use_id === "string") {
          const use = toolUses.get(part.tool_use_id)
          if (!use) continue

          const text = extractTexts(part.content).join("\n").slice(0, MAX_TOOL_DOC_CHARS)
          if (!text) continue

          items.push({
            kind: "tool_result",
            text: `[tool ${use.name}] ${text}`,
            signature: toolSignature(use.name, use.input),
            isError: part.is_error === true,
            turn: currentTurn,
            protected: isProtectedTool(use.name),
          })
        }
      }
    } catch {
      // Skip malformed transcript lines.
    }
  }

  // Deduplication: remember the newest occurrence per tool signature.
  const newestBySignature = new Map<string, number>()
  items.forEach((item, index) => {
    if (item.kind === "tool_result" && item.signature && !item.protected) {
      newestBySignature.set(item.signature, index)
    }
  })

  const docs: string[] = []
  items.forEach((item, index) => {
    if (item.kind === "tool_result" && !item.protected) {
      if (item.signature && newestBySignature.get(item.signature) !== index) return
      if (item.isError && currentTurn - (item.turn ?? 0) >= PURGE_ERROR_TURNS) return
    }
    docs.push(item.text)
  })

  return docs.slice(-MAX_TRANSCRIPT_ENTRIES)
}

function sessionFile(sessionID: string): string {
  return path.join(claudeSessionDir(), `${sessionID.replace(/[^\w.-]/g, "_")}.md`)
}

// The outcome report for a compaction that Claude still runs (auto-compact,
// or a manual one the optimizer couldn't replace). PreCompact discards
// systemMessage, so it is shown from SessionStart (source "compact") instead.
function outcomeFile(sessionID: string): string {
  return path.join(claudeSessionDir(), `${sessionID.replace(/[^\w.-]/g, "_")}.outcome.txt`)
}

// /clear starts a new session ID, so the manual hand-off is keyed by the
// transcript's project directory, which both sessions share.
function clearFile(transcriptPath: string): string {
  const project = path.basename(path.dirname(transcriptPath))
  return path.join(claudeSessionDir(), `clear-${project.replace(/[^\w.-]/g, "_")}.md`)
}

// ponytail: fixed window so a forgotten hand-off never leaks into an unrelated
// /clear much later; make it configurable if someone needs longer.
const CLEAR_HANDOFF_MAX_AGE_MS = 60 * 60 * 1000

async function precompact(input: HookInput): Promise<void> {
  const sessionID = input.session_id || "unknown"
  const trigger = input.trigger || ""
  const debug = isDebugEnabled()
  if (!input.transcript_path || !fs.existsSync(input.transcript_path)) {
    writeLog(`[context-optimizer] claude precompact skipped: no transcript (session=${sessionID})`)
    if (debug) recordPluginDebug(sessionID, trigger, { ok: false, status: "skipped", reason: "no transcript" })
    return
  }

  const docs = transcriptToDocs(input.transcript_path)
  const size = docs.reduce((total, doc) => total + doc.length, 0)
  const { min_chars } = resolveEffectiveConfig()

  if (!docs.length || size < min_chars) {
    writeLog(
      `[context-optimizer] claude precompact skipped: context size ${size} chars is below the threshold of ${min_chars} chars (docs=${docs.length}).`,
    )
    if (debug) {
      const reason = `context size ${size} chars is below min_chars ${min_chars}`
      recordPluginDebug(sessionID, trigger, { ok: false, status: "skipped", reason }, size)
    }
    return
  }

  const result = await runOptimizer({
    payload: {
      query: input.custom_instructions || DEFAULT_QUERY,
      docs,
      size,
      options: { min_input_size: min_chars },
    },
    sessionID,
  })

  writeLog(`claude precompact: ${formatOutcomeMessage(result)}`)

  // Debug mode: save the result for comparison only. Nothing is blocked or
  // handed off, stats are not recorded (the result is not used), and the
  // PostCompact hook reports both sizes once the native summary exists.
  if (debug) {
    const dir = recordPluginDebug(sessionID, trigger, result, size)
    writeLog(`[context-optimizer] debug: plugin result saved in ${dir}; native compaction proceeds`)
    return
  }

  // Manual /compact: the plugin output replaces Claude's summary. Block the
  // native compaction and hand off via /clear; exit 2 + stderr is shown to the
  // user. On failure we fall through and Claude compacts as usual.
  if (input.trigger === "manual" && result.ok && result.optimizedContext) {
    fs.mkdirSync(claudeSessionDir(), { recursive: true })
    fs.writeFileSync(clearFile(input.transcript_path), result.optimizedContext, "utf8")
    recordOptimizationStats(sessionID, result, "claude-code", "manual")
    process.stderr.write(
      `${formatOutcomeMessage(result)}\n` +
        "Optimized context saved; Claude's own compaction was skipped. Run /clear to continue with the optimized context.",
    )
    process.exitCode = 2
    return
  }

  fs.mkdirSync(claudeSessionDir(), { recursive: true })
  if (result.ok && result.optimizedContext) {
    // Only the restored content (no stats) travels through the hand-off file:
    // SessionStart additionalContext is fed to the model. Stats are persisted
    // via recordOptimizationStats and shown to the user through the outcome
    // file below.
    fs.writeFileSync(sessionFile(sessionID), result.optimizedContext, "utf8")
    recordOptimizationStats(sessionID, result, "claude-code", trigger)
  }
  // Claude Code discards a PreCompact hook's systemMessage, and exiting 2 here
  // would block the compaction; SessionStart shows this report instead, as a
  // systemMessage that renders in the UI without entering Claude's context.
  fs.writeFileSync(outcomeFile(sessionID), formatOutcomeMessage(result), "utf8")
}

/** Reads and removes a hand-off file; `stale` is true when it is older than the hand-off window. */
function consume(file: string): { text: string; stale: boolean } | null {
  if (!fs.existsSync(file)) return null
  const stale = Date.now() - fs.statSync(file).mtimeMs > CLEAR_HANDOFF_MAX_AGE_MS
  const text = fs.readFileSync(file, "utf8")
  fs.rmSync(file, { force: true })
  return { text, stale }
}

function sessionstart(input: HookInput): void {
  let file: string
  let outcome: { text: string; stale: boolean } | null = null
  if (input.source === "compact") {
    const sessionID = input.session_id || "unknown"
    file = sessionFile(sessionID)
    // A stale report belongs to a compaction that never finished; drop it.
    outcome = consume(outcomeFile(sessionID))
    if (outcome?.stale) outcome = null
  } else if (input.source === "clear" && input.transcript_path) file = clearFile(input.transcript_path)
  else return

  let handoff = consume(file)
  if (handoff && input.source === "clear" && handoff.stale) {
    writeLog("[context-optimizer] claude sessionstart dropped a stale /clear hand-off")
    handoff = null
  }
  if (!handoff && !outcome) return

  const output: Record<string, unknown> = {}
  if (outcome) output.systemMessage = outcome.text
  if (handoff) {
    output.hookSpecificOutput = {
      hookEventName: "SessionStart",
      additionalContext: `## Optimized Context\n\n${handoff.text}`,
    }
    writeLog(`[context-optimizer] claude sessionstart injected optimized context (${handoff.text.length} chars)`)
  }
  process.stdout.write(JSON.stringify(output))
}

function postcompact(input: HookInput): void {
  if (!isDebugEnabled()) return

  const summary = typeof input.compact_summary === "string" ? input.compact_summary : ""
  if (!summary) writeLog("[context-optimizer] debug: PostCompact had no compact_summary; saving an empty native.txt")
  const { report } = recordNativeDebug(input.session_id || "unknown", input.trigger || "", summary)
  writeLog(report)
  // PostCompact discards systemMessage; exit 2 shows stderr to the user and
  // cannot affect the (already finished) compaction.
  process.stderr.write(report)
  process.exitCode = 2
}

async function main(): Promise<void> {
  const mode = process.argv[2]
  let input: HookInput = {}
  try {
    input = JSON.parse((await readStdin()) || "{}")
  } catch {
    // Fail open on unparsable hook input.
  }

  if (mode === "precompact") await precompact(input)
  else if (mode === "sessionstart") sessionstart(input)
  else if (mode === "postcompact") postcompact(input)
}

// Only run as a hook when executed directly; tests import transcriptToDocs.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    writeLog(`[context-optimizer] claude hook failed: ${error}`)
    process.exitCode = 0
  })
}
