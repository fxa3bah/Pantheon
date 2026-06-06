# Image Bridge Workflows (Killer Feature)

This document shows the intended symmetric cross-agent patterns where **Grok Imagine is the clear superpower for image gen/edit/video**, and the bridge makes handing work back and forth feel natural.

## Core Principle
- Claude Code deletes visual tasks → Grok does them with full Imagine power + consistency tools.
- Grok keeps all pure visual iteration. It only delegates non-visual supporting work back to Claude (code, docs, reviews, data models, etc.).
- Everything lands in the shared workspace with clean paths and markdown.

## Primary Flow: Claude → Grok Imagine

In Claude Code (CLI or TUI):

```bash
/grok-imagine a hero product shot of a heavy linen napkin folded on cool marble with soft window light, 3:2

/grok-imagine using the previous image as strong reference, recolor the napkin to deep charcoal, keep exact folds, texture, and lighting

/grok-imagine create a 6-second cinematic version: slow push-in from medium to close-up, very subtle fabric movement, warm golden hour shift at the end
```

What happens:
- The `/grok-imagine` command is a thin forwarder.
- It calls the local `grok` binary headless with a prompt that activates your full imagine skill (reference-first, edit vs gen choice, video shot planning, ffmpeg assembly when needed).
- Grok may internally use subagents or best-of-n for quality if it helps.
- Final assets are written to `grok-media/<job-id>/` (or similar conventional folder) with relative markdown returned verbatim.

You get usable images/videos immediately in the Claude workspace.

## Symmetric Return: Grok does visuals, delegates supporting work

After Grok has generated images (either directly or via the bridge above), it can hand non-visual work back:

From Grok:
- "claude-delegate write the Next.js component + Tailwind that displays the three hero variations in grok-media/hero-*/ with responsive behavior, proper alt text, and a lightbox"
- "claude-delegate review the marketing page code that will consume the images I just created for performance and accessibility"
- "claude-delegate draft the launch email copy that references the new assets, keeping the tone premium and minimal"

The reverse companion runs `claude --bare -p "..." --output-format json` (official recommended headless form from the Claude Code CLI docs).

Claude's output and any files it creates are captured and handed back to Grok with clear provenance.

## More End-to-End Example Workflows

### Full Feature Lifecycle (Image as Killer Feature + Symmetry)
1. In Claude Code: "Build a premium product detail page for our new linen collection."
2. Claude sketches the component structure.
3. Claude: `/grok-imagine three consistent hero shots of the signature napkin in different elegant settings (marble, wood, linen tablecloth), use the same physical napkin as reference across all three, premium lifestyle photography, 3:2`
4. Grok generates the set using its Imagine tools + consistency practices. Assets land in `grok-media/hero-linen-*`.
5. Claude reviews the page layout with the images.
6. Claude gives feedback in chat: "The first one is good but the lighting feels too cool and flat. The folds need more definition. The third one has great mood but the composition is too centered — give it more breathing room on the left."
7. Switch to Grok session: invoke `grok-imagine-from-claude-feedback` with the above feedback + references to the three images.
8. Grok crafts precise `image_edit` prompts and iterates only the affected shots.
9. Grok (or Claude via bridge): `claude-delegate "Update the product page component to use the new iterated hero images. Add a subtle zoom-on-hover and make sure alt text describes the new dramatic lighting and composition."`
10. Claude implements the code changes around the latest assets.
11. Grok does a final `/grok-review` or Claude asks Grok for a multi-agent visual + code consistency pass.

Result: Best visuals from Grok Imagine, best integration/code from whichever agent is stronger, all artifacts shared.

