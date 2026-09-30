---
name: route
description: Delegate a task to this Bot's GrokRouter provider (Codex, OpenRouter, Anthropic, or xAI) and return its report.
argument-hint: "<task>"
user-invocable: true
disable-model-invocation: false
metadata:
  author: GrokRouter
  short-description: Delegate a task to this Bot's chosen model
---

# GrokRouter route

GROKROUTER_NATIVE_CONTROL: ROUTE

Use this when the user invokes `/route`, asks for the task to be done by "the router", "the delegated model", or by the provider or model they set with `/provider`, `/model`, or `/reasoning`, or when a coding or research task in this Bot's computer should be done by that model rather than by you.

Steps, in this Bot's computer:

1. Write the task verbatim to `/tmp/grokrouter-task.md`, overwriting it. The task is everything the user wrote after `/route`; when there is no `/route` prefix, it is the user's whole request plus any file paths or constraints they gave. Do not paraphrase.
2. Run exactly:

```
/home/box/.local/bin/grokbot-router run --task-file /tmp/grokrouter-task.md
```

   It can take several minutes. Wait for it to finish; do not interrupt it, retry it, or start doing the task yourself while it runs. Do not send any message before it finishes, not even an acknowledgement.
3. Reply exactly once, with the command's standard output verbatim: same lines, same order, nothing added before or after, nothing summarised. If the command exits non-zero, reply with its standard error verbatim instead. Keep the final bracketed `[GrokRouter …]` line: it names the provider, model, reasoning and step count that produced the report.

Never claim the task was done if the command did not print a report. If it fails with `GrokRouter is disabled`, say so and stop.
