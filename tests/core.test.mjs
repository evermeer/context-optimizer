import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"

// Point the shared data dir at a temp folder so tests never touch ~/.context-optimizer.
process.env.CONTEXT_OPTIMIZER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "ctxopt-test-"))

const core = await import("../dist/index.js")
const opencode = await import("../dist/opencode.js")

test("buildPayload flattens context strings and sums size", () => {
  const payload = core.buildPayload({ prompt: "ignored" }, { context: ["a", "", "b"], prompt: "summarize" })

  assert.deepEqual(payload.docs, ["a", "b"])
  assert.equal(payload.query, "summarize")
  assert.equal(payload.size, 2)
})

test("buildPayload separates error and protected docs", () => {
  const payload = core.buildPayload({}, {
    context: ["[error] boom", "protected: keep me", "normal doc"],
  })

  assert.deepEqual(payload.docs, ["normal doc"])
  assert.deepEqual(payload.errorDocs, ["[error] boom"])
  assert.deepEqual(payload.protectedDocs, ["protected: keep me"])
})

test("formatSizeSummary reports savings percentage", () => {
  assert.equal(
    core.formatSizeSummary(200, 50),
    "Initial size: 200 chars, final size: 50 chars, saved: 150 chars (75%)",
  )
  assert.equal(core.formatSizeSummary(undefined, 50), "")
})

test("normalizePythonResult maps ok and error payloads", () => {
  const ok = core.normalizePythonResult(
    JSON.stringify({ ok: true, optimized_context: "x", initial_size: 10, final_size: 1 }),
  )
  assert.equal(ok.ok, true)
  assert.equal(ok.optimizedContext, "x")
  assert.equal(ok.status, "optimized")

  const err = core.normalizePythonResult(JSON.stringify({ ok: false, error_code: "dependency_missing", message: "no torch" }))
  assert.equal(err.ok, false)
  assert.equal(err.errorCode, "dependency_missing")
  assert.equal(err.status, "failed")
})

test("applyOptimizedContext fails open without optimized content", () => {
  const output = { context: ["original"] }
  core.applyOptimizedContext(output, { ok: false })
  assert.deepEqual(output.context, ["original"])

  core.applyOptimizedContext(output, { ok: true, optimizedContext: "tight", initialSize: 100, finalSize: 5 })
  assert.equal(output.context.length, 2)
  assert.match(output.context[1], /## Optimized Context\n\ntight/)
})

test("config round-trips through the stored config file", () => {
  core.writeStoredConfig({ min_chars: 123 })
  assert.equal(core.resolveEffectiveConfig().min_chars, 123)
  core.removeStoredConfig()
  assert.equal(core.resolveEffectiveConfig().min_chars, core.DEFAULT_MIN_COMPACTION_CHARS)
})

test("recordOptimizationStats accumulates optimized chars per session", () => {
  core.recordOptimizationStats("s1", { initialSize: 100, finalSize: 40 })
  core.recordOptimizationStats("s2", { initialSize: 10, finalSize: 5 })

  const stats = core.readStoredStats()
  assert.equal(stats.totalOptimizedChars, 65)
  assert.equal(stats.totalOptimizations, 2)
  assert.deepEqual(Object.keys(stats.sessions).sort(), ["s1", "s2"])
})

test("runOptimizer fails open when the bridge is missing", async () => {
  const result = await core.runOptimizer({
    payload: { docs: ["x"] },
    cliPath: path.join(process.env.CONTEXT_OPTIMIZER_HOME, "does-not-exist.py"),
    timeoutMs: 30000,
  })
  assert.equal(result.ok, false)
})

test("opencode plugin exports the loader shape", async () => {
  assert.equal(opencode.default.id, "context-optimizer")
  assert.equal(typeof opencode.default.server, "function")

  const hooks = await opencode.ContextOptimizerPlugin({})
  assert.equal(typeof hooks["experimental.session.compacting"], "function")
  assert.equal(typeof hooks["command.execute.before"], "function")
  assert.ok(hooks.command["context-optimizer"])
})

test("opencode compaction hook rewrites context via injected runner", async () => {
  const hooks = await opencode.ContextOptimizerPlugin({
    runOptimizer: async () => ({ ok: true, optimizedContext: "compressed", initialSize: 5000, finalSize: 10 }),
  })

  const output = { context: ["x".repeat(5000)] }
  await hooks["experimental.session.compacting"]({ sessionID: "s" }, output)

  assert.equal(output.context.length, 2)
  assert.match(output.context[1], /compressed/)
})

test("opencode compaction hook skips small contexts", async () => {
  let called = false
  const hooks = await opencode.ContextOptimizerPlugin({
    runOptimizer: async () => {
      called = true
      return { ok: true }
    },
  })

  const output = { context: ["tiny"] }
  await hooks["experimental.session.compacting"]({}, output)

  assert.equal(called, false)
  assert.deepEqual(output.context, ["tiny"])
})
