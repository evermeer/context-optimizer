/**
 * OpenCode adapter. Hooks into `experimental.session.compacting` and exposes
 * the /context-optimizer slash commands. All business logic lives in core.
 */
import {
  createSessionWarningTracker,
  runOptimizer,
  type SessionWarningTracker,
} from "../../core/src/bridge.js"
import {
  SAFE_CONFIG_KEYS,
  parseJsonValue,
  parseNumeric,
  readStoredConfig,
  readStoredStats,
  recordOptimizationStats,
  removeStoredConfig,
  resolveEffectiveConfig,
  writeStoredConfig,
} from "../../core/src/config.js"
import { writeDiagnostic, writeLog } from "../../core/src/log.js"
import { logPath, pythonCliPath } from "../../core/src/paths.js"
import {
  applyOptimizedContext,
  buildPayload,
  formatOutcomeMessage,
  summarizeContext,
} from "../../core/src/payload.js"

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
      "/context-optimizer compress — run one compression pass",
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

function normalizeConfigKey(key: unknown): string | null {
  const normalized = String(key || "").trim().toLowerCase()
  return (SAFE_CONFIG_KEYS as readonly string[]).includes(normalized) ? normalized : null
}

function resolveToastClient(dependencies: any = {}, input: any = {}, output: any = {}) {
  const client = dependencies.client || dependencies.ui || input?.client || output?.client || null
  if (!client) return null

  const candidates = [
    client.tui?.showToast,
    client.showToast,
    client.toast?.show,
    client.toast,
    client.tui?.toast,
  ]

  const toastFn = candidates.find((candidate) => typeof candidate === "function")
  return toastFn ? toastFn.bind(client.tui || client) : null
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
    const tracker: SessionWarningTracker = createSessionWarningTracker()
    writeLog(`[context-optimizer] plugin loaded (log=${logPath()}, bridge=${cliPath})`)

    const optimizeContext = async (input: any, output: any) => {
      const toast = resolveToastClient(dependencies, input, output)
      const payload = buildPayload(input, output)
      const minChars = resolveEffectiveConfig().min_chars

      if (!payload.docs.length) {
        writeLog(
          `[context-optimizer] optimization skipped: no compaction documents were provided (size=${payload.size} chars, docs=${payload.docs.length}).`,
        )
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
        sessionID: input?.sessionID,
        cliPath,
        tracker,
      })

      writeLog(formatOutcomeMessage(result))
      if (result?.ok && result?.optimizedContext) {
        recordOptimizationStats(input?.sessionID, result)
      }
      // applyOptimizedContext is fail-open: it only rewrites output.context
      // when the optimizer returned real optimized content.
      applyOptimizedContext(output, result)

      if (result?.ok && result?.optimizedContext) {
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
        const storedStats = readStoredStats()
        reply(
          buildCommandOutput(
            "cumulative pruning statistics",
            formatJsonBlock({
              totalSessions: Object.keys(storedStats.sessions).length,
              totalPrunedChars: storedStats.totalPrunedChars,
              totalOptimizations: storedStats.totalOptimizations,
            }),
          ),
        )
        return
      }

      if (commandArgs === "compress") {
        const payload = buildPayload(input, output)
        const result = await run({
          payload: {
            ...payload,
            query: args || payload.query,
            options: { min_input_size: resolveEffectiveConfig().min_chars, ...payload.options },
          },
          sessionID,
          cliPath,
          tracker,
        })

        reply(buildCommandOutput("compression run", formatJsonBlock(result)))
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
          let value: unknown = rest.join(" ")
          if (normalizedKey === "model_limits") {
            value = parseJsonValue(value as string, null as any)
            if (!value || typeof value !== "object") {
              reply(buildCommandOutput("config set failed", "model_limits must be valid JSON."))
              return
            }
          } else {
            value = parseNumeric(value, Number.NaN)
            if (!Number.isFinite(value as number) || (value as number) <= 0) {
              reply(buildCommandOutput("config set failed", `${normalizedKey} must be a positive number.`))
              return
            }
          }

          writeStoredConfig({ ...stored, [normalizedKey]: value })
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
        "context-optimizer compress": {
          description: "Run a single compression pass",
          template: "Run one compression pass for the current session context.",
        },
        "context-optimizer config": {
          description: "Show or update safe plugin settings",
          template: buildConfigHelp(),
        },
      },
      "command.execute.before": command,
      "experimental.session.compacting": optimizeContext,
      "experimental.response.cleanup": optimizeContext,
    }
  } catch (error) {
    writeLog(`[context-optimizer] disabled during startup: ${error}`)
    return {}
  }
}

export const server = ContextOptimizerPlugin

export default { id, server }
