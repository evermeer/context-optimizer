---
description: Show context-optimizer commands
---

Reply with exactly this, verbatim, and do not run any tools:

[context-optimizer] available commands

/context-optimizer — show this help
/context-optimizer:context — show the current session's context/token breakdown
/context-optimizer:stats — show cumulative pruning/compaction statistics
/context-optimizer:compact — run one compaction pass on the current conversation
/context-optimizer:config — show or update safe settings (timeout_ms, min_chars, model_limits)
/context-optimizer:debugon — turn debug mode on: run the plugin and Claude's native compaction side by side and save both
/context-optimizer:debugoff — turn debug mode off (default)
/context-optimizer:evaluate — compare the latest debug compaction's plugin and native results (run in a new session)
