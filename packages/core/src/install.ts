import childProcess from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import process from "node:process"
import { fileURLToPath } from "node:url"

import { resolvePythonCommand } from "./bridge.js"
import { detectClaudeCode, detectOpenCode } from "./detect.js"
import { claudeConfigDir, dataDir, opencodeConfigDir, pythonDir } from "./paths.js"

const HOOK_MARKER = "context-optimizer"

export interface InstallOptions {
  opencode?: boolean
  claude?: boolean
  skipDeps?: boolean
  skipModels?: boolean
}

function log(message: string): void {
  process.stdout.write(`${message}\n`)
}

/** Root of the installed npm package (dist/ and python/ live directly under it). */
function packageRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
}

function runCommand(command: string, args: string[], label: string, cwd?: string): void {
  log(`> ${label}`)
  const result = childProcess.spawnSync(command, args, { stdio: "inherit", cwd })
  if (result.error || result.status !== 0) {
    throw new Error(`${label} failed${result.error ? `: ${result.error}` : ` (exit code ${result.status})`}`)
  }
}

export function checkNode(): void {
  const major = Number.parseInt(process.versions.node.split(".")[0], 10)
  if (major < 18) {
    throw new Error(`Node.js 18 or newer is required (found ${process.versions.node}).`)
  }
  log(`Node.js ${process.versions.node} OK`)
}

export function checkPython(): string[] {
  const python = resolvePythonCommand()
  const result = childProcess.spawnSync(python[0], [...python.slice(1), "--version"], { encoding: "utf8" })
  if (result.error || result.status !== 0) {
    throw new Error(
      `Python was not found (tried "${python.join(" ")}"). Install Python 3.9+ or set CONTEXT_OPTIMIZER_PYTHON to your interpreter.`,
    )
  }
  log(`${(result.stdout || result.stderr).trim()} OK`)
  return python
}

export function installPythonDependencies(python: string[]): void {
  runCommand(
    python[0],
    [...python.slice(1), "-m", "pip", "install", "sentence-transformers", "llmlingua"],
    "pip install sentence-transformers llmlingua",
  )
}

export function copyPythonFiles(): void {
  const source = path.join(packageRoot(), "python")
  const target = pythonDir()
  fs.mkdirSync(target, { recursive: true })
  for (const file of fs.readdirSync(source)) {
    if (!file.endsWith(".py")) continue
    fs.copyFileSync(path.join(source, file), path.join(target, file))
  }
  log(`Python bridge installed in ${target}`)
}

/** First run downloads several GB of models from Hugging Face; warm the cache once. */
export function downloadModels(python: string[]): void {
  log("Downloading models (first run only, this can take a while)...")
  // Run from the installed python dir so `python -c` resolves the module via cwd.
  runCommand(
    python[0],
    [...python.slice(1), "-c", "from context_optimizer import ContextOptimizer; ContextOptimizer()"],
    "model warm-up",
    pythonDir(),
  )
}

export function installOpenCodeAdapter(): void {
  const pluginsDir = path.join(opencodeConfigDir(), "plugins")
  fs.mkdirSync(pluginsDir, { recursive: true })
  fs.copyFileSync(path.join(packageRoot(), "dist", "opencode.js"), path.join(pluginsDir, "context-optimizer.js"))
  log(`OpenCode plugin installed in ${pluginsDir}`)
}

interface HookCommand {
  type: "command"
  command: string
}

interface HookEntry {
  matcher?: string
  hooks: HookCommand[]
}

function upsertHook(entries: HookEntry[], entry: HookEntry): HookEntry[] {
  const kept = entries.filter(
    (existing) => !existing.hooks?.some((hook) => String(hook.command || "").includes(HOOK_MARKER)),
  )
  return [...kept, entry]
}

export function installClaudeAdapter(): void {
  const hookScript = path.join(dataDir(), "claude-hook.js")
  fs.mkdirSync(dataDir(), { recursive: true })
  fs.copyFileSync(path.join(packageRoot(), "dist", "claude-hook.js"), hookScript)

  const settingsPath = path.join(claudeConfigDir(), "settings.json")
  let settings: Record<string, any> = {}
  try {
    settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"))
  } catch {
    // Missing or invalid settings file: start fresh.
  }

  const hooks = settings.hooks && typeof settings.hooks === "object" ? settings.hooks : {}
  const nodeCommand = (mode: string) => `node "${hookScript}" ${mode}`

  hooks.PreCompact = upsertHook(Array.isArray(hooks.PreCompact) ? hooks.PreCompact : [], {
    hooks: [{ type: "command", command: nodeCommand("precompact") }],
  })
  hooks.SessionStart = upsertHook(Array.isArray(hooks.SessionStart) ? hooks.SessionStart : [], {
    matcher: "compact",
    hooks: [{ type: "command", command: nodeCommand("sessionstart") }],
  })

  settings.hooks = hooks
  fs.mkdirSync(claudeConfigDir(), { recursive: true })
  fs.writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8")
  log(`Claude Code hooks registered in ${settingsPath}`)
}

export function install(options: InstallOptions = {}): void {
  const explicit = options.opencode || options.claude
  const targetOpenCode = explicit ? !!options.opencode : detectOpenCode()
  const targetClaude = explicit ? !!options.claude : detectClaudeCode()

  if (!targetOpenCode && !targetClaude) {
    throw new Error(
      "Neither OpenCode nor Claude Code was detected. Install one of them first, or force a target with --opencode or --claude.",
    )
  }

  checkNode()
  const python = checkPython()

  if (!options.skipDeps) {
    installPythonDependencies(python)
  }

  copyPythonFiles()

  if (!options.skipModels) {
    downloadModels(python)
  }

  if (targetOpenCode) installOpenCodeAdapter()
  if (targetClaude) installClaudeAdapter()

  log("Done.")
  if (targetOpenCode) log("- OpenCode: restart OpenCode; the plugin loads automatically.")
  if (targetClaude) log("- Claude Code: restart Claude Code; the PreCompact/SessionStart hooks are active.")
}
