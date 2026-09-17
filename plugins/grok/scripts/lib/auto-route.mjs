// auto-route.mjs
// Pick a detected harness + quality tier for a natural-language job.
// Does not spawn. Companions consume the frozen pick.
// Image work stays on Grok (Imagine). ChatGPT Images 2.0 / gpt-image-2 is
// an OpenAI API engine, not a Codex -m slug, so it is never selected here.
import { MODEL_TIERS, ROUTING_TABLE } from './model-routing.mjs';

const QUALITIES = new Set(['good', 'better', 'best']);

const KIND_ALIASES = Object.freeze({
  imagine: 'imagine',
  image: 'imagine',
  images: 'imagine',
  visual: 'imagine',
  video: 'imagine',
  assets: 'imagine',
  implement: 'implement',
  code: 'implement',
  coding: 'implement',
  build: 'implement',
  fix: 'implement',
  verify: 'verify',
  test: 'verify',
  review: 'review',
  critique: 'review',
  plan: 'plan',
  planning: 'plan',
  architecture: 'plan',
  design: 'plan',
  spec: 'plan',
  ultracode: 'plan',
  reasoning: 'reasoning',
  'second-opinion': 'reasoning',
  security: 'security',
  summarize: 'summarize',
  draft: 'summarize',
  health: 'health'
});

const KIND_HINTS = [
  { kind: 'imagine', re: /\b(image|images|imagine|video|visual|hero shot|product shot|illustration|logo|thumbnail)\b/i },
  { kind: 'security', re: /\b(security|authn|authz|authentication|authorization|credential|secret|payment|vulnerability)\b/i },
  { kind: 'plan', re: /\b(plan this|ultracode|architecture|spec(?:ify)?|design (?:the|a|this)|roadmap)\b/i },
  { kind: 'verify', re: /\b(verify|test|repro(?:duce)?|failing test|ci)\b/i },
  { kind: 'review', re: /\b(review|critique|second look|multi-agent)\b/i },
  { kind: 'implement', re: /\b(implement|fix|build|code|refactor|write the)\b/i },
  { kind: 'summarize', re: /\b(summarize|summary|tl;dr|draft)\b/i },
  { kind: 'reasoning', re: /\b(reason|second opinion|tradeoff|compare)\b/i }
];

// Preference lists are ordered Good → Better → Best. Missing harnesses
// are skipped; the last present entry in the requested quality slice wins.
const KIND_PREFERENCE = Object.freeze({
  imagine: Object.freeze(['grok']),
  implement: Object.freeze(['agy', 'omp', 'opencode', 'codex']),
  verify: Object.freeze(['omp', 'opencode', 'codex']),
  review: Object.freeze(['agy', 'omp', 'opencode', 'codex', 'grok']),
  plan: Object.freeze(['agy', 'hermes', 'omp', 'claude', 'ultracode']),
  reasoning: Object.freeze(['hermes', 'omp', 'claude']),
  security: Object.freeze(['claude']),
  summarize: Object.freeze(['agy', 'omp', 'claude']),
  health: Object.freeze(['agy', 'omp', 'grok', 'claude'])
});

const COMPANION_FOR = Object.freeze({
  grok: 'grok',
  claude: 'claude',
  codex: 'codex',
  omp: 'omp',
  opencode: 'opencode',
  agy: 'agy',
  hermes: 'hermes',
  ultracode: 'ultracode'
});

const LANE_FOR_KIND = Object.freeze({
  imagine: 'imagine',
  implement: 'implement',
  verify: 'verify',
  review: 'review',
  plan: 'architecture',
  reasoning: 'second-opinion',
  security: 'security',
  summarize: 'summarize',
  health: 'health'
});

export function normalizeQuality(raw) {
  if (typeof raw !== 'string') return 'better';
  const q = raw.trim().toLowerCase();
  return QUALITIES.has(q) ? q : 'better';
}

export function classifyJob(text, explicitKind = null) {
  if (typeof explicitKind === 'string' && KIND_ALIASES[explicitKind.trim().toLowerCase()]) {
    return KIND_ALIASES[explicitKind.trim().toLowerCase()];
  }
  const blob = typeof text === 'string' ? text : '';
  for (const { kind, re } of KIND_HINTS) {
    if (re.test(blob)) return kind;
  }
  return 'reasoning';
}

function present(inventory, id) {
  return Boolean(inventory?.byId?.[id]?.present);
}

const HARNESS_MENTION = /\b(?:using|via|on|with)\s+(ultracode|omp|opencode|agy|hermes|qoder|claude|codex|grok|pi|gemini)\b/i;

export function requestedHarnessFromText(text) {
  if (typeof text !== 'string') return null;
  const m = text.match(HARNESS_MENTION);
  return m ? m[1].toLowerCase() : null;
}

function pickFromPreference(ids, inventory, quality) {
  const available = ids.filter((id) => present(inventory, id));
  if (available.length === 0) return null;
  if (quality === 'good') return available[0];
  if (quality === 'best') return available[available.length - 1];
  return available[Math.min(1, available.length - 1)] || available[0];
}