### Video Production Pipeline
- Claude: `/grok-imagine create a 10-second brand story video for the linen collection. Start with a static hero shot, slow push-in, then gentle fabric lift with wind, end on a close-up of the texture catching light. Use the reference napkin.`
- Grok plans shots internally (per imagine skill), generates base frames, animates with image_to_video, assembles with ffmpeg, returns the final .mp4 + storyboard images.
- Claude: "The wind movement in shot 2 feels too fast." 
- Grok uses the feedback skill to re-prompt only that shot with "slower, more subtle fabric lift, 6s duration".
- Grok re-assembles the video.
- Grok then `claude-delegate "Write the YouTube description, chapters, and thumbnail suggestions using the new video and the hero stills."`

### Surprise Cross-Bridge Brilliance Example: Grounded + Visual
- Claude needs a realistic "desert luxury" campaign image but has no reference photo.
- Claude: `/grok-imagine ...` with loose description.
- Grok (using full brilliance): First uses web_search or X tools to ground "current luxury desert resort aesthetics 2026", finds real reference details (specific dune colors, popular tent styles, lighting at golden hour in specific regions), then generates with strong grounding + Imagine.
- Returns the image + the sources it used for authenticity.
- Claude: "Great, now make the model look like a real person from the region without changing the setting."
- Grok uses `image_edit` + reference-first (per skill) — never pure gen for real people.
- Later: Grok `claude-delegate` the campaign copy that references the grounded details.

This is where the symmetry shines: Grok brings search + Imagine + multi-agent thinking; Claude brings its own strengths on the textual/implementation side.

## Best Practices

### When to Use the Bridge vs Keep Local
- **Use Grok (via bridge or native)** for: Any image/video generation, editing, consistency, visual direction, multi-perspective reviews, search-grounded creative work, X/social data informed visuals.
- **Use Claude** for: Heavy code implementation, certain long-context analysis, specific tool ecosystems it has strong plugins for, second opinions on non-visual architecture.
- **Hybrid is the win**: Generate/iterate visuals in Grok → hand code/docs around them to Claude → come back to Grok for visual QA or further Imagine passes.

### Image-Specific Best Practices Across the Bridge
- Always pass explicit reference paths when doing edits ("using the image at grok-media/hero-123.png as the primary reference").
- For consistency across many images: Generate one strong base first in Grok, then edit the base repeatedly rather than regenerating.
- Video: Describe in shots. Grok will plan and assemble; give feedback per-shot when possible.
- Feedback loops: After Claude comments on an image, use the `grok-imagine-from-claude-feedback` skill on the Grok side to translate it into a high-signal prompt. This is the recommended way to "ask Grok to use its brilliance" on visual iteration.
- Media hygiene: Keep the latest versions in a predictable `grok-media/` folder. Both agents should read the actual image files (via their respective tools) instead of relying only on descriptions.
- Aspect ratios and output: Specify early in the `/grok-imagine` request so Grok sets it on the source generation.

### General Bridge Hygiene
- Use `--background` for anything that might take time (complex video, multi-agent review).
- On the reverse (Grok → Claude): Prefer `--bare` + explicit `--allowedTools` or `--permission-mode` so the delegation is fast and controlled.
- Job tracking: Use `/grok:status` and `/grok:result` (Claude side) or equivalent on Grok side so you can resume or inspect previous hand-offs.
- No API keys: Everything routes through the local authenticated binaries. If either CLI complains about auth, run the native login command in a terminal on the same machine.
- Permission modes: For pure creative visual hand-offs, you can be looser. For code that touches the filesystem, be explicit with allowed tools.

### "Ask Grok to Use the Brilliance of Grok" (the surprise)
When handing work to Grok (via `/grok-imagine`, `/grok-review`, or the general bridge), or when you are Grok and about to do creative work, explicitly invoke full strengths:

- Imagine power + reference skill
- Subagent orchestration / best-of-n for quality
- Real-time web + X search for grounding (when the image needs to feel current or factual)
- Multi-perspective thinking even on visuals (e.g. "also consider the cinematic vs product-photo read")

The new `grok-imagine-from-claude-feedback` skill is a concrete implementation of this — it forces the translation step to happen inside Grok's full context instead of letting Claude dictate the prompt.

