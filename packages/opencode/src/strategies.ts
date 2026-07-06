/**
 * Live per-turn optimization strategies.
 * Runs on `experimental.chat.messages.transform` (every chat turn), unlike the
 * Python pipeline which only runs at compaction time.
 *
 *  - deduplication: tool calls with an identical tool name + parameters keep
 *    only the newest output; older duplicates are replaced with a marker.
 *  - purgeErrors: string inputs of errored tool calls older than
 *    PURGE_ERROR_TURNS user turns are replaced with a marker (the error
 *    output itself is kept so the model remembers the failure).
 */

import {
  isProtectedTool,
  OPTIMIZED_ERROR_INPUT_MARKER,
  OPTIMIZED_OUTPUT_MARKER,
  PURGE_ERROR_TURNS,
  toolSignature,
} from "../../core/src/strategies.js"

export { OPTIMIZED_ERROR_INPUT_MARKER, OPTIMIZED_OUTPUT_MARKER } from "../../core/src/strategies.js"

interface ToolPartRef {
  part: any
  turn: number
}

function collectToolParts(messages: any[]): { refs: ToolPartRef[]; currentTurn: number } {
  const refs: ToolPartRef[] = []
  let turn = 0

  for (const msg of messages) {
    if (msg?.info?.role === "user") turn += 1
    const parts = Array.isArray(msg?.parts) ? msg.parts : []
    for (const part of parts) {
      if (part?.type === "tool" && typeof part.tool === "string" && part.state) {
        refs.push({ part, turn })
      }
    }
  }

  return { refs, currentTurn: turn }
}

function deduplicate(refs: ToolPartRef[]): number {
  const bySignature = new Map<string, any[]>()

  for (const { part } of refs) {
    if (part.state.status !== "completed") continue
    if (isProtectedTool(part.tool)) continue
    if (part.state.output === OPTIMIZED_OUTPUT_MARKER) continue

    const signature = toolSignature(part.tool, part.state.input)
    const group = bySignature.get(signature)
    if (group) group.push(part)
    else bySignature.set(signature, [part])
  }

  let optimized = 0
  for (const group of bySignature.values()) {
    for (const part of group.slice(0, -1)) {
      part.state.output = OPTIMIZED_OUTPUT_MARKER
      optimized += 1
    }
  }
  return optimized
}

function purgeErrors(refs: ToolPartRef[], currentTurn: number): number {
  let purged = 0

  for (const { part, turn } of refs) {
    if (part.state.status !== "error") continue
    if (isProtectedTool(part.tool)) continue
    if (currentTurn - turn < PURGE_ERROR_TURNS) continue

    const input = part.state.input
    if (!input || typeof input !== "object") continue

    let touched = false
    for (const key of Object.keys(input)) {
      if (typeof input[key] === "string" && input[key] !== OPTIMIZED_ERROR_INPUT_MARKER) {
        input[key] = OPTIMIZED_ERROR_INPUT_MARKER
        touched = true
      }
    }
    if (touched) purged += 1
  }

  return purged
}

/**
 * Mutates the messages array in place. Returns counts for logging.
 */
export function applyOptimizationStrategies(messages: unknown): { deduped: number; purgedErrors: number } {
  if (!Array.isArray(messages) || messages.length === 0) {
    return { deduped: 0, purgedErrors: 0 }
  }

  const { refs, currentTurn } = collectToolParts(messages)
  if (refs.length === 0) return { deduped: 0, purgedErrors: 0 }

  return {
    deduped: deduplicate(refs),
    purgedErrors: purgeErrors(refs, currentTurn),
  }
}
