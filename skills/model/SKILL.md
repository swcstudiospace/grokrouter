---
name: model
description: Show or switch the model for this GrokRouter Bot.
argument-hint: "[model-id]"
user-invocable: true
disable-model-invocation: true
metadata:
  author: GrokRouter
  short-description: Show or switch the model for this GrokRouter Bot.
---

# GrokRouter model control

GROKROUTER_NATIVE_CONTROL: MODEL

On Grok Bot 0.30.0–0.44.0 GrokRouter intercepts this command before model inference and returns the authoritative receipt; the steps below are then never reached.

On Grok Bot 0.63.0 and later (delegation mode) run this exactly, in this Bot's computer, with the user's argument text preserved:

```
/home/box/.local/bin/grokbot-router control "/model <argument or nothing>"
```

Reply with the command's standard output verbatim: same lines, same order, nothing added, nothing summarised. If the command exits non-zero, reply with its standard error verbatim instead.
