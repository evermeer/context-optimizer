/**
 * Shared optimization-strategy primitives used by both adapters:
 *  - OpenCode applies them live on every chat turn (messages.transform hook).
 *  - Claude Code applies them to the transcript at PreCompact time, the only
 *    point where its hooks allow rewriting what the optimizer sees.
 */

export const OPTIMIZED_OUTPUT_MARKER =
  "[Output removed to save context - information superseded or no longer needed]"
export const OPTIMIZED_ERROR_INPUT_MARKER = "[input removed due to failed tool call]"

export const PURGE_ERROR_TURNS = 4

export const PROTECTED_TOOLS = new Set([
  "task",
  "skill",
  "todowrite",
  "todoread",
  "batch",
  "plan_enter",
  "plan_exit",
  "write",
  "edit",
  "patch",
  "question",
])

export function isProtectedTool(tool: string): boolean {
  return PROTECTED_TOOLS.has(tool.toLowerCase())
}

function sortKeys(value: any): any {
  if (typeof value !== "object" || value === null) return value
  if (Array.isArray(value)) return value.map(sortKeys)

  const sorted: Record<string, unknown> = {}
  for (const key of Object.keys(value).sort()) {
    if (value[key] !== undefined && value[key] !== null) {
      sorted[key] = sortKeys(value[key])
    }
  }
  return sorted
}

/**
 * Stable identity for a tool call: same tool + same parameters (key order and
 * null/undefined entries ignored) means the newest occurrence supersedes the rest.
 */
export function toolSignature(tool: string, input: unknown): string {
  if (input === undefined || input === null) return tool
  return `${tool}::${JSON.stringify(sortKeys(input))}`
}
