import childProcess from "node:child_process"
import process from "node:process"

import { resolveEffectiveConfig } from "./config.js"
import { writeDiagnostic, writeLog } from "./log.js"
import { pythonCliPath } from "./paths.js"
import type { OptimizerPayload, OptimizerResult } from "./payload.js"

export function resolvePythonCommand(): string[] {
  if (process.env.CONTEXT_OPTIMIZER_PYTHON) {
    return [process.env.CONTEXT_OPTIMIZER_PYTHON]
  }

  return process.platform === "win32" ? ["py", "-3"] : ["python3"]
}

export function normalizePythonResult(stdout: string): OptimizerResult {
  const parsed = JSON.parse(stdout)
  if (parsed.ok) {
    return {
      ok: true,
      optimizedContext: parsed.optimized_context || "",
      initialSize: parsed.initial_size,
      finalSize: parsed.final_size,
      status: parsed.status || (parsed.optimized_context ? "optimized" : "no_optimization"),
      reason: parsed.reason || "",
    }
  }

  return {
    ok: false,
    errorCode: parsed.error_code || "runtime_error",
    message: parsed.message || "Unknown error",
    status: "failed",
    reason: parsed.reason || parsed.message || "Unknown error",
  }
}

// ponytail: unbounded per-process set; entries are tiny strings, add eviction if it ever matters.
const warned = new Set<string>()

export function warnOnce(sessionID: string | undefined, message: string): boolean {
  const key = `${sessionID || "global"}:${message}`
  if (warned.has(key)) return false

  warned.add(key)
  writeLog(`[context-optimizer] ${message}`)
  return true
}

export interface RunOptimizerOptions {
  payload: Partial<OptimizerPayload> & Record<string, unknown>
  sessionID?: string
  cliPath?: string
  timeoutMs?: number
}

/** Spawn the Python bridge, feed it the payload as JSON on stdin, and parse the JSON reply. */
export function runOptimizer({
  payload,
  sessionID,
  cliPath = pythonCliPath(),
  timeoutMs = resolveEffectiveConfig().timeout_ms,
}: RunOptimizerOptions): Promise<OptimizerResult> {
  const python = resolvePythonCommand()

  return new Promise<OptimizerResult>((resolve) => {
    const child = childProcess.spawn(python[0], [...python.slice(1), cliPath], {
      stdio: ["pipe", "pipe", "pipe"],
    })
    let stdout = ""
    let stderr = ""
    let settled = false

    const finish = (result: OptimizerResult) => {
      if (settled) return
      settled = true
      resolve(result)
    }

    const timer = setTimeout(() => {
      child.kill()
      finish({ ok: false, errorCode: "timeout", message: "Python optimizer timed out" })
    }, timeoutMs)

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString()
    })

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString()
    })

    child.on("error", (error) => {
      clearTimeout(timer)
      finish({ ok: false, errorCode: "python_missing", message: String(error) })
    })

    child.stdin.on("error", () => {
      // Ignore stdin pipe errors (e.g. EPIPE when the child exits before we
      // finish writing). The "error"/"close" handlers settle the promise.
    })

    child.on("close", () => {
      clearTimeout(timer)
      try {
        finish(normalizePythonResult(stdout))
      } catch (error) {
        finish({
          ok: false,
          errorCode: "runtime_error",
          message: `${error}${stderr ? `\n${stderr}` : ""}`.trim(),
        })
      }
    })

    try {
      child.stdin.write(JSON.stringify(payload))
      child.stdin.end()
    } catch (error) {
      writeDiagnostic(`[context-optimizer] stdin write failed: ${error}`)
    }
  }).then((result) => {
    if (!result.ok) {
      warnOnce(sessionID, `${result.errorCode}: ${result.message}`)
    }
    return result
  })
}
