import assert from "node:assert/strict"
import childProcess from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

const HOOK = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "claude-hook.js")

function runHook(mode, input, home) {
  return childProcess.spawnSync("node", [HOOK, mode], {
    input: JSON.stringify(input),
    encoding: "utf8",
    env: { ...process.env, CONTEXT_OPTIMIZER_HOME: home },
  })
}

test("sessionstart injects and consumes the stored optimized context", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ctxopt-claude-"))
  const sessionDir = path.join(home, "claude-sessions")
  fs.mkdirSync(sessionDir, { recursive: true })
  fs.writeFileSync(path.join(sessionDir, "abc.md"), "the optimized bits", "utf8")

  const result = runHook("sessionstart", { session_id: "abc", source: "compact" }, home)

  assert.equal(result.status, 0)
  const output = JSON.parse(result.stdout)
  assert.equal(output.hookSpecificOutput.hookEventName, "SessionStart")
  assert.match(output.hookSpecificOutput.additionalContext, /## Optimized Context\n\nthe optimized bits/)
  assert.equal(fs.existsSync(path.join(sessionDir, "abc.md")), false, "session file is consumed")
})

test("sessionstart stays silent for non-compact sources", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ctxopt-claude-"))
  const result = runHook("sessionstart", { session_id: "abc", source: "startup" }, home)

  assert.equal(result.status, 0)
  assert.equal(result.stdout, "")
})

test("precompact fails open on a missing transcript", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ctxopt-claude-"))
  const result = runHook("precompact", { session_id: "abc", transcript_path: path.join(home, "nope.jsonl") }, home)

  assert.equal(result.status, 0)
})
