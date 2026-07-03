// compliance.mjs
// Pantheon operating-context injection.
//
// When an agent is delegated to HEADLESS (claude -p / codex exec / grok -p), it
// loads most of its own context natively — but empirical probing (2026-07-03)
// showed consistent gaps that vary by agent:
//   - ~/.claude/DESIGN.md never auto-loads for ANY agent (it is a conditional
//     pointer, read only when doing UI work).
//   - Grok does not auto-load its memory (~/.grok/KNOWLEDGE.md); Codex likewise.
//   - Codex reads AGENTS.md, not CLAUDE.md, so it misses a project's CLAUDE.md
//     when there is no AGENTS.md at the repo root.
// This module prepends a short, clearly-delimited reminder to the delegated
// prompt so the receiving agent honors its FULL operating context (global +
// project instructions, memory, the shared design system, and its usual
// conventions) instead of treating the bare task as the whole world.
//
// Disable with GROK_BRIDGE_NO_COMPLIANCE=1 for a raw, un-prefixed delegation.
// ESM only, pure — no I/O, no mutation.

const DESIGN_SYSTEM = '~/.claude/DESIGN.md';

// Agent-specific "standing instructions" line(s): name the sources that agent
// must honor, calling out the ones it does NOT auto-load in headless mode.
const AGENT_SOURCES = Object.freeze({
  claude: '- Your global ~/.claude/CLAUDE.md, this project\'s CLAUDE.md, your loaded rules, and your project memory index (MEMORY.md) are your standing instructions — keep following them.',
  codex: '- Follow your global ~/.codex/AGENTS.md. ALSO read this project\'s ./AGENTS.md and ./CLAUDE.md if present (you do not auto-load CLAUDE.md), plus any project memory.',
  grok: '- Follow your global ~/.grok/AGENTS.md and this project\'s CLAUDE.md/AGENTS.md, and consult your memory at ~/.grok/KNOWLEDGE.md (it is NOT auto-loaded here).'
});

/** True unless the operator opted out with GROK_BRIDGE_NO_COMPLIANCE=1. */
export function complianceEnabled(env = process.env) {
  return env.GROK_BRIDGE_NO_COMPLIANCE !== '1';
}

/**
 * The operating-context reminder for a given agent ('claude'|'codex'|'grok').
 * Returns '' for an unknown agent so callers can safely concatenate.
 */
export function complianceHeader(agent) {
  const sources = AGENT_SOURCES[agent];
  if (!sources) return '';
  return [
    '=== Pantheon operating context — honor this ===',
    'You are running headless, delegated by another local agent via Pantheon. You are still a full',
    'instance of yourself: keep obeying your normal operating rules and conventions, not just the task',
    'below. Do not relax your standards because this is an automated/headless call.',
    '',
    'Before you answer:',
    sources,
    `- If the task produces ANY UI, visual, design, dashboard, HTML/email, or styling output, first read`,
    `  and apply the shared design system at ${DESIGN_SYSTEM} (it is NOT auto-loaded here).`,
    '- Apply your usual coding-style/immutability, tone (no sycophancy), and safety conventions.',
    '=== end operating context ===',
    ''
  ].join('\n');
}

/**
 * Prepend the operating-context header to a delegated prompt (no-op when the
 * agent is unknown or GROK_BRIDGE_NO_COMPLIANCE=1). Never mutates its input.
 */
export function withCompliance(agent, prompt, env = process.env) {
  if (!complianceEnabled(env)) return prompt;
  const header = complianceHeader(agent);
  if (!header) return prompt;
  return `${header}\n---\n\n${prompt}`;
}
