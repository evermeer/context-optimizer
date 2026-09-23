/**
 * OpenCode adapter. Replaces the compaction summarizer's input with the
 * optimized context (see compactingSessions), runs the live per-turn
 * strategies, and exposes the /context-optimizer slash commands. All business
 * logic lives in core.
 */
import { runOptimizer } from "../../core/src/bridge.js"
import {
  SAFE_CONFIG_KEYS,
  normalizeConfigKey,
  parseConfigValue,
  readStoredConfig,
  formatStatsTable,
  readResults,
  recordOptimizationStats,
  removeStoredConfig,
  resolveEffectiveConfig,
  writeStoredConfig,
} from "../../core/src/config.js"
import { writeDiagnostic, writeLog } from "../../core/src/log.js"
import { logPath, pythonCliPath } from "../../core/src/paths.js"
import {
  buildPayload,
  formatOutcomeMessage,
  summarizeContext,
} from "../../core/src/payload.js"
import { applyOptimizationStrategies } from "./strategies.js"

export {
  applyOptimizationStrategies,
  OPTIMIZED_ERROR_INPUT_MARKER,
  OPTIMIZED_OUTPUT_MARKER,
} from "./strategies.js"

function formatJsonBlock(data: unknown): string {
  return `\n\n${JSON.stringify(data, null, 2)}\n`
}

function buildCommandOutput(title: string, body?: string): string {
  return [`[context-optimizer] ${title}`, body].filter(Boolean).join("\n\n")
}

function buildCommandHelp(): string {
  return buildCommandOutput(
    "available commands",
    [
      "/context-optimizer — show this help",
      "/context-optimizer context — show the current session token/context breakdown",
      "/context-optimizer stats — show cumulative pruning statistics",
      "/context-optimizer compact — run one compaction pass",
      "/context-optimizer config — show or update safe plugin settings",
    ].join("\n"),
  )
}

function buildConfigHelp(): string {
  return buildCommandOutput(
    "config commands",
    [
      "/context-optimizer config — show current settings",
      "/context-optimizer config get <key> — show one setting",
      "/context-optimizer config set <key> <value> — update a safe setting",
      "/context-optimizer config reset — clear saved settings",
      `safe keys: ${SAFE_CONFIG_KEYS.join(", ")}`,
    ].join("\n"),
  )
}

