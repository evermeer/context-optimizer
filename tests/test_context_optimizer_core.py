import importlib.util
import contextlib
import io
import sys
import types
import unittest
from pathlib import Path
from typing import Any, cast


REPO_ROOT = Path(__file__).resolve().parents[1]
CORE = REPO_ROOT / "python" / "context_optimizer.py"


class _Score:
    def __init__(self, value):
        self._value = value

    def item(self):
        return self._value


def load_core_module():
    fake_sentence_transformers = cast(Any, types.ModuleType("sentence_transformers"))

    class FakeCrossEncoder:
        def __init__(self, model_name, **kwargs):
            self.model_name = model_name
            self.kwargs = kwargs

        def predict(self, pairs):
            score_map = {
                "beta": 3,
                "alpha": 2,
                "gamma": 1,
            }
            return [score_map.get(doc, 0) for _, doc in pairs]

    class FakeSentenceTransformer:
        def __init__(self, model_name, **kwargs):
            self.model_name = model_name
            self.kwargs = kwargs

        def encode(self, docs, convert_to_tensor=True):
            return list(docs)

    def fake_cos_sim(left, right):
        return _Score(1.0 if left == right else 0.0)

    setattr(fake_sentence_transformers, "CrossEncoder", FakeCrossEncoder)
    setattr(fake_sentence_transformers, "SentenceTransformer", FakeSentenceTransformer)
    setattr(fake_sentence_transformers, "util", types.SimpleNamespace(cos_sim=fake_cos_sim))

    fake_llmlingua = cast(Any, types.ModuleType("llmlingua"))

    class FakePromptCompressor:
        def __init__(self, model_name, **kwargs):
            self.model_name = model_name
            self.kwargs = kwargs

        def compress_prompt(self, combined, rate):
            return {"compressed_prompt": f"{'\n\n'.join(combined)} [rate={rate}]"}

    setattr(fake_llmlingua, "PromptCompressor", FakePromptCompressor)

    original_sentence_transformers = sys.modules.get("sentence_transformers")
    original_llmlingua = sys.modules.get("llmlingua")
    sys.modules["sentence_transformers"] = fake_sentence_transformers
    sys.modules["llmlingua"] = fake_llmlingua

    spec = importlib.util.spec_from_file_location("context_optimizer_under_test", CORE)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)

    if original_sentence_transformers is not None:
        sys.modules["sentence_transformers"] = original_sentence_transformers
    else:
        del sys.modules["sentence_transformers"]

    if original_llmlingua is not None:
        sys.modules["llmlingua"] = original_llmlingua
    else:
        del sys.modules["llmlingua"]

    return module


class ContextOptimizerCoreTests(unittest.TestCase):
    def test_context_optimizer_initialization_logs_device_and_models(self):
        module = load_core_module()
        stderr = io.StringIO()

        with contextlib.redirect_stderr(stderr):
            optimizer = module.ContextOptimizer()

        self.assertIsNotNone(optimizer)
        output = stderr.getvalue()
        self.assertIn("initializing optimizer", output)
        self.assertRegex(output, r"device=(cuda|cpu)")
        self.assertIn("reranker=", output)
        self.assertIn("compressor=", output)

    def test_optimize_reranks_and_compresses_context(self):
        module = load_core_module()
        optimizer = module.ContextOptimizer(compression_rate=0.25, max_chunks=2)

        result = optimizer.optimize(
            query="best chunk",
            docs=cast(list[str], ["alpha", "gamma", "beta"]),
        )

        self.assertEqual(result, "beta\n\nalpha [rate=0.25]")

    def test_optimize_deduplicates_exact_duplicate_chunks(self):
        module = load_core_module()
        optimizer = module.ContextOptimizer(compression_rate=0.5, max_chunks=6)

        result = optimizer.optimize(
            query="best chunk",
            docs=cast(list[str], ["beta", "beta", "alpha"]),
        )

        self.assertEqual(result, "beta\n\nalpha [rate=0.5]")

    def test_optimize_returns_empty_string_for_no_context(self):
        module = load_core_module()
        optimizer = module.ContextOptimizer()

        self.assertEqual(optimizer.optimize(query="anything"), "")

    def test_optimize_drops_error_chunks_before_pruning(self):
        module = load_core_module()
        optimizer = module.ContextOptimizer(compression_rate=0.5, max_chunks=6)

        result = optimizer.optimize(
            query="best chunk",
            docs=cast(list[str], ["[error] broken tool output", "alpha"]),
        )

        self.assertNotIn("[error] broken tool output", result)
        self.assertIn("alpha", result)

    def test_optimize_keeps_non_error_docs_over_error_purge(self):
        module = load_core_module()
        optimizer = module.ContextOptimizer(compression_rate=0.5, max_chunks=6)

        result = optimizer.optimize(
            query="best chunk",
            docs=cast(list[str], ["protected: keep this", "[error] broken tool output"]),
        )

        self.assertIn("protected: keep this", result)
        self.assertNotIn("[error] broken tool output", result)

    def test_optimize_normalizes_tuple_docs_with_three_values(self):
        module = load_core_module()
        optimizer = module.ContextOptimizer(compression_rate=0.5, max_chunks=6)

        result = optimizer.optimize(
            query="best chunk",
            docs=cast(list[Any], [("graph", "alpha", "source-a"), ("memory", "beta", "source-b")]),
        )

        self.assertEqual(result, "graph alpha source-a\n\nmemory beta source-b [rate=0.5]")

    def test_optimize_pre_prunes_low_value_docs_before_compress(self):
        module = load_core_module()
        optimizer = module.ContextOptimizer(
            compression_rate=0.5,
            max_chunks=6,
            total_prune_budget_chars=10,
        )

        result = optimizer.optimize(
            query="best chunk",
            docs=cast(list[str], ["alpha", "gamma", "beta", "low-value docs"]),
        )

        self.assertIn("beta", result)
        self.assertNotIn("low-value docs", result)

    def test_optimize_keeps_high_value_chunk_even_when_it_exceeds_budget(self):
        module = load_core_module()
        optimizer = module.ContextOptimizer(
            compression_rate=0.5,
            max_chunks=6,
            total_prune_budget_chars=3,
        )

        result = optimizer.optimize(
            query="best chunk",
            docs=cast(list[str], ["alpha"]),
        )

        self.assertIn("alpha", result)


if __name__ == "__main__":
    unittest.main()
