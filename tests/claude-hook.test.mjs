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

test("sessionstart after /clear injects the project hand-off, dropping stale ones", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ctxopt-claude-"))
  const sessionDir = path.join(home, "claude-sessions")
  fs.mkdirSync(sessionDir, { recursive: true })
  const handoff = path.join(sessionDir, "clear-my-project.md")
  // /clear gets a new session ID; only the project dir links it to the blocked /compact.
  const input = { session_id: "new-id", source: "clear", transcript_path: path.join(home, "my-project", "new-id.jsonl") }

  fs.writeFileSync(handoff, "the optimized bits", "utf8")
  const fresh = runHook("sessionstart", input, home)
  assert.equal(fresh.status, 0)
  assert.match(JSON.parse(fresh.stdout).hookSpecificOutput.additionalContext, /the optimized bits/)
  assert.equal(fs.existsSync(handoff), false, "hand-off is consumed")

  fs.writeFileSync(handoff, "old bits", "utf8")
  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000)
  fs.utimesSync(handoff, twoHoursAgo, twoHoursAgo)
  const stale = runHook("sessionstart", input, home)
  assert.equal(stale.stdout, "")
  assert.equal(fs.existsSync(handoff), false, "stale hand-off is removed")
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

// --- debug mode ---

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "cli.js")

/** A stand-in Python bridge that always returns the given optimized context. */
function fakeBridge(home, optimized) {
  const file = path.join(home, "fake_bridge.py")
  fs.writeFileSync(
    file,
    `import json, sys\nsys.stdin.read()\nprint(json.dumps({"ok": True, "optimized_context": ${JSON.stringify(optimized)}, "initial_size": 5000, "final_size": ${optimized.length}}))\n`,
    "utf8",
  )
  return file
}

function runWithEnv(args, input, env) {
  return childProcess.spawnSync("node", args, {
    input: input === undefined ? "" : JSON.stringify(input),
    encoding: "utf8",
    env: { ...process.env, ...env },
  })
}

function bigTranscript() {
  return writeTranscript([transcriptLine("user", "x".repeat(3000)), transcriptLine("assistant", "y".repeat(3000))])
}

test("manual precompact without debug mode still blocks native compaction", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ctxopt-claude-"))
  const env = { CONTEXT_OPTIMIZER_HOME: home, CONTEXT_OPTIMIZER_CLI: fakeBridge(home, "OPTIMIZED") }
  const result = runWithEnv([HOOK, "precompact"], { session_id: "s1", trigger: "manual", transcript_path: bigTranscript() }, env)

  assert.equal(result.status, 2)
  assert.equal(fs.existsSync(path.join(home, "debug")), false)
})

test("debug mode runs both compactions, saves both results, and reports the sizes", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ctxopt-claude-"))
  const env = { CONTEXT_OPTIMIZER_HOME: home, CONTEXT_OPTIMIZER_CLI: fakeBridge(home, "OPTIMIZED") }
  assert.equal(runWithEnv([CLI, "debug", "on"], undefined, env).status, 0)

  const transcript = bigTranscript()
  const pre = runWithEnv([HOOK, "precompact"], { session_id: "s1", trigger: "manual", transcript_path: transcript }, env)
  assert.equal(pre.status, 0, "native compaction is not blocked")
  assert.equal(fs.existsSync(path.join(home, "claude-sessions")), false, "no hand-off: the session keeps the native summary")

  const native = "N".repeat(18)
  const post = runWithEnv([HOOK, "postcompact"], { session_id: "s1", trigger: "manual", compact_summary: native }, env)
  assert.equal(post.status, 2, "exit 2 shows the report to the user")
  assert.match(post.stderr, /Native compact: 18 chars/)
  assert.match(post.stderr, /Plugin result: {2}9 chars, 50% of the native size \(50% smaller\)/)
  assert.match(post.stderr, /evaluate s1/)

  const [stamp] = fs.readdirSync(path.join(home, "debug", "s1")).filter((name) => name !== "index.md")
  const dir = path.join(home, "debug", "s1", stamp)
  assert.equal(fs.readFileSync(path.join(dir, "plugin.txt"), "utf8"), "OPTIMIZED")
  assert.equal(fs.readFileSync(path.join(dir, "native.txt"), "utf8"), native)
  const index = fs.readFileSync(path.join(home, "debug", "s1", "index.md"), "utf8")
  assert.match(index, new RegExp(`\\[plugin\\]\\(${stamp}/plugin.txt\\)`))
  assert.match(index, /\| 50% \|/)

  const latest = runWithEnv([CLI, "debug", "latest"], undefined, env)
  assert.equal(latest.status, 0)
  const info = JSON.parse(latest.stdout)
  assert.equal(info.sessionID, "s1")
  assert.equal(info.plugin, path.join(dir, "plugin.txt"))
  assert.equal(info.native, path.join(dir, "native.txt"))
  assert.equal(info.evaluation, path.join(dir, "evaluation.md"))
  assert.equal(info.nativeChars, 18)
  assert.equal(info.pluginChars, 9)

  assert.equal(runWithEnv([CLI, "debug", "off"], undefined, env).status, 0)
  const quiet = runWithEnv([HOOK, "postcompact"], { session_id: "s1", trigger: "manual", compact_summary: native }, env)
  assert.equal(quiet.status, 0, "postcompact does nothing outside debug mode")
  assert.equal(quiet.stderr, "")
})

test("debug mode reports why the plugin produced no result", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ctxopt-claude-"))
  const env = { CONTEXT_OPTIMIZER_HOME: home, CONTEXT_OPTIMIZER_DEBUG: "1" }
  const small = writeTranscript([transcriptLine("user", "tiny")])

  assert.equal(runWithEnv([HOOK, "precompact"], { session_id: "s2", trigger: "auto", transcript_path: small }, env).status, 0)
  const post = runWithEnv([HOOK, "postcompact"], { session_id: "s2", trigger: "auto", compact_summary: "summary" }, env)

  assert.equal(post.status, 2)
  assert.match(post.stderr, /Plugin result: {2}none \(skipped: context size 4 chars is below min_chars 2000\)/)
  assert.equal(runWithEnv([CLI, "debug", "latest", "missing-session"], undefined, env).status, 1)
})
