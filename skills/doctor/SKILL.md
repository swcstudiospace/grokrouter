---
name: doctor
description: Check GrokRouter runtime, provider and credential health.
user-invocable: true
disable-model-invocation: true
metadata:
  author: GrokRouter
  short-description: Check GrokRouter runtime, provider and credential health.
---

# GrokRouter doctor control

GROKROUTER_NATIVE_CONTROL: DOCTOR

On Grok Bot 0.30.0–0.44.0 GrokRouter intercepts this command before model inference and returns the authoritative receipt; the steps below are then never reached.

On Grok Bot 0.63.0 and later (delegation mode) run this exactly, in this Bot's computer, with the user's argument text preserved:

```
/home/box/.local/bin/grokbot-router control "/doctor"
```

Reply with the command's standard output verbatim: same lines, same order, nothing added, nothing summarised. If the command exits non-zero, reply with its standard error verbatim instead. For the full runtime report (Node, delegation runner, credentials, recent failures) run `/home/box/.local/bin/grokbot-router doctor` instead.
