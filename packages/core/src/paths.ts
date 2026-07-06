import os from "node:os"
import path from "node:path"
import process from "node:process"

/** Shared data directory used by every adapter: log, config, stats, python bridge. */
export function dataDir(): string {
  return process.env.CONTEXT_OPTIMIZER_HOME || path.join(os.homedir(), ".context-optimizer")
}

export function logPath(): string {
  return path.join(dataDir(), "context-optimizer.log")
}

export function configPath(): string {
  return path.join(dataDir(), "config.json")
}

export function statsPath(): string {
  return path.join(dataDir(), "stats.json")
}

export function pythonDir(): string {
  return path.join(dataDir(), "python")
}

export function pythonCliPath(): string {
  return process.env.CONTEXT_OPTIMIZER_CLI || path.join(pythonDir(), "context_optimizer_cli.py")
}

/** Per-session hand-off files between the Claude Code PreCompact and SessionStart hooks. */
export function claudeSessionDir(): string {
  return path.join(dataDir(), "claude-sessions")
}

export function opencodeConfigDir(): string {
  return path.join(os.homedir(), ".config", "opencode")
}

export function claudeConfigDir(): string {
  return path.join(os.homedir(), ".claude")
}
