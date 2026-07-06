import fs from "node:fs"
import path from "node:path"
import process from "node:process"

import { logPath } from "./paths.js"

export function writeDiagnostic(message: string): void {
  try {
    process.stderr.write(`${message}\n`)
  } catch {
    // If stderr is unavailable, keep failing open.
  }
}

export function writeLog(message: string): void {
  try {
    const file = logPath()
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.appendFileSync(file, `${new Date().toISOString()} ${message}\n`, "utf8")
  } catch (error) {
    writeDiagnostic(`[context-optimizer] logging failed: ${error}`)
  }
}
