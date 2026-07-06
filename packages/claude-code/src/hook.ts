#!/usr/bin/env node
/**
 * Claude Code adapter.
 *
 * Claude Code hooks cannot rewrite the compaction context directly, so this
 * adapter works in two phases:
 *  - "precompact":   runs on the PreCompact hook, optimizes the transcript
 *                    context via the Python bridge and stores the result per
 *                    session on disk.
 *  - "sessionstart": runs on the SessionStart hook (matcher "compact") and
 *                    injects the stored optimized context back into the fresh
 *                    session as additionalContext.
 *
 * Both phases fail open: on any error the hook exits 0 and Claude Code
 * proceeds untouched.
 */
import fs from "node:fs"
import path from "node:path"
import process from "node:process"
import { pathToFileURL } from "node:url"

import { runOptimizer } from "../../core/src/bridge.js"
import { recordOptimizationStats, resolveEffectiveConfig } from "../../core/src/config.js"
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

async function precompact(input: HookInput): Promise<void> {
  const sessionID = input.session_id || "unknown"
  if (!input.transcript_path || !fs.existsSync(input.transcript_path)) {
    writeLog(`[context-optimizer] claude precompact skipped: no transcript (session=${sessionID})`)
    return
  }

  const docs = transcriptToDocs(input.transcript_path)
  const size = docs.reduce((total, doc) => total + doc.length, 0)
  const { min_chars } = resolveEffectiveConfig()

  if (!docs.length || size < min_chars) {
    writeLog(
      `[context-optimizer] claude precompact skipped: context size ${size} chars is below the threshold of ${min_chars} chars (docs=${docs.length}).`,
    )
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

  writeLog(`[context-optimizer] claude ${formatOutcomeMessage(result)}`)

  if (result.ok && result.optimizedContext) {
    fs.mkdirSync(claudeSessionDir(), { recursive: true })
    fs.writeFileSync(sessionFile(sessionID), result.optimizedContext, "utf8")
    recordOptimizationStats(sessionID, result)
  }
}

function sessionstart(input: HookInput): void {
  if (input.source !== "compact") return

  const file = sessionFile(input.session_id || "unknown")
  if (!fs.existsSync(file)) return

  const optimized = fs.readFileSync(file, "utf8")
  fs.rmSync(file, { force: true })

  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: `## Optimized Context\n\n${optimized}`,
      },
    }),
  )
  writeLog(`[context-optimizer] claude sessionstart injected optimized context (${optimized.length} chars)`)
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
}

// Only run as a hook when executed directly; tests import transcriptToDocs.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    writeLog(`[context-optimizer] claude hook failed: ${error}`)
    process.exitCode = 0
  })
}
