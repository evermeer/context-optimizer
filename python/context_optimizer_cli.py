import json
import importlib
import sys
from typing import Any, Dict, NoReturn


def emit(payload: Dict[str, Any], exit_code: int = 0) -> NoReturn:
    sys.stdout.write(json.dumps(payload))
    sys.stdout.flush()
    raise SystemExit(exit_code)


def emit_error(error_code: str, message: str, exit_code: int = 1) -> NoReturn:
    emit(
        {
            "ok": False,
            "error_code": error_code,
            "message": message,
        },
        exit_code=exit_code,
    )


ContextOptimizer: Any = None
try:
    if __package__:
        ContextOptimizer = importlib.import_module(".context_optimizer", __package__).ContextOptimizer
    else:
        ContextOptimizer = importlib.import_module("context_optimizer").ContextOptimizer
except ModuleNotFoundError as exc:
    emit_error("dependency_missing", str(exc))


def main() -> None:
    # The adapters pipe UTF-8 JSON on stdin. Decode the raw bytes as UTF-8
    # explicitly: on Windows sys.stdin defaults to the locale codec (cp1252),
    # which turns UTF-8 continuation bytes into lone surrogates that pass the
    # isinstance(str) check but make the HF tokenizer raise "TextInputSequence
    # must be str". errors="replace" keeps a stray malformed byte from crashing.
    raw = sys.stdin.buffer.read().decode("utf-8", errors="replace")
    payload: Dict[str, Any] = {}
    try:
        payload = json.loads(raw or "{}")
    except json.JSONDecodeError as exc:
        emit_error("invalid_input", str(exc))

    docs = payload.get("docs") or []
    query = payload.get("query", "")
    options = payload.get("options") or {}

    if not isinstance(docs, list):
        emit_error("invalid_input", "docs must be a list of strings")

    if not docs:
        emit({"ok": True, "status": "no_optimization", "reason": "no compaction documents were provided.", "optimized_context": "", "initial_size": 0, "final_size": 0})
        return

    if any(not isinstance(doc, str) for doc in docs):
        emit_error("invalid_input", "docs must contain strings only")

    safe_docs = docs

    initial_size = sum(len(doc) for doc in safe_docs)
    min_input_size = options.get("min_input_size")
    if isinstance(min_input_size, int) and min_input_size > 0 and initial_size < min_input_size:
        emit(
            {
                "ok": True,
                "status": "no_optimization",
                "reason": f"context size {initial_size} chars is below the threshold of {min_input_size} chars.",
                "optimized_context": "",
                "initial_size": initial_size,
                "final_size": initial_size,
            }
        )
        return

    optimized = ""
    try:
        optimizer_options = dict(options)
        min_input_size = optimizer_options.pop("min_input_size", None)
        optimizer = ContextOptimizer(**optimizer_options) if ContextOptimizer is not None else None
        if optimizer is None:
            emit_error("dependency_missing", "ContextOptimizer import unavailable")

        optimized = optimizer.optimize(query=query, docs=safe_docs)
    except Exception as exc:
        emit_error("runtime_error", str(exc))

    emit(
        {
            "ok": True,
            "optimized_context": optimized,
            "initial_size": initial_size,
            "final_size": len(optimized),
        }
    )


if __name__ == "__main__":
    main()
