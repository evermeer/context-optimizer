---
description: Show a size/token breakdown of the current session's context
---

Without running any tools, estimate this conversation's context from what you can already see: approximate total character count, number of substantive turns, and whether any `[error] ...` or `protected: ...` prefixed entries are present. Report it in this shape:

{
  "docs": <substantive message count>,
  "errorDocs": <count of entries starting with "[error]">,
  "protectedDocs": <count of entries starting with "protected:">,
  "size": <approx total characters>,
  "query": "Optimize the most relevant context for compaction."
}
