---
description: Hand off all image and video generation and editing to Grok Build (Grok Imagine). Grok executes with its full tooling and returns the artifacts.
argument-hint: '<generate / edit / video / variations / references request> [--background]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---
Hand `$ARGUMENTS` to the local authenticated Grok Build CLI.

- **This is a pure hand-off.** Do not generate or edit images yourself. Grok does the real work with
  its Imagine models, reference handling, `image_to_video`, and its own subagents.
- **Pass the request through verbatim** — reference paths, aspect hints, "edit the previous…",
  "make a 6s cinematic…". Do not rewrite the creative intent. The companion builds the actual prompt.
- **Do not pick a model or effort.** The router does that.
- This is the one lane that may execute tools and write files: generation cannot run read-only.

Foreground (default):
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-companion.mjs" imagine "$ARGUMENTS"
```

Video and complex consistency work can take a few minutes. If the arguments contain `--background`,
run the same command with `run_in_background: true` and tell the user to check `/grok:status`.

Print the companion's stdout **verbatim**, including the `file://` links and markdown embeds.
Assets are copied into the dated gallery, never into the working directory.