function modelFor(harness, kind, quality) {
  if (harness === 'grok') {
    const grok = MODEL_TIERS.grok;
    if (quality === 'good') return { model: grok.cheap.model, effort: grok.cheap.effort };
    if (kind === 'imagine' || quality === 'best') {
      return { model: grok.deepCreative.model, effort: grok.deepCreative.effort };
    }
    return { model: grok.default.model, effort: grok.default.effort };
  }
  if (harness === 'claude') {
    const claude = MODEL_TIERS.claude;
    if (quality === 'good') return { model: claude.cheap, effort: null };
    if (quality === 'best' || kind === 'security' || kind === 'plan') {
      return { model: claude.deep, effort: null };
    }
    return { model: claude.balanced, effort: null };
  }
  if (harness === 'codex') {
    const codex = MODEL_TIERS.codex;
    if (quality === 'good') return { model: codex.cheap.model, effort: codex.cheap.effort };
    if (kind === 'review') return { model: codex.review.model, effort: codex.review.effort };
    if (quality === 'best') return { model: codex.deep.model, effort: codex.deep.effort };
    return { model: codex.default.model, effort: codex.default.effort };
  }
  if (harness === 'agy') {
    if (quality === 'best') return { model: 'gemini-3.1-pro-high', effort: 'high' };
    if (quality === 'good') return { model: 'gemini-3.7-flash-low', effort: 'low' };
    return { model: 'gemini-3.7-flash-medium', effort: 'medium' };
  }
  return { model: null, effort: null };
}

function spawnPlan(harness, kind, quality, modelSpec) {
  if (harness === 'grok') {
    const sub = kind === 'imagine' ? 'imagine' : kind === 'review' ? 'review' : 'task';
    return { companion: 'grok', subcommand: sub, extra: [] };
  }
  if (harness === 'claude') {
    return { companion: 'claude', subcommand: null, extra: [] };
  }
  if (harness === 'codex') {
    return { companion: 'codex', subcommand: null, extra: [] };
  }
  if (harness === 'omp') {
    const args = ['-p', '--cwd', process.cwd()];
    if (kind === 'plan') args.push('--plan');
    if (modelSpec.model) args.push(`--model=${modelSpec.model}`);
    return { companion: 'omp', subcommand: null, extra: args, promptFlag: null };
  }
  if (harness === 'opencode') {
    const args = ['run', '--dir', process.cwd(), '--format', 'json'];
    if (modelSpec.model) args.push('-m', modelSpec.model);
    return { companion: 'opencode', subcommand: null, extra: args, promptFlag: null };
  }
  if (harness === 'agy') {
    const args = ['-p', '--output-format', 'json', '--mode', 'plan'];
    if (modelSpec.model) args.push('--model', modelSpec.model);
    if (modelSpec.effort) args.push('--effort', modelSpec.effort);
    return { companion: 'agy', subcommand: null, extra: args, promptFlag: null };
  }
  if (harness === 'hermes') {
    return { companion: 'hermes', subcommand: null, extra: ['--safe-mode', '-z'], promptFlag: '-z' };
  }
  if (harness === 'ultracode') {
    return { companion: 'ultracode', subcommand: null, extra: [], promptFlag: null };
  }
  return { companion: harness, subcommand: null, extra: [], promptFlag: null };
}

/**
 * Resolve a job onto a present harness.
 * `requestedHarness` forces a catalog id when present; if that id is missing
 * the pick falls back and records `fallbackFrom`.
 */
export function pickRoute({
  text = '',
  kind = null,
  quality = 'better',
  inventory,
  requestedHarness = null,
  host = null
} = {}) {
  const resolvedKind = classifyJob(text, kind);
  const resolvedQuality = normalizeQuality(quality);
  const pref = KIND_PREFERENCE[resolvedKind] || KIND_PREFERENCE.reasoning;
  const wanted = requestedHarness || requestedHarnessFromText(text);
  let harness = null;
  let fallbackFrom = null;
  if (wanted) {
    if (present(inventory, wanted)) harness = wanted;
    else {
      fallbackFrom = wanted;
      harness = pickFromPreference(pref, inventory, resolvedQuality);
    }
  } else {
    harness = pickFromPreference(pref, inventory, resolvedQuality);
  }

  const modelSpec = harness ? modelFor(harness, resolvedKind, resolvedQuality) : { model: null, effort: null };
  const spawn = harness ? spawnPlan(harness, resolvedKind, resolvedQuality, modelSpec) : null;
  const from = host && present(inventory, host) ? host : (host || 'unknown');
  const tableKey = `${from}-to-${harness}`;
  const direction = harness && ROUTING_TABLE[tableKey]
    ? tableKey
    : harness === 'claude' ? `${from}-to-claude` : harness === 'codex' ? `${from}-to-codex` : harness === 'grok' ? `${from}-to-grok` : `${from}-to-${harness || 'none'}`;

  return Object.freeze({
    kind: resolvedKind,
    quality: resolvedQuality,
    host: from,
    harness,
    companion: COMPANION_FOR[harness] || harness,
    lane: LANE_FOR_KIND[resolvedKind],
    direction,
    model: modelSpec.model,
    effort: modelSpec.effort,
    spawn,
    fallbackFrom,
    available: pref.filter((id) => present(inventory, id))
  });
}
