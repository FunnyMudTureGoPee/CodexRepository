---
name: chat-image-bridge
description: Queue image generation work for ChatGPT Web, check its status, and accept approved image candidates into a local project. Use when the user explicitly asks to use Chat Image Bridge, Chat Web image generation, or to avoid using the Image API/Codex image generation for a project asset.
---

# Chat Image Bridge

Use the `chat-image-bridge` MCP tools for image tasks assigned to ChatGPT Web.

1. Call `generate_image` with a complete prompt, an absolute `projectRoot`, and an `outputPath` relative to that root.
2. Include composition, intended use, aspect ratio, palette, and negative constraints in the prompt. Never put secrets in prompts.
3. After queuing, tell the user the job ID and current status. Offer to call `open_image_manager` so the user can track and manage jobs inside Codex. Do not keep polling in a tight loop and do not operate ChatGPT Web yourself.
4. When the user asks for status, call `get_image_status`. When they ask for a dashboard, task manager, or visual status, call `open_image_manager`, read `managerUrl` from its structured result, then immediately call the Codex app `open_in_codex` tool with `{ target: { type: "browser", url: managerUrl }, placement: "right" }`. Do not claim that the manager is visible until `open_in_codex` succeeds.
5. A `review` result means the browser extension uploaded a candidate but the project file has not changed. Ask the user to review it before calling `accept_image`, unless they explicitly authorized automatic acceptance.
6. Version 0.3.x supports text-to-image only. Do not claim support for reference images or image-to-image editing.
7. `accept_image` writes the approved file and archives a numbered version under `<projectRoot>/.assets/images/`. The task manager may call `accept_image`, `retry_image`, and `cancel_image` directly after the user clicks the corresponding control.

The bridge is personal local automation, not an official ChatGPT Web API. If the browser adapter reports failure, explain that the ChatGPT UI may have changed and direct the user to the extension status panel.
