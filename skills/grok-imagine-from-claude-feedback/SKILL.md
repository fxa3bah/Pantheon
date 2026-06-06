---
name: grok-imagine-from-claude-feedback
description: Helper skill that reads recent feedback or comments from Claude Code (via context or explicit input) and converts it into precise, high-quality prompts for Grok's image_gen or image_edit tools. Use this to iterate on visuals based on Claude's input without losing the "brilliance of Grok".
user_invocable: true
---

# grok-imagine-from-claude-feedback

This skill turns Claude Code's feedback into excellent Imagine prompts so you can keep visual iteration on the Grok side (where it belongs) while still benefiting from collaboration.

## When to use
- After Claude has seen generated images (via the bridge) and given feedback like "make the lighting more dramatic", "the character looks too young", "add more texture to the fabric", "the composition feels off-balance".
- You want to translate loose natural language feedback into the kind of precise, reference-aware, positive prompts that trigger the best results from your Imagine models and skill.
- You want to stay in control of the visual work instead of asking Claude to generate (it shouldn't).

## How it works
1. The user (or you) provides or the context contains recent Claude feedback.
2. This skill instructs you (Grok) to:
   - Summarize/extract the key visual change requests.
   - Apply your imagine skill best practices (reference-first, positive description, subject->action->setting->style->lighting->details order, 2-5 sentence target).
   - Decide gen vs edit (prefer edit + reference when likeness, composition, or previous asset must be preserved).
   - Output one or more ready-to-use prompts.
3. You then call your native `image_gen` or `image_edit` tools with the crafted prompt(s).
4. Return the new assets + a short note on how the feedback was addressed.

## Usage
Just invoke with the feedback or let it pull from recent context:

```
grok-imagine-from-claude-feedback the lighting is too flat, make it more dramatic with stronger rim light on the left, keep the exact napkin folds and marble texture from the reference
```

Or more conversational:

```
grok-imagine-from-claude-feedback Claude said the hero feels too static and the colors are washed out. Also suggested adding subtle steam for a more luxurious feel.
```

The skill will produce something like:

"Edit the previous reference image: Transform the lighting to dramatic cinematic with strong side-rim light coming from upper left, deep shadows on the right side of the folds, warm golden highlights on the fabric texture. Keep the exact napkin folds, creases, and cool marble surface unchanged. Add very subtle rising steam for a sense of freshness and luxury. High-end product photography style, shallow depth of field, soft but directional key light, rich material details, 3:2 aspect."

Then immediately use `image_edit` with the reference + that prompt.

## Best practices baked in
- Always prefer `image_edit` + explicit reference path when the feedback is an iteration on an existing asset.
- Front-load subject and key changes.
- Describe what to add/enhance rather than what to remove.
- Include lighting, mood, texture, composition notes when relevant.
- For video feedback, convert into shot-specific image_to_video prompts.
- If feedback is vague ("make it better"), ask for clarification or propose 2-3 targeted directions using best-of-n internally.

## Integration with the bridge
This skill is the natural next step after a `/grok-imagine` hand-off from Claude. Claude gives feedback in the shared workspace or chat; you use this skill to turn it into Grok-native prompts and keep iterating with superior Imagine results.

After generating the update, you can optionally `claude-delegate` non-visual follow-ups (e.g. "update the component to use the new dramatic lighting version").

This keeps the killer feature (Grok Imagine) in Grok's hands while making collaboration smooth.

(Part of the grok-plugin-cc symmetric bridge. After installing the Grok side of the bridge, invoke with the skill name or natural language.)
