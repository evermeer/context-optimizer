#!/usr/bin/env node
import process from "node:process"

import { runOptimizer } from "./bridge.js"
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
} from "./config.js"
import { findDebugCompaction, isDebugEnabled, setDebugEnabled } from "./debug.js"
import { detectClaudeCode, detectOpenCode } from "./detect.js"
import { install } from "./install.js"
import { debugDir } from "./paths.js"

const HELP = `@evermeer/context-optimizer

Usage:
  context-optimizer install [--opencode] [--claude] [--skip-deps] [--skip-models]
  context-optimizer detect
  context-optimizer optimize          (reads a JSON payload from stdin, prints the result)
  context-optimizer stats             (show cumulative pruning/compaction statistics)
  context-optimizer config [get|set|reset] [key] [value]
  context-optimizer debug [on|off|status|latest] [session-id]

install
  Without flags the installer detects OpenCode and Claude Code and installs
  the adapter for every environment it finds. Flags force a specific target.
  --skip-deps    skip "pip install sentence-transformers llmlingua"
  --skip-models  skip the model warm-up download

config
  context-optimizer config                       show current settings
  context-optimizer config get <key>              show one setting
  context-optimizer config set <key> <value>      update a safe setting
  context-optimizer config reset                  clear saved settings
  safe keys: ${SAFE_CONFIG_KEYS.join(", ")}

debug (Claude Code)
  context-optimizer debug on                     run the plugin and Claude's native compaction side by side
  context-optimizer debug off                    back to plugin-only manual /compact (default)
  context-optimizer debug status                 show whether debug mode is on and where logs go
  context-optimizer debug latest [session-id]    print the newest compared compaction's files as JSON
`

function runConfig(args: string[]): number {
  const [action = "show", key = "", ...rest] = args

  if (action === "reset") {
    removeStoredConfig()
    process.stdout.write("Saved settings cleared.\n")
    return 0
  }

  if (action === "get") {
    const normalizedKey = normalizeConfigKey(key)
    if (!normalizedKey) {
      process.stderr.write(`Unknown key. Safe keys: ${SAFE_CONFIG_KEYS.join(", ")}\n`)
      return 1
    }
    process.stdout.write(
      `${JSON.stringify({ [normalizedKey]: (resolveEffectiveConfig() as any)[normalizedKey] }, null, 2)}\n`,
    )
    return 0
  }

  if (action === "set") {
    const normalizedKey = normalizeConfigKey(key)
    if (!normalizedKey) {
      process.stderr.write(`Unknown key. Safe keys: ${SAFE_CONFIG_KEYS.join(", ")}\n`)
      return 1
    }

    const stored = readStoredConfig()
    const parsed = parseConfigValue(normalizedKey, rest.join(" "))
    if (!parsed.ok) {
      process.stderr.write(`${parsed.error}\n`)
      return 1
    }

    writeStoredConfig({ ...stored, [normalizedKey]: parsed.value })
    process.stdout.write(`${JSON.stringify(resolveEffectiveConfig(), null, 2)}\n`)
    return 0
  }

  process.stdout.write(`${JSON.stringify(resolveEffectiveConfig(), null, 2)}\n`)
  return 0
}

function runDebug(args: string[]): number {
  const [action = "status", sessionID] = args

  if (action === "on" || action === "off") {
    setDebugEnabled(action === "on")
    const override = process.env.CONTEXT_OPTIMIZER_DEBUG
      ? ` (note: CONTEXT_OPTIMIZER_DEBUG=${process.env.CONTEXT_OPTIMIZER_DEBUG} overrides this setting)`
      : ""
    process.stdout.write(
      action === "on"
        ? `[context-optimizer] debug mode on${override}. Compaction now runs both the plugin and Claude's native compact; ` +
            `the session continues with the native summary. Both results are saved under ${debugDir()}/<session-id>/<timestamp>/. ` +
            "Compare them in a new session with /context-optimizer:evaluate.\n"
        : `[context-optimizer] debug mode off${override}. Manual /compact is plugin-only again.\n`,
    )
    return 0
  }

  if (action === "status") {
    process.stdout.write(`[context-optimizer] debug mode ${isDebugEnabled() ? "on" : "off"}. Logs: ${debugDir()}\n`)
    return 0
  }

  if (action === "latest") {
    const compaction = findDebugCompaction(sessionID)
    if (!compaction) {
      process.stderr.write(
        `No debug compaction found${sessionID ? ` for session ${sessionID}` : ""} in ${debugDir()}. ` +
          "Turn debug mode on and compact first.\n",
      )
      return 1
    }
    process.stdout.write(`${JSON.stringify(compaction, null, 2)}\n`)
    return 0
  }

  process.stderr.write("Usage: context-optimizer debug [on|off|status|latest] [session-id]\n")
  return 1
}

async function main(): Promise<number> {
  const [command, ...args] = process.argv.slice(2)
  const flags = new Set(args)

  switch (command) {
    case "install":
      install({
        opencode: flags.has("--opencode"),
        claude: flags.has("--claude"),
        skipDeps: flags.has("--skip-deps"),
        skipModels: flags.has("--skip-models"),
      })
      return 0

    case "detect": {
      const opencode = detectOpenCode()
      const claude = detectClaudeCode()
      process.stdout.write(`OpenCode:    ${opencode ? "detected" : "not found"}\n`)
      process.stdout.write(`Claude Code: ${claude ? "detected" : "not found"}\n`)
      return opencode || claude ? 0 : 1
    }

    case "optimize": {
      const chunks: Buffer[] = []
      for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
      const payload = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")
      const result = await runOptimizer({ payload })
      // Same as the adapters: only a real optimization counts toward stats.
      if (result.ok && result.optimizedContext) recordOptimizationStats(payload.sessionID, result, "cli")
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
      return result.ok ? 0 : 1
    }

    case "stats": {
      process.stdout.write(`${formatStatsTable(readResults())}\n`)
      return 0
    }

    case "config":
      return runConfig(args)

    case "debug":
      return runDebug(args)

    default:
      process.stdout.write(HELP)
      return command && command !== "help" && command !== "--help" ? 1 : 0
  }
}

main()
  .then((code) => {
    process.exitCode = code
  })
  .catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : error}\n`)
    process.exitCode = 1
  })