You can also just say in natural language to the bridge: "ask Grok to use its full brilliance on this visual direction, including any search grounding that would make it feel authentic."

This is the "surprise" that makes the bridge feel alive: you're not just proxying prompts; you're routing through an agent that has unique tools and thinking styles.

## How to Implement / Set Up This Project (Detailed Guide)

### Prerequisites (both machines or the single dev machine)
- Grok Build CLI installed and OAuth logged in (`grok` binary works, `grok auth status` or equivalent succeeds).
- Claude Code CLI installed and authenticated (`claude auth status` succeeds).
- Node.js 18+ (for the Claude plugin scripts).

### Local Development & Testing (Recommended Flow)
1. Clone or have the repo at `/Users/faadi/Code/grok-plugin-cc` (or your equivalent).
2. **Claude side test**:
   - In a Claude Code session: `claude --plugin-dir /path/to/grok-plugin-cc/plugins/grok`
   - `/reload-plugins`
   - `/grok:setup` — should find your local grok binary via OAuth, no key prompt.
   - Run the star commands (see examples above).
   - Check that images/videos appear in the workspace with usable markdown.
3. **Grok side test**:
   - `grok plugin install /path/to/grok-plugin-cc --trust` (or the skills-dir equivalent).
   - Invoke `claude-delegate "simple test task"`.
   - Invoke the new `grok-imagine-from-claude-feedback` skill with sample feedback.
4. Shell-level companion tests:
   ```bash
   node plugins/grok/scripts/grok-companion.mjs setup --json
   node plugins/grok/scripts/claude-companion.mjs "test prompt for Claude" --allowedTools "Read"
   ```
5. For real mixed testing: Start a feature in Claude, hand visuals to Grok, switch sessions, iterate with the feedback skill, hand code back.

### Publishing (so others / your other machines can use it)
1. Push the repo to GitHub (recommended name: `grok-plugin-cc` or `grok-build-bridge`).
2. For Claude Code users:
   - `/plugin marketplace add <your-org-or-username>/grok-plugin-cc`
   - `/plugin install grok@grok-plugin-cc`
3. For Grok Build users:
   - `grok plugin marketplace add <your-org-or-username>/grok-plugin-cc`
   - `grok plugin install grok-plugin-cc`
4. Test the full flow on a clean machine (auth only, no local paths).

### Extending the Bridge
- New visual commands: Add more .md files under `plugins/grok/commands/` following the codex-plugin-cc pattern (frontmatter + Bash to the companion).
- New Grok skills: Drop `SKILL.md` files under `skills/`. They become available after `grok plugin install`.
- Better asset handling: Improve the post-processing logic in the companions (the `findRecentMedia` style functions).
- Shared conventions: The `grok-media/` folder + job JSONs in `.grok-bridge/` are the current lingua franca.

See the individual SKILL.md and command .md files for more implementation notes. The companions are deliberately thin so the "brilliance" stays in the actual Grok and Claude agents.

The project is intentionally small and focused so it can be the clean, publishable bridge you described.

This should give anyone who clones it a complete, working, documented way to get the symmetric image-first bridge running quickly.

## Reference & Consistency Tips (Grok Imagine side)

When Claude hands work via the bridge, the prompt sent to Grok includes strong guidance to follow the imagine skill:
- Use `image_edit` + single strong reference when likeness or exact composition must be preserved.
- Generate a clean base first when many variations are needed, then edit the base.
- For video: plan as distinct short shots, use `image_to_video` on the intended first frame, assemble with stream copy.

Claude users don't need to know any of this — they just describe what they want in natural language after `/grok-imagine`.

## Media Location Convention

- Generated/edited images and videos from Grok are deterministically copied to `~/Pictures/grok-imagine/<date>/<job-id>/` (env var GROK_BRIDGE_MEDIA_DIR to override). The companion parses BRIDGE_MEDIA: absolute paths emitted by the instructed Grok prompt (or falls back to timed scan), copies, and returns `file://` clickable links + markdown. See BRIDGE-AUDIT.md §2 for the rationale and the exact implementation.
- The bridge companions normalize paths so markdown is always relative and portable.
- Both agents should prefer reading these files directly when doing follow-up work (Claude via its Read tool, Grok via its tools).

