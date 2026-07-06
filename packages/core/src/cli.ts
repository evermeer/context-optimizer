#!/usr/bin/env node
import process from "node:process"

import { runOptimizer } from "./bridge.js"
import {
  SAFE_CONFIG_KEYS,
  normalizeConfigKey,
  parseJsonValue,
  parseNumeric,
  readStoredConfig,
  readStoredStats,
  removeStoredConfig,
  resolveEffectiveConfig,
  writeStoredConfig,
} from "./config.js"
import { detectClaudeCode, detectOpenCode } from "./detect.js"
import { install } from "./install.js"

const HELP = `@evermeer/context-optimizer

Usage:
  context-optimizer install [--opencode] [--claude] [--skip-deps] [--skip-models]
  context-optimizer detect
  context-optimizer optimize          (reads a JSON payload from stdin, prints the result)
  context-optimizer stats             (show cumulative pruning/compaction statistics)
  context-optimizer config [get|set|reset] [key] [value]

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
    let value: unknown = rest.join(" ")
    if (normalizedKey === "model_limits") {
      value = parseJsonValue(value as string, null as any)
      if (!value || typeof value !== "object") {
        process.stderr.write("model_limits must be valid JSON.\n")
        return 1
      }
    } else {
      value = parseNumeric(value, Number.NaN)
      if (!Number.isFinite(value as number) || (value as number) <= 0) {
        process.stderr.write(`${normalizedKey} must be a positive number.\n`)
        return 1
      }
    }

    writeStoredConfig({ ...stored, [normalizedKey]: value })
    process.stdout.write(`${JSON.stringify(resolveEffectiveConfig(), null, 2)}\n`)
    return 0
  }

  process.stdout.write(`${JSON.stringify(resolveEffectiveConfig(), null, 2)}\n`)
  return 0
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
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
      return result.ok ? 0 : 1
    }

    case "stats": {
      const stats = readStoredStats()
      process.stdout.write(
        `${JSON.stringify(
          {
            totalSessions: Object.keys(stats.sessions).length,
            totalOptimizedChars: stats.totalOptimizedChars,
            totalOptimizations: stats.totalOptimizations,
          },
          null,
          2,
        )}\n`,
      )
      return 0
    }

    case "config":
      return runConfig(args)

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
