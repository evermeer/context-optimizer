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

import { runOptimizer } from "../../core/src/bridge.js"
import { recordOptimizationStats, resolveEffectiveConfig } from "../../core/src/config.js"
import { writeLog } from "../../core/src/log.js"
import { claudeSessionDir } from "../../core/src/paths.js"
import { DEFAULT_QUERY, formatOutcomeMessage } from "../../core/src/payload.js"

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

export function transcriptToDocs(transcriptPath: string): string[] {
  const raw = fs.readFileSync(transcriptPath, "utf8")
  const docs: string[] = []

  for (const line of raw.split("\n")) {
    if (!line.trim()) continue
    try {
      const entry = JSON.parse(line)
      docs.push(...extractTexts(entry?.message?.content))
    } catch {
      // Skip malformed transcript lines.
    }
  }

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

main().catch((error) => {
  writeLog(`[context-optimizer] claude hook failed: ${error}`)
  process.exitCode = 0
})
