# Context Optimizer

[![npm](https://img.shields.io/npm/v/@evermeer/context-optimizer?logo=npm)](https://www.npmjs.com/package/@evermeer/context-optimizer)
[![license](https://img.shields.io/npm/l/@evermeer/context-optimizer)](https://github.com/evermeer/context-optimizer/blob/main/LICENSE)
[![node](https://img.shields.io/node/v/@evermeer/context-optimizer?logo=node.js&logoColor=white)](https://nodejs.org)
[![python](https://img.shields.io/badge/python-3.9%2B-blue?logo=python&logoColor=white)](https://www.python.org)
[![status](https://img.shields.io/badge/status-experimental-orange)](#)
[![platforms](https://img.shields.io/badge/for-OpenCode%20%26%20Claude%20Code-8A2BE2)](#)

**Keep your coding agent's context small.** When a session gets compacted, Context Optimizer reranks the relevant parts, drops duplicates, and compresses the rest with a local ML pipeline ([LLMLingua-2](https://github.com/microsoft/LLMLingua) + [Sentence Transformers](https://github.com/huggingface/sentence-transformers)) — so more of the window stays useful and fewer tokens get billed. Everything runs on your machine; nothing is sent to a third party.

> [!WARNING]
> This plugin is still experimental. (It works on my machine)
> I'm investigating what options there are for context deduplication (removes repeated info), reranking (removes irrelevant context) and compression. 

## Highlights

- **Local & private** — all ML runs on your machine; your context never leaves it.
- **Fails open** — if Python or a model is missing, context is passed through untouched. It can't break a session.
- **Two platforms, one config** — works with both OpenCode and Claude Code, sharing a single config and stats store.
- **Tunable or zero-config** — every model and threshold is configurable per-model or globally, but the defaults just work.
- **GPU or CPU** — uses CUDA when available, and falls back to lighter CPU models automatically.

Both platforms compress the session on compaction; OpenCode additionally optimizes each chat turn live (Claude Code has no hook for that — see [How it works per platform](#how-it-works-per-platform)).

On the context that actually gets compacted, expect roughly **40–60% fewer tokens** (LLMLingua-2 at the default `0.5` rate, after rerank + dedup pruning). Whole-session savings depend on how much of the session is compactable — and the exact `% saved` is measured and reported live on every compaction, so you never have to trust a headline number.

## Requirements

| Requirement | Minimum | How to check |
| --- | --- | --- |
| Node.js | 18+ | `node --version` |
| Python | 3.9+ | `python --version` |
| Disk space | ~3–5 GB free (models) | — |

> [!NOTE]
> A CUDA GPU is strongly recommended. The optimizer runs CPU-only too, but compression is noticeably slower.
> On **Windows, CPU-only** machines, install the CPU PyTorch wheel *before* running the installer so it doesn't pull a large CUDA build:
> `python -m pip install --index-url https://download.pytorch.org/whl/cpu torch`

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
4. downloads the models once (~3–5 GB, one-time — see [Models](#models)),
5. installs the OpenCode plugin and/or registers the Claude Code hooks.

Detection: OpenCode is recognized by `~/.config/opencode/` or an `opencode` binary on PATH; Claude Code by `~/.claude/` or a `claude` binary on PATH. Without `--opencode`/`--claude` flags, every detected environment is installed.

Useful flags:

- `--skip-deps` — skip the pip install (already installed)
- `--skip-models` — skip the model warm-up download

Check what would be detected: `npx @evermeer/context-optimizer detect`

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
| `compression_rate` | `CONTEXT_OPTIMIZER_COMPRESSION_RATE` | `0.5` | Fraction of tokens LLMLingua keeps (0–1); higher keeps more detail |
| `max_chunks` | `CONTEXT_OPTIMIZER_MAX_CHUNKS` | `6` | Max ranked chunks kept before compression (positive integer) |
| `dedupe_threshold` | `CONTEXT_OPTIMIZER_DEDUPE_THRESHOLD` | `0.9` | Cosine similarity (0–1) above which a chunk is treated as a duplicate |
| `total_prune_budget_chars` | `CONTEXT_OPTIMIZER_PRUNE_BUDGET_CHARS` | `4000` | Char budget of ranked+deduped context kept before compression (positive integer) |
| `auto_compression_chars` | `CONTEXT_OPTIMIZER_AUTO_COMPRESSION_CHARS` | `4000` | Context size (chars) at which per-model `model_limits` overrides kick in |
| `reranker_model` | `CONTEXT_OPTIMIZER_RERANKER_MODEL` | `BAAI/bge-reranker-large` | HuggingFace cross-encoder used to rank chunks by relevance |
| `embed_model` | `CONTEXT_OPTIMIZER_EMBED_MODEL` | `all-MiniLM-L6-v2` | HuggingFace embedding model used for deduplication |
| `compressor_model` | `CONTEXT_OPTIMIZER_COMPRESSOR_MODEL` | _(auto by device)_ | LLMLingua-2 model used for compression; unset lets the bridge pick by device (see below) |
| `model_limits` | `CONTEXT_OPTIMIZER_MODEL_LIMITS` | `{}` | Per-model overrides, e.g. `{"gpt-4.1": {"compression_rate": 0.65, "max_chunks": 8}}` |
| — | `CONTEXT_OPTIMIZER_PYTHON` | `py -3` (Windows) / `python3` | Python interpreter used for the bridge |
| — | `CONTEXT_OPTIMIZER_CLI` | `~/.context-optimizer/python/context_optimizer_cli.py` | Path to the Python bridge script |

`compression_rate`, `max_chunks`, `dedupe_threshold`, `total_prune_budget_chars`, `reranker_model`, `embed_model`, and `compressor_model` are global defaults; a matching key in `model_limits` overrides them per-model, and an explicit per-request option overrides both. If responses lose important detail, raise `compression_rate` or `max_chunks`; if prompts are still too large, lower them. (`auto_compression_chars` is a JS-side gate for `model_limits`, so it is not a per-model or per-request key.)

## Models

The pipeline uses three models, each swappable via the matching config key. On first run the libraries download them from Hugging Face and cache them under `~/.cache/huggingface/`; the installer warms this cache once so the first real compaction loads from disk. Set an alternative with `context-optimizer config set <key> <model>` (or the env var).

Any Hugging Face model that fits the role works — the lists below are tested, drop-in options. Larger models improve quality but cost memory and latency; smaller ones keep the optimizer responsive on CPU.

### `reranker_model` — ranks chunks by relevance (CrossEncoder)

| Model | Notes |
| --- | --- |
| `BAAI/bge-reranker-large` | **Default.** Best ranking quality; largest and slowest, heavy on CPU. |
| `BAAI/bge-reranker-base` | Noticeably smaller/faster with a small quality drop — the go-to if the large model is slow or OOMs. |
| `BAAI/bge-reranker-v2-m3` | Strong multilingual reranking; larger, best on a GPU. |
| `cross-encoder/ms-marco-MiniLM-L-6-v2` | Tiny and very fast, English-only; lowest quality — for constrained CPUs. |

### `embed_model` — embeddings for deduplication (SentenceTransformer)

| Model | Notes |
| --- | --- |
| `all-MiniLM-L6-v2` | **Default.** Fast, small, solid general-purpose English embeddings. |
| `all-mpnet-base-v2` | Higher-quality English embeddings; ~3–4× larger and slower. |
| `BAAI/bge-small-en-v1.5` | Small, strong English embedder; good quality-for-size alternative to the default. |
| `paraphrase-multilingual-MiniLM-L12-v2` | Multilingual dedup for non-English or mixed-language context. |

### `compressor_model` — prompt compression (must be an LLMLingua-2 model)

Leave `compressor_model` unset to let the bridge auto-select by device. Only LLMLingua-2 checkpoints work here (the bridge runs with `use_llmlingua2=True`).

| Model | Notes |
| --- | --- |
| `microsoft/llmlingua-2-xlm-roberta-large-meetingbank` | Auto-selected on **CUDA**. Larger, multilingual, higher-quality compression. |
| `microsoft/llmlingua-2-bert-base-multilingual-cased-meetingbank` | Auto-selected on **CPU**. Smaller and faster; also a good explicit choice to force the lighter model on a GPU box. |

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
| Out-of-memory / very slow CPU | Reranker model is large | Run `context-optimizer config set reranker_model BAAI/bge-reranker-base` (or set `CONTEXT_OPTIMIZER_RERANKER_MODEL`) |
| `/context-optimizer stats` shows zeros | No successful optimization yet | Stats accumulate in `~/.context-optimizer/stats.json` after the first successful run |
