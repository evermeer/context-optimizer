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

test("buildPayload keeps error-prefixed docs for the Python bridge to purge", () => {
  const payload = core.buildPayload({}, {
    context: ["[error] boom", "normal doc"],
  })

  assert.deepEqual(payload.docs, ["[error] boom", "normal doc"])
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

test("optimizer tuning knobs default, round-trip, forward to Python, and coerce ints", () => {
  const defaults = core.resolveEffectiveConfig()
  assert.equal(defaults.compression_rate, core.DEFAULT_COMPRESSION_RATE)
  assert.equal(defaults.max_chunks, core.DEFAULT_MAX_CHUNKS)
  assert.equal(defaults.dedupe_threshold, core.DEFAULT_DEDUPE_THRESHOLD)
  assert.equal(defaults.total_prune_budget_chars, core.DEFAULT_PRUNE_BUDGET_CHARS)
  assert.equal(defaults.reranker_model, core.DEFAULT_RERANKER_MODEL)
  assert.equal(defaults.embed_model, core.DEFAULT_EMBED_MODEL)

  // Forwarded options carry the Python kwarg names, and NOT the TS-only threshold.
  // compressor_model is omitted while unset so Python keeps its device-based default.
  const forwarded = core.optimizerOptionsFromConfig(defaults)
  assert.deepEqual(forwarded, {
    compression_rate: core.DEFAULT_COMPRESSION_RATE,
    max_chunks: core.DEFAULT_MAX_CHUNKS,
    dedupe_threshold: core.DEFAULT_DEDUPE_THRESHOLD,
    total_prune_budget_chars: core.DEFAULT_PRUNE_BUDGET_CHARS,
    reranker_model: core.DEFAULT_RERANKER_MODEL,
    embed_model: core.DEFAULT_EMBED_MODEL,
  })
  assert.ok(!("auto_compression_chars" in forwarded))
  assert.ok(!("compressor_model" in forwarded))

  core.writeStoredConfig({
    compression_rate: 0.7,
    max_chunks: 8.6,
    total_prune_budget_chars: 5000.4,
    reranker_model: "BAAI/bge-reranker-base",
    compressor_model: "microsoft/llmlingua-2-bert-base-multilingual-cased-meetingbank",
  })
  const stored = core.resolveEffectiveConfig()
  assert.equal(stored.compression_rate, 0.7)
  assert.equal(stored.max_chunks, 9) // rounded so Python's slice never sees a float
  assert.equal(stored.total_prune_budget_chars, 5000) // rounded to a whole char count
  assert.equal(stored.reranker_model, "BAAI/bge-reranker-base")
  // An explicit compressor_model IS forwarded to Python.
  assert.equal(
    core.optimizerOptionsFromConfig(stored).compressor_model,
    "microsoft/llmlingua-2-bert-base-multilingual-cased-meetingbank",
  )
  core.removeStoredConfig()
})

test("parseConfigValue validates ints, rate bounds, strings, and JSON", () => {
  assert.equal(core.parseConfigValue("compression_rate", "0.5").value, 0.5)
  assert.equal(core.parseConfigValue("compression_rate", "1.5").ok, false)
  assert.equal(core.parseConfigValue("max_chunks", "6").value, 6)
  assert.equal(core.parseConfigValue("max_chunks", "6.5").ok, false)
  assert.equal(core.parseConfigValue("dedupe_threshold", "0").ok, false)
  assert.equal(core.parseConfigValue("total_prune_budget_chars", "4000").value, 4000)
  assert.equal(core.parseConfigValue("reranker_model", "BAAI/bge-reranker-base").value, "BAAI/bge-reranker-base")
  assert.equal(core.parseConfigValue("compressor_model", "microsoft/llmlingua-2-...").ok, true)
  assert.equal(core.parseConfigValue("embed_model", "   ").ok, false)
  assert.deepEqual(core.parseConfigValue("model_limits", '{"gpt":{}}').value, { gpt: {} })
  assert.equal(core.parseConfigValue("model_limits", "not json").ok, false)
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
