---
description: Hand off all image + video generation and editing to Grok Build (Grok Imagine superpower). Claude deletes the task; Grok executes with its full tools and skill and returns artifacts.
argument-hint: '<natural language request (generate / edit / video / variations / references)> [--background|--wait]'
disable-model-invocation: true
allowed-tools: Read, Glob, Grep, Bash(node:*), Bash(git:*), AskUserQuestion
---
Run the visual task through the local authenticated Grok Build CLI (headless).

Raw slash-command arguments:
`$ARGUMENTS`

Core rules:
- This is a pure hand-off ("Claude deletes"). Do not generate or edit images yourself.
- Grok (with its Imagine models, imagine skill, reference handling, image_to_video, ffmpeg assembly, and optional internal subagents) does the real work.
- Your only job is to forward cleanly and return Grok's output + any surfaced local media paths/markdown verbatim.
- Support --background and --wait exactly as the host provides them.

Execution mode:
- If raw arguments contain `--background`, launch via Bash with run_in_background: true and tell the user to check `/grok:status`.
- If `--wait`, run in foreground.
- Otherwise estimate (cheap for most stills, recommend background for video or complex consistency work) and use AskUserQuestion once with the recommended option first.

Argument handling:
- Preserve the user's full request exactly (including any reference paths, aspect hints, "edit the previous...", "make a 6s cinematic...", etc.).
- Do not rewrite the creative intent.
- The companion script will craft the actual prompt sent to headless Grok.

Forwarding:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-companion.mjs" imagine "$ARGUMENTS"
```

Background:
```typescript
Bash({
  command: `node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-companion.mjs" imagine "$ARGUMENTS"`,
  description: "Grok Imagine task",
  run_in_background: true
})
```

Return the companion stdout **verbatim** (Grok's text + any ready markdown or local paths it produced). Do not paraphrase, summarize, or add commentary before or after.

After success, the generated images/videos should be in the workspace (normalized under a clear media folder) and immediately usable.