function normalizeCommandName(commandName: unknown): string {
  return String(commandName || "").trim().replace(/^\//, "")
}

/**
 * Flattens OpenCode session messages into optimizer docs, one per message,
 * mirroring how OpenCode serializes them for its compaction summarizer.
 */
export function messagesToDocs(messages: any[]): string[] {
  const docs: string[] = []
  for (const message of messages) {
    const role = message?.info?.role === "user" ? "User" : "Assistant"
    const lines: string[] = []
    for (const part of Array.isArray(message?.parts) ? message.parts : []) {
      if ((part?.type === "text" || part?.type === "reasoning") && part.text && !part.ignored) {
        lines.push(`[${role}]: ${part.text}`)
      } else if (part?.type === "tool" && part.state) {
        lines.push(`[tool ${part.tool}] ${JSON.stringify(part.state.input ?? {})}`)
        if (part.state.status === "completed" && part.state.output) lines.push(String(part.state.output))
        if (part.state.status === "error" && part.state.error) lines.push(`[error] ${part.state.error}`)
      }
    }
    const doc = lines.join("\n").trim()
    if (doc) docs.push(doc)
  }
  return docs
}

function resolveToastClient(dependencies: any = {}, input: any = {}, output: any = {}) {
  const client = dependencies.client || input?.client || output?.client || null
  const toastFn = client?.tui?.showToast
  return typeof toastFn === "function" ? toastFn.bind(client.tui) : null
}

async function showToast(toastFn: any, message: string, variant = "default"): Promise<void> {
  if (!toastFn) return

  try {
    await toastFn({ body: { message, variant } })
  } catch (error) {
    writeDiagnostic(`[context-optimizer] toast failed: ${error}`)
  }
}

export const id = "context-optimizer"

export const ContextOptimizerPlugin = async (dependencies: any = {}) => {
  try {
    const cliPath = pythonCliPath()
    const run = dependencies.runOptimizer || runOptimizer
    writeLog(`[context-optimizer] plugin loaded (log=${logPath()}, bridge=${cliPath})`)

    // OpenCode's `experimental.session.compacting` hook receives no messages
    // (its `context` starts empty). Right after it, compaction runs
    // `experimental.chat.messages.transform` on the exact messages it
    // serializes for the summarizer. So: flag the session in the first hook and
    // replace those messages with the optimized context in the second.
    // ponytail: 10s window guards against a flag that was never consumed
    // leaking into a later chat turn; the two hooks fire back to back.
    const compactingSessions = new Map<string, number>()
    const COMPACTING_FLAG_TTL_MS = 10_000

    const optimizeCompaction = async (sessionID: string, messages: any[]) => {
      const toast = resolveToastClient(dependencies)
      const lastUser = [...messages].reverse().find((message) => message?.info?.role === "user")
      const payload = buildPayload({ model: lastUser?.info?.model?.modelID }, { context: messagesToDocs(messages) })
      const minChars = resolveEffectiveConfig().min_chars

      if (!lastUser || !payload.docs.length) {
        writeLog(`[context-optimizer] optimization skipped: no compaction messages (docs=${payload.docs.length}).`)
        return
      }

      if (payload.size < minChars) {
        writeLog(
          `[context-optimizer] optimization skipped: context size ${payload.size} chars is below the threshold of ${minChars} chars (docs=${payload.docs.length}).`,
        )
        return
      }

      writeLog(
        `[context-optimizer] outbound docs: ${payload.docs.length} (size=${payload.size} chars, threshold=${minChars} chars)`,
      )

      const result = await run({
        payload: {
          ...payload,
          options: { min_input_size: minChars, ...payload.options },
        },
        sessionID,
        cliPath,
      })

      writeLog(formatOutcomeMessage(result))
      // Fail open: without optimized content the summarizer gets the original messages.
      if (result?.ok && result?.optimizedContext) {
        recordOptimizationStats(sessionID, result, "opencode")
        // In place: OpenCode keeps its own reference to this array.
        messages.splice(0, messages.length, {
          info: lastUser.info,
          parts: [{ type: "text", text: `## Optimized Context\n\n${result.optimizedContext}` }],
        })
        await showToast(toast, `[context-optimizer] optimized ${payload.docs.length} docs.`, "default")
      } else if (!result?.ok) {
        await showToast(
          toast,
          result?.reason || result?.message || result?.errorCode || "Context optimization failed.",
          "error",
        )
      }
    }

    const command = async (input: any = {}, output: any = {}) => {
      const commandName = normalizeCommandName(input.command)
      const args = String(input.arguments || "").trim()
      const sessionID = input.sessionID
      if (!commandName.startsWith("context-optimizer")) {
        return
      }
      const commandArgs = commandName.slice("context-optimizer".length).trim()
      const configInput = commandArgs.startsWith("config") ? commandArgs.slice("config".length).trim() : ""
      const configArgs = configInput || args

      const reply = (text: string) => {
        output.parts = [{ type: "text", text }]
        output.noReply = true
      }

      if (!commandName || commandName === "context-optimizer") {
        reply(buildCommandHelp())
        return
      }

      if (commandArgs === "context") {
        reply(buildCommandOutput("current session context", formatJsonBlock(summarizeContext(buildPayload(input, output)))))
        return
      }

      if (commandArgs === "stats") {
        reply(buildCommandOutput("cumulative pruning statistics", formatStatsTable(readResults())))
        return
      }

      if (commandArgs === "compact") {
        const payload = buildPayload(input, output)
        const result = await run({
          payload: {
            ...payload,
            query: args || payload.query,
            options: { min_input_size: resolveEffectiveConfig().min_chars, ...payload.options },
          },
          sessionID,
          cliPath,
        })

        reply(buildCommandOutput("compaction run", formatJsonBlock(result)))
        return
      }

      if (commandArgs.startsWith("config")) {
        const [action = "show", key = "", ...rest] = configArgs ? configArgs.split(/\s+/) : []
        const effective = resolveEffectiveConfig()

        if (action === "reset") {
          removeStoredConfig()
          reply(buildCommandOutput("config reset", "Saved settings cleared."))
          return
        }

        if (action === "get") {
          const normalizedKey = normalizeConfigKey(key)
          if (!normalizedKey) {
            reply(buildConfigHelp())
            return
          }

          reply(
            buildCommandOutput(
              `config get ${normalizedKey}`,
              formatJsonBlock({ [normalizedKey]: (effective as any)[normalizedKey] }),
            ),
          )
          return
        }

        if (action === "set") {
          const normalizedKey = normalizeConfigKey(key)
          if (!normalizedKey) {
            reply(buildConfigHelp())
            return
          }

          const stored = readStoredConfig()
          const parsed = parseConfigValue(normalizedKey, rest.join(" "))
          if (!parsed.ok) {
            reply(buildCommandOutput("config set failed", parsed.error as string))
            return
          }

          writeStoredConfig({ ...stored, [normalizedKey]: parsed.value })
          reply(buildCommandOutput("config updated", formatJsonBlock(resolveEffectiveConfig())))
          return
        }

        reply(buildCommandOutput("current settings", formatJsonBlock(effective)))
        return
      }

      reply(buildCommandHelp())
    }

    return {
      command: {
        "context-optimizer": {
          description: "Show context optimizer commands",
          template: buildCommandHelp(),
        },
        "context-optimizer context": {
          description: "Show the current session token/context breakdown",
          template: "Show the current session token/context breakdown for the active OpenCode session.",
        },
        "context-optimizer stats": {
          description: "Show cumulative pruning statistics across sessions",
          template: "Show cumulative pruning statistics for the context optimizer.",
        },
        "context-optimizer compact": {
          description: "Run a single compaction pass",
          template: "Run one compaction pass for the current session context.",
        },
        "context-optimizer config": {
          description: "Show or update safe plugin settings",
          template: buildConfigHelp(),
        },
      },
      "command.execute.before": command,
      "experimental.session.compacting": async (input: any) => {
        if (input?.sessionID) compactingSessions.set(input.sessionID, Date.now())
      },
      "experimental.chat.messages.transform": async (_input: any, output: any) => {
        try {
          const { deduped, purgedErrors } = applyOptimizationStrategies(output?.messages)
          if (deduped || purgedErrors) {
            writeLog(
              `[context-optimizer] live optimization: ${deduped} duplicate tool outputs removed, ${purgedErrors} errored tool inputs purged`,
            )
          }
        } catch (error) {
          writeDiagnostic(`[context-optimizer] live optimization failed: ${error}`)
        }

        const messages = output?.messages
        const sessionID = Array.isArray(messages) ? messages[0]?.info?.sessionID : undefined
        const flaggedAt = sessionID ? compactingSessions.get(sessionID) : undefined
        if (!sessionID || flaggedAt === undefined) return
        compactingSessions.delete(sessionID)
        if (Date.now() - flaggedAt > COMPACTING_FLAG_TTL_MS) return

        try {
          await optimizeCompaction(sessionID, messages)
        } catch (error) {
          writeLog(`[context-optimizer] compaction optimization failed: ${error}`)
        }
      },
    }
  } catch (error) {
    writeLog(`[context-optimizer] disabled during startup: ${error}`)
    return {}
  }
}

export const server = ContextOptimizerPlugin

export default { id, server }
