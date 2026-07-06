import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"

process.env.CONTEXT_OPTIMIZER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "ctxopt-strat-test-"))

const { applyOptimizationStrategies, OPTIMIZED_OUTPUT_MARKER, OPTIMIZED_ERROR_INPUT_MARKER } = await import(
  "../dist/opencode.js"
)

function toolPart(tool, input, { status = "completed", output = "some output" } = {}) {
  return { type: "tool", callID: `call-${Math.random()}`, tool, state: { status, input, output } }
}

function userMsg() {
  return { info: { role: "user" }, parts: [{ type: "text", text: "hi" }] }
}

function assistantMsg(...parts) {
  return { info: { role: "assistant" }, parts }
}

test("deduplication optimizes away older identical tool calls, keeps newest", () => {
  const oldRead = toolPart("read", { filePath: "a.ts" })
  const newRead = toolPart("read", { filePath: "a.ts" })
  const otherRead = toolPart("read", { filePath: "b.ts" })
  const messages = [userMsg(), assistantMsg(oldRead, otherRead), userMsg(), assistantMsg(newRead)]

  const result = applyOptimizationStrategies(messages)

  assert.equal(result.deduped, 1)
  assert.equal(oldRead.state.output, OPTIMIZED_OUTPUT_MARKER)
  assert.equal(newRead.state.output, "some output")
  assert.equal(otherRead.state.output, "some output")
})

test("deduplication treats key order as identical and skips protected tools", () => {
  const first = toolPart("grep", { pattern: "x", path: "src" })
  const second = toolPart("grep", { path: "src", pattern: "x" })
  const write1 = toolPart("write", { filePath: "a.ts", content: "1" })
  const write2 = toolPart("write", { filePath: "a.ts", content: "1" })
  const messages = [userMsg(), assistantMsg(first, second, write1, write2)]

  const result = applyOptimizationStrategies(messages)

  assert.equal(result.deduped, 1)
  assert.equal(first.state.output, OPTIMIZED_OUTPUT_MARKER)
  assert.equal(write1.state.output, "some output")
  assert.equal(write2.state.output, "some output")
})

test("purgeErrors clears string inputs of old errored calls, keeps recent ones", () => {
  const oldError = toolPart("bash", { command: "explode", description: "boom" }, { status: "error", output: "err" })
  const freshError = toolPart("bash", { command: "explode2" }, { status: "error", output: "err" })
  const messages = [
    userMsg(),
    assistantMsg(oldError),
    userMsg(),
    userMsg(),
    userMsg(),
    userMsg(),
    assistantMsg(freshError),
  ]

  const result = applyOptimizationStrategies(messages)

  assert.equal(result.purgedErrors, 1)
  assert.equal(oldError.state.input.command, OPTIMIZED_ERROR_INPUT_MARKER)
  assert.equal(oldError.state.input.description, OPTIMIZED_ERROR_INPUT_MARKER)
  assert.equal(oldError.state.output, "err")
  assert.equal(freshError.state.input.command, "explode2")
})

test("is idempotent and safe on empty or malformed input", () => {
  assert.deepEqual(applyOptimizationStrategies(undefined), { deduped: 0, purgedErrors: 0 })
  assert.deepEqual(applyOptimizationStrategies([]), { deduped: 0, purgedErrors: 0 })
  assert.deepEqual(applyOptimizationStrategies([{ info: null, parts: null }]), { deduped: 0, purgedErrors: 0 })

  const a = toolPart("read", { filePath: "a.ts" })
  const b = toolPart("read", { filePath: "a.ts" })
  const messages = [userMsg(), assistantMsg(a, b)]
  assert.equal(applyOptimizationStrategies(messages).deduped, 1)
  assert.equal(applyOptimizationStrategies(messages).deduped, 0)
})
