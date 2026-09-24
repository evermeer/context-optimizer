---
description: Compare the plugin and native results of a debug compaction and save an evaluation
argument-hint: [optional session-id]
---

Evaluate which of two compacted contexts works better as the context a coding agent continues a session from. Judge only the two files below; ignore everything else in this conversation (run this in a new session so nothing else is in it).

1. Run `npx @evermeer/context-optimizer@latest debug latest $ARGUMENTS` with the Bash tool (drop the trailing arguments if none were given). It prints JSON for the newest debug compaction (of that session, if an ID was given) with `plugin` (context-optimizer result, or `null` if the plugin produced none), `native` (Claude's own compact summary), `evaluation` (where to write the result), `pluginChars`, `nativeChars`, `originalChars`, `trigger`, `stamp` and `sessionID`. If it fails, or `plugin` is `null`, show the output (including `pluginStatus`/`pluginReason`) and stop.
2. Read both files in full with the Read tool.
3. Compare them as the starting context of the continued session. For each criterion, say which one is better and quote short concrete examples from the files:
   - **Task continuity** — are the goal, current state, and next step clear?
   - **Key facts** — file paths, identifiers, commands, decisions, errors and their fixes, user preferences and constraints. List important facts that only one of the two kept.
   - **Fidelity** — anything wrong, garbled, ambiguous, or unsupported. The plugin text is token-compressed (LLMLingua-2), so check it is still readable and unambiguous; the native text is an LLM paraphrase, so check for invented or over-generalized detail.
   - **Noise** — irrelevant, stale, or duplicated content.
   - **Size** — chars of each, and what the extra size buys.
4. Write the evaluation as markdown to the `evaluation` path with the Write tool, in this shape:

   ```
   # Compaction evaluation — <stamp>

   Session: <sessionID> · trigger: <trigger>
   Files: [plugin](plugin.txt) (<pluginChars> chars) · [native](native.txt) (<nativeChars> chars) · original context: <originalChars> chars
   Plugin size vs native: <pluginChars / nativeChars as %>

   ## Verdict
   <plugin | native | tie> — <one or two sentences why>

   ## Criteria
   | criterion | better | why |
   | --- | --- | --- |
   ...

   ## Only in plugin
   ## Only in native
   ## Problems found
   ## Recommendation
   <e.g. keep the plugin for this kind of session, or which setting to tune: compression_rate, max_chunks, total_prune_budget_chars>
   ```

5. Show the user the verdict, the criteria table, and the path of the evaluation file.
