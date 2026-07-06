# Context Optimizer

> [!WARNING]
> This plugin is still experimental. (It works on my machine)

Context compression for **OpenCode** and **Claude Code**: reranking (removes irrelevant context), deduplication (removes repeated info), and compression ([LLMLingua-2](https://github.com/microsoft/LLMLingua)). Expect roughly 30–40% token reduction on long sessions.

## Architecture

```
context-optimizer/
├── packages/
│   ├── core/          # business logic: payload building, config, stats,
│   │                  # Python bridge, environment detection, installer
│   ├── claude-code/   # Claude Code adapter (PreCompact + SessionStart hooks)
│   └── opencode/      # OpenCode adapter (compaction hook + slash commands)
├── python/            # ML core: rerank + dedupe + compress (SentenceTransformers, LLMLingua)
├── package.json
└── tsconfig.json
```

Everything is TypeScript compiled with [tsup](https://tsup.egoist.dev/) to `dist/` (ES2022, ESM), except the ML core itself: reranking, dedup embeddings, and LLMLingua compression run in Python (PyTorch) and are called over a stdin/stdout JSON bridge. The adapters fail open — if Python or its dependencies are missing, your context is left untouched.

## Requirements

| Requirement | Minimum | How to check |
| --- | --- | --- |
| Node.js | 18+ | `node --version` |
| Python | 3.9+ | `python --version` |
| Disk space | ~3–5 GB free (models) | — |

## Installation

```bash
# auto-detect: installs into every environment it finds
npx @evermeer/context-optimizer install

# or force a specific target
npx @evermeer/context-optimizer install --opencode
npx @evermeer/context-optimizer install --claude
```

The installer:

1. checks Node.js (18+) and Python (3.9+),
2. installs the Python packages `sentence-transformers` and `llmlingua` (PyTorch comes with them),
3. copies the Python bridge to `~/.context-optimizer/python/`,
4. downloads the models once (several GB, one-time — see [Models](#models)),
5. installs the OpenCode plugin and/or registers the Claude Code hooks.

Detection: OpenCode is recognized by `~/.config/opencode/` or an `opencode` binary on PATH; Claude Code by `~/.claude/` or a `claude` binary on PATH. Without `--opencode`/`--claude` flags, every detected environment is installed.

Useful flags:

- `--skip-deps` — skip the pip install (already installed)
- `--skip-models` — skip the model warm-up download

Check what would be detected: `npx @evermeer/context-optimizer detect`

> [!NOTE]
> On Windows CPU-only machines, install the CPU PyTorch wheel first so the optimizer doesn't pull a CUDA build:
> `python -m pip install --index-url https://download.pytorch.org/whl/cpu torch` — then run the installer with `--skip-deps` replaced by a normal run.

## How it works per platform

### OpenCode

The installer copies a self-contained plugin to `~/.config/opencode/plugins/context-optimizer.js`. OpenCode loads it automatically. During `experimental.session.compacting` the plugin collects the compaction documents, calls the Python bridge, and replaces the context with an `## Optimized Context` block plus a size summary (initial size, final size, % saved).
In addition, `experimental.chat.messages.transform` runs live optimization on every chat turn (no Python round-trip, pure TS):

- **deduplication** — tool calls with an identical tool name + parameters keep only the newest output; older duplicates are replaced with a short marker.
- **purge errors** — string inputs of errored tool calls older than 4 user turns are replaced with a marker (the error output is kept). Mutating/planning tools (`write`, `edit`, `task`, `todowrite`, …) are protected and never optimized away.

Slash commands:

| Command | What it does |
| --- | --- |
| `/context-optimizer` | Show help |
| `/context-optimizer context` | Show the current session context breakdown |
| `/context-optimizer stats` | Show cumulative pruning/compaction stats |
| `/context-optimizer compress` | Run one compression pass immediately |
| `/context-optimizer config [get\|set\|reset]` | Show or update safe settings (`timeout_ms`, `min_chars`, `model_limits`) |

### Claude Code

Claude Code hooks cannot rewrite the compaction context directly, so the adapter uses a two-phase hand-off, registered in `~/.claude/settings.json`:

1. **PreCompact hook** — before compaction runs, the transcript context is optimized via the Python bridge and the result is stored per session under `~/.context-optimizer/claude-sessions/`.
2. **SessionStart hook** (matcher `compact`) — right after compaction, the stored optimized context is injected back into the fresh session as additional context and the hand-off file is removed.

Both hooks fail open: on any error Claude Code proceeds untouched.

Claude Code has no hook that can rewrite the live conversation, so the per-turn optimization strategies from the OpenCode plugin run here at the PreCompact rewrite point instead, while parsing the transcript:

- **deduplication** — identical tool calls (same tool + parameters) keep only the newest result.
- **purge errors** — errored tool results older than 4 user turns are dropped.

Surviving tool outputs (capped per result) are fed to the optimizer alongside the prose, instead of being discarded wholesale.

Slash commands (installed as markdown commands in `~/.claude/commands/context-optimizer*`):

| Command | What it does |
| --- | --- |
| `/context-optimizer` | Show help |
| `/context-optimizer:context` | Show the current session's context/token breakdown (estimated from the visible conversation) |
| `/context-optimizer:stats` | Show cumulative pruning/compaction stats (`context-optimizer stats`) |
| `/context-optimizer:compress` | Run one compression pass on the current conversation (`context-optimizer optimize`) |
| `/context-optimizer:config [get\|set\|reset]` | Show or update safe settings (`context-optimizer config`) |

These shell out to the same `context-optimizer` CLI (`npx @evermeer/context-optimizer <cmd>`) that backs the OpenCode commands, so config and stats are shared across both platforms.

## Configuration

All state lives in `~/.context-optimizer/` (override with the `CONTEXT_OPTIMIZER_HOME` env var): `config.json`, `stats.json`, `context-optimizer.log`, and the Python bridge.

Environment variables win over `config.json`, which wins over defaults:

| Setting | Env var | Default | What it does |
| --- | --- | --- | --- |
| `timeout_ms` | `CONTEXT_OPTIMIZER_TIMEOUT_MS` | `120000` | How long to wait for the Python bridge before failing open |
| `min_chars` | `CONTEXT_OPTIMIZER_MIN_CHARS` | `2000` | Minimum context size before optimization runs |
| `model_limits` | `CONTEXT_OPTIMIZER_MODEL_LIMITS` | `{}` | Per-model overrides, e.g. `{"gpt-4.1": {"compression_rate": 0.65, "max_chunks": 8}}` |
| — | `CONTEXT_OPTIMIZER_PYTHON` | `py -3` (Windows) / `python3` | Python interpreter used for the bridge |
| — | `CONTEXT_OPTIMIZER_CLI` | `~/.context-optimizer/python/context_optimizer_cli.py` | Path to the Python bridge script |

Optimizer defaults (`compression_rate` 0.5, `max_chunks` 6, `dedupe_threshold` 0.9, prune budgets, …) live in [python/context_optimizer.py](python/context_optimizer.py) — see `ContextOptimizer.__init__`. If responses lose important detail, raise `compression_rate` or `max_chunks`; if prompts are still too large, lower them.

## Models

On first run the underlying libraries download three models from Hugging Face and cache them under `~/.cache/huggingface/`:

| Model | Purpose |
| --- | --- |
| `BAAI/bge-reranker-large` | Reranks chunks by relevance |
| `all-MiniLM-L6-v2` | Embeddings for deduplication |
| `microsoft/llmlingua-2-xlm-roberta-large-meetingbank` (CUDA) or `microsoft/llmlingua-2-bert-base-multilingual-cased-meetingbank` (CPU) | Prompt compression |

The installer warms this cache once so the first real compaction loads from disk.

## Development

```bash
npm install
npm run build     # tsup → dist/ (index.js, cli.js, opencode.js, claude-hook.js)
npm test          # build + node --test
py -3 -m unittest discover -s tests -p "test_*.py"   # Python core tests
```

## Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| `ModuleNotFoundError: sentence_transformers` / `llmlingua` | Packages installed into a different Python | Re-run `python -m pip install sentence-transformers llmlingua` with the interpreter from `CONTEXT_OPTIMIZER_PYTHON` |
| First run hangs | Models downloading from Hugging Face | One-time; re-run the installer or raise `CONTEXT_OPTIMIZER_TIMEOUT_MS` |
| Nothing happens on compaction | Context below `min_chars`, or adapter not loaded | Check `~/.context-optimizer/context-optimizer.log` for the skip reason |
| Warning instead of optimized context | Bridge failed (fail-open) | Read the warning in the log, fix the Python issue, retry |
| Out-of-memory / very slow CPU | Reranker model is large | Switch `reranker_model` to `BAAI/bge-reranker-base` in `python/context_optimizer.py` |
| `/context-optimizer stats` shows zeros | No successful optimization yet | Stats accumulate in `~/.context-optimizer/stats.json` after the first successful run |