This keeps the bridge lightweight while making image handoff feel magical.

## Future Polish Ideas (not v1)

- A shared "image context" file that lists the latest hero assets with descriptions so either side can quickly reference "the current main hero set".
- Better video assembly helpers surfaced through the bridge.
- (The `grok-imagine-from-claude-feedback` skill already delivers the "iterate on the hero images with Claude's feedback" idea.)

The foundation is the clean symmetric hand-off with image gen/edit deliberately positioned as the killer feature.

See the full audit `BRIDGE-AUDIT.md` (in this docs/) for the independent review, confirmed bugs, security notes, and the P0/P1/P2 punch-list that drove the fixes applied here (ESM require, claude path, image gallery, two-way install via symlinks + plugin, clean .text output, etc.). The README and this doc were updated to stop overstating storage behavior.

## Best Practices (Summary)

See the main README for the full "Best Practices & the 'Ask Grok Brilliance' Surprise" section. Key highlights:

- Keep pure visual work in Grok. Use the feedback-to-imagine skill to translate Claude comments into Grok-native prompts.
- Explicit references + "ask Grok to use its full brilliance" language unlocks the best results.
- Shared `grok-media/` + job tracking makes the hand-off reliable in both directions.
- `--bare` on the Claude CLI side for the reverse leg is the documented best practice for scripts/bridges.

## How to Implement / Set Up This Project

**Prerequisites**
- Grok Build CLI installed + OAuth authenticated on the machine.
- Claude Code CLI installed + authenticated (`claude auth status`).
- Node 18+.

**Quick Local Test (Claude side)**
```bash
claude --plugin-dir /path/to/grok-plugin-cc/plugins/grok
/reload-plugins
/grok:setup
/grok-imagine a simple red square icon on white, 1:1
/grok:result
```
Verify the image file + markdown appear in the workspace.

**Quick Local Test (Grok side)**
```bash
grok plugin install /path/to/grok-plugin-cc --trust
```
Then in a Grok session:
- `claude-delegate "write a short summary of the current directory"`
- Use the new `grok-imagine-from-claude-feedback` skill with sample feedback + a reference image path.

**Full Development Cycle**
1. Make changes to commands, skills, companions, or docs.
2. Test the affected direction with the local `--plugin-dir` / `grok plugin install` methods above.
3. Use the shell companions directly for faster iteration:
   ```bash
   node plugins/grok/scripts/grok-companion.mjs imagine "test prompt"
   node plugins/grok/scripts/claude-companion.mjs "test task for Claude" --allowedTools "Read"
   ```
4. For mixed testing, actually switch between a Claude Code session and a Grok session while sharing the same working directory.

**Publishing**
- Push to GitHub.
- Claude users: `/plugin marketplace add yourname/grok-plugin-cc` then install.
- Grok users: `grok plugin marketplace add yourname/grok-plugin-cc` then install.
- The README + this doc are written so a new user can get the symmetric image-first bridge running in minutes.

**Extending**
- New Claude commands: Add `.md` files in `plugins/grok/commands/` (follow the existing frontmatter + companion call pattern).
- New Grok skills: Add folders under `skills/` with `SKILL.md`. The `grok-imagine-from-claude-feedback` skill is a great template for image-focused helpers.
- Improve asset handoff: Edit the `findRecentMedia` / post-processing logic in the two companion `.mjs` files.
- The companions are kept deliberately thin — the actual "brilliance" (Imagine, subagents, search, multi-perspective thinking) lives in the Grok and Claude agents themselves.

This project is the clean, minimal, publishable implementation of the symmetric cross-agent bridge you described, with Grok Imagine as the unambiguous killer feature. Clone it, run the tests above, and you have a working two-way system.