---
description: Run one context-optimizer compaction pass on the current conversation
argument-hint: [optional focus/query]
---

Run one compaction pass on this conversation:

1. Collect the substantive text of this session as a list of strings, skipping anything already prefixed `[error]` or `protected:`.
2. Build a JSON payload: `{"query": "$ARGUMENTS", "docs": [...], "size": <sum of doc lengths>}` — use `"Optimize the most relevant context for compaction."` as the query if no argument was given.
3. Pipe it to `npx @evermeer/context-optimizer@latest optimize` over stdin with the Bash tool (use a heredoc if the JSON contains single quotes).
4. Report the result: success/failure, and the initial size, final size, and percent saved if present.
