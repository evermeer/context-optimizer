---
description: Show or update context-optimizer settings (timeout_ms, min_chars, compression_rate, max_chunks, dedupe_threshold, total_prune_budget_chars, auto_compression_chars, reranker_model, embed_model, compressor_model, model_limits)
argument-hint: [get <key>|set <key> <value>|reset]
---

Run `npx @evermeer/context-optimizer@latest config $ARGUMENTS` with the Bash tool (drop the trailing arguments entirely if none were given — that shows current settings) and show its output to the user as-is.

Safe keys: timeout_ms, min_chars, compression_rate, max_chunks, dedupe_threshold, total_prune_budget_chars, auto_compression_chars, reranker_model, embed_model, compressor_model, model_limits.
