#!/usr/bin/env node
import process from "node:process"

import { runOptimizer } from "./bridge.js"
import { detectClaudeCode, detectOpenCode } from "./detect.js"
import { install } from "./install.js"

const HELP = `@evermeer/context-optimizer

Usage:
  context-optimizer install [--opencode] [--claude] [--skip-deps] [--skip-models]
  context-optimizer detect
  context-optimizer optimize   (reads a JSON payload from stdin, prints the result)

install
  Without flags the installer detects OpenCode and Claude Code and installs
  the adapter for every environment it finds. Flags force a specific target.
  --skip-deps    skip "pip install sentence-transformers llmlingua"
  --skip-models  skip the model warm-up download
`

async function main(): Promise<number> {
  const [command, ...rest] = process.argv.slice(2)
  const flags = new Set(rest)

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
