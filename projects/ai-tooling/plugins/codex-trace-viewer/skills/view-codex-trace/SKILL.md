---
name: view-codex-trace
description: Open the Codex trace timeline when the user wants to see a turn's runtime activity, tool calls, plugin calls, or skill usage.
---

Call the plugin's open_trace tool to open the viewer. If the user specifies a session UUID, pass it as threadId. Otherwise omit it so the local server can use the active thread ID when available.

If the host cannot render the viewer, offer the local browser command in the plugin README. Explain evidence labels when asked. A referenced plugin or a read of SKILL.md does not on its own establish an executed plugin call or applied workflow.
