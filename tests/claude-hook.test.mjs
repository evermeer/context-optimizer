import assert from "node:assert/strict"
import childProcess from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { fileURLToPath, pathToFileURL } from "node:url"

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

function transcriptLine(type, content) {
  return JSON.stringify({ type, message: { role: type, content } })
}

function toolUse(id, name, input) {
  return { type: "tool_use", id, name, input }
}

function toolResult(toolUseId, text, isError = false) {
  return { type: "tool_result", tool_use_id: toolUseId, content: [{ type: "text", text }], is_error: isError }
}

function writeTranscript(lines) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ctxopt-transcript-"))
  const file = path.join(dir, "transcript.jsonl")
  fs.writeFileSync(file, lines.join("\n"), "utf8")
  return file
}

const { transcriptToDocs } = await import(pathToFileURL(HOOK).href)

test("transcriptToDocs dedupes identical tool calls, keeping the newest result", () => {
  const file = writeTranscript([
    transcriptLine("user", "please read a.ts"),
    transcriptLine("assistant", [toolUse("t1", "read", { filePath: "a.ts" })]),
    transcriptLine("user", [toolResult("t1", "old file content")]),
    transcriptLine("assistant", [toolUse("t2", "read", { filePath: "a.ts" })]),
    transcriptLine("user", [toolResult("t2", "new file content")]),
    transcriptLine("assistant", [toolUse("t3", "read", { filePath: "b.ts" })]),
    transcriptLine("user", [toolResult("t3", "other file content")]),
  ])

  const docs = transcriptToDocs(file)

  assert.ok(docs.includes("[tool read] new file content"))
  assert.ok(docs.includes("[tool read] other file content"))
  assert.ok(!docs.some((doc) => doc.includes("old file content")))
})

test("transcriptToDocs purges old errored tool results, keeps recent ones and prose", () => {
  const file = writeTranscript([
    transcriptLine("user", "turn 1"),
    transcriptLine("assistant", [toolUse("t1", "bash", { command: "explode" })]),
    transcriptLine("user", [toolResult("t1", "command failed: explode", true)]),
    transcriptLine("user", "turn 2"),
    transcriptLine("user", "turn 3"),
    transcriptLine("user", "turn 4"),
    transcriptLine("user", "turn 5"),
    transcriptLine("assistant", [toolUse("t2", "bash", { command: "explode2" })]),
    transcriptLine("user", [toolResult("t2", "command failed: explode2", true)]),
    transcriptLine("assistant", [{ type: "text", text: "summary of what happened" }]),
  ])

  const docs = transcriptToDocs(file)

  assert.ok(!docs.some((doc) => doc.includes("command failed: explode\n") || doc.endsWith("command failed: explode")))
  assert.ok(docs.some((doc) => doc.includes("command failed: explode2")))
  assert.ok(docs.includes("summary of what happened"))
  assert.ok(docs.includes("turn 1"))
})

test("transcriptToDocs never optimizes away protected tools and skips orphan results", () => {
  const file = writeTranscript([
    transcriptLine("user", "go"),
    transcriptLine("assistant", [toolUse("t1", "write", { filePath: "a.ts", content: "x" })]),
    transcriptLine("user", [toolResult("t1", "wrote a.ts")]),
    transcriptLine("assistant", [toolUse("t2", "write", { filePath: "a.ts", content: "x" })]),
    transcriptLine("user", [toolResult("t2", "wrote a.ts again")]),
    transcriptLine("user", [toolResult("missing-id", "orphan result")]),
  ])

  const docs = transcriptToDocs(file)

  assert.ok(docs.includes("[tool write] wrote a.ts"))
  assert.ok(docs.includes("[tool write] wrote a.ts again"))
  assert.ok(!docs.some((doc) => doc.includes("orphan result")))
})
