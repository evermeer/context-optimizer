import childProcess from "node:child_process"
import fs from "node:fs"
import process from "node:process"

import { claudeConfigDir, opencodeConfigDir } from "./paths.js"

export function commandExists(command: string): boolean {
  const probe = process.platform === "win32" ? "where" : "which"
  try {
    const result = childProcess.spawnSync(probe, [command], { stdio: "ignore" })
    return result.status === 0
  } catch {
    return false
  }
}

export function detectOpenCode(): boolean {
  return fs.existsSync(opencodeConfigDir()) || commandExists("opencode")
}

export function detectClaudeCode(): boolean {
  return fs.existsSync(claudeConfigDir()) || commandExists("claude")
}
