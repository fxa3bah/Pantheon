// model-routing.mjs
// Single source of truth for model routing across the Pantheon delegation mesh.
// This is the ONLY file in the repo allowed to contain model-ID string literals
// (claude-*, gpt-*, grok-*, codex-*). Every other module must call
// classifyTask()/resolveModel() rather than hardcode a model string, so a
// model rename/retirement is a one-file edit.
// ESM only, no external deps, no API keys. Tables and returned objects are
// frozen (deep-frozen for the tables) — pure functions only, nothing mutates.
//
// Packet field extractors + nonEmptyString are owned by pantheon-packet.mjs (the
// packet schema's home). Import them rather than re-implementing, so the two
// modules can't drift. pantheon-packet has no imports, so this edge is acyclic.
import {
  packetModel,
  packetEffort,
  packetBestOfN,
  nonEmptyString
} from './pantheon-packet.mjs';

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}
// What each local CLI ACTUALLY accepts, verified against the installed binaries
// (`grok models`, `grok --help`, `codex exec -m <slug>`, `claude --model`).
// The routing tables below say what we *want*; this says what the CLI *takes*.
// Keeping both lets validateRoutingTables() catch a stale slug at test time
// instead of at spawn time — the 2026-07-08 Grok 4.5 cutover shipped a cheap
// tier (`grok-composer-2.5-fast`) and a `--best-of-n` flag that no longer
// exist, and 114 table-vs-table tests all passed. Re-verify with
// `node plugins/grok/scripts/probe-cli-capabilities.mjs` when a CLI updates.
export const AGENT_CAPABILITIES = deepFreeze({
  claude: {
    models: ['claude-opus-4-8', 'claude-sonnet-5', 'claude-haiku-4-5-20251001'],
    // The claude CLI DOES take `--effort low|medium|high|xhigh|max`. Pantheon
    // does not route it yet — no claude row carries an effort, so every Claude
    // leg runs at the CLI default. Listed here so the manifest stays honest
    // (and so buildArgs would emit a legal value if a row ever adds one).
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    supportsBestOfN: false,
    contextSuffixModels: ['claude-sonnet-5', 'claude-opus-4-8']
  },
  codex: {
    models: ['gpt-5.5', 'gpt-5.3-codex-spark', 'codex-auto-review', 'gpt-5.4-mini'],
    // `minimal` is a real codex effort level but is incompatible with the
    // web_search tool codex enables by default — it 400s. Excluded on purpose.
    efforts: ['low', 'medium', 'high', 'xhigh'],
    supportsBestOfN: false,
    contextSuffixModels: []
  },
  grok: {
    // `grok models` lists exactly one selectable model. grok-composer-2.5-fast
    // is only a config-level fork_secondary_model, NOT a `-m` slug.
    models: ['grok-4.5'],
    efforts: ['low', 'medium', 'high'],  // no xhigh on 4.5
    supportsBestOfN: false,              // no --best-of-n flag exists
    contextSuffixModels: []
  }
});

// Model tiers per agent (for health reporting).
export const MODEL_TIERS = deepFreeze({
  claude: {
    deep: 'claude-opus-4-8',
    default: 'claude-opus-4-8',
    balanced: 'claude-sonnet-5',
    cheap: 'claude-haiku-4-5-20251001'
  },
  codex: {
    deep: { model: 'gpt-5.5', effort: 'xhigh' },
    default: { model: 'gpt-5.3-codex-spark', effort: 'high' },
    review: { model: 'codex-auto-review', effort: 'high' },
    // `minimal` here 400s ("tools cannot be used with reasoning.effort
    // 'minimal': web_search") — `low` is the cheapest effort that actually runs.
    cheap: { model: 'gpt-5.4-mini', effort: 'low' }
  },
  grok: {
    // Grok 4.5 (2026-07-08): CLI exposes high|medium|low only — no xhigh.
    // bestOfN is routing INTENT only (surfaced in the review prompt + ledger);
    // it is never emitted as a CLI flag — grok has no --best-of-n.
    deepCreative: { model: 'grok-4.5', effort: 'high', bestOfN: 3 },
    default: { model: 'grok-4.5', effort: 'high' },
    // grok-composer-2.5-fast is not a selectable `-m` slug; 4.5 @ low is the
    // real cheap tier.
    cheap: { model: 'grok-4.5', effort: 'low' }
  }
});

// Routing table: direction -> taskClass -> {model, effort?, bestOfN?}.
// effort is omitted for claude rows: the CLI accepts `--effort`, but Pantheon
// does not route it, so Claude legs take the CLI default. buildArgs() therefore
// never emits `--effort` for claude regardless of what a row or packet says.
export const ROUTING_TABLE = deepFreeze({
  'claude-to-grok': {
    imagine: { model: 'grok-4.5', effort: 'high' },
    'creative-review': { model: 'grok-4.5', effort: 'high', bestOfN: 3 },
    task: { model: 'grok-4.5', effort: 'medium' },
    health: { model: 'grok-4.5', effort: 'low' }
  },
  'claude-to-codex': {
    implement: { model: 'gpt-5.3-codex-spark', effort: 'high' },
    review: { model: 'codex-auto-review', effort: 'high' },
    verify: { model: 'gpt-5.3-codex-spark', effort: 'high' },
    health: { model: 'gpt-5.4-mini', effort: 'low' }
  },
  'grok-to-claude': {
    architecture: { model: 'claude-opus-4-8' },
    'second-opinion': { model: 'claude-sonnet-5' },
    'data-model': { model: 'claude-sonnet-5' },
    'security-review': { model: 'claude-opus-4-8' },
    summarize: { model: 'claude-haiku-4-5-20251001' },
    health: { model: 'claude-haiku-4-5-20251001' }
  },
  'grok-to-codex': {
    implement: { model: 'gpt-5.3-codex-spark', effort: 'high' },
    review: { model: 'codex-auto-review', effort: 'high' },
    verify: { model: 'gpt-5.3-codex-spark', effort: 'high' },
    health: { model: 'gpt-5.4-mini', effort: 'low' }
  },
  'codex-to-claude': {
    'second-opinion': { model: 'claude-sonnet-5' },
    reasoning: { model: 'claude-opus-4-8' },
    architecture: { model: 'claude-opus-4-8' },
    'security-review': { model: 'claude-opus-4-8' },
    health: { model: 'claude-haiku-4-5-20251001' }
  },
  'codex-to-grok': {
    imagine: { model: 'grok-4.5', effort: 'high' },
    assets: { model: 'grok-4.5', effort: 'high' },
    'creative-review': { model: 'grok-4.5', effort: 'high', bestOfN: 3 },
    task: { model: 'grok-4.5', effort: 'medium' },
    draft: { model: 'grok-4.5', effort: 'medium' },
    health: { model: 'grok-4.5', effort: 'low' }
  }
});

const GENERIC_TASK_CLASS = deepFreeze({ grok: 'task', claude: 'second-opinion', codex: 'implement' });
const MECHANICAL_TASK_CLASSES = new Set(['verify', 'summarize', 'draft', 'health']);
const RISK_KEYWORDS = [
  'security', 'auth', 'payment', 'credential', 'secret', 'data-loss', 'migration', 'destructive', 'production'
];
// Pre-compiled once at module load; keywordHit() previously rebuilt these RegExp
// objects on every call. `\w*` stem-matches (credential → credentials, etc.).
// Two keywords need a hand-written pattern rather than the generic stem:
//  - `auth`: a bare `\bauth\w*` also matches "author"/"authority"/"authored",
//    which are not risk signals. Enumerate the real family instead.
//  - `data-loss`: the literal hyphen missed the far more common "data loss".
const RISK_KEYWORD_RES = RISK_KEYWORDS.map((kw) => {
  if (kw === 'auth') return /\bauth\b|\bauthn\b|\bauthz\b|\bauthentic\w*|\bauthoriz\w*/i;
  if (kw === 'data-loss') return /\bdata[\s-]?loss\b/i;
  return new RegExp(`\\b${kw}\\w*`, 'i');
});

function agentFromDirection(direction) {
  if (typeof direction !== 'string') return null;
  if (direction.endsWith('-to-grok')) return 'grok';
  if (direction.endsWith('-to-claude')) return 'claude';
  if (direction.endsWith('-to-codex')) return 'codex';
  return null;
}

// -- classifyTask --
function laneTaskClass(packet, agent) {
  const lane = packet?.lane;
  if (!nonEmptyString(lane)) return null;
  const l = lane.trim().toLowerCase();
  if (l === 'visual' || l === 'image' || l === 'video') return 'imagine';
  if (l.includes('security')) return 'security-review';
  if (l === 'review') return agent === 'grok' ? 'creative-review' : 'review';
  if (l === 'implement' || l === 'build') return 'implement';
  if (l === 'verify' || l === 'test') return 'verify';
  if (l === 'architecture' || l === 'design') return 'architecture';
  if (l === 'data' || l === 'data-model') return 'data-model';
  if (l === 'second-opinion') return 'second-opinion';
  return null;
}
function subcommandTaskClass(subcommand, agent, generic) {
  switch (subcommand) {
    case 'imagine': return 'imagine';
    case 'review': return agent === 'grok' ? 'creative-review' : 'review';
    case 'task': return generic;
    case 'health': return 'health';
    default: return generic;
  }
}
// Fallback guaranteed to have a row: the generic if present, else 'health'
// (cheapest, lowest-blast-radius), else the row's first key.
function safeFallbackClass(row, generic) {
  if (row[generic]) return generic;
  if (row.health) return 'health';
  return Object.keys(row)[0];
}

// Maps (direction, subcommand, packet) to a taskClass guaranteed to have a
// row in ROUTING_TABLE[direction] — falls back to the generic, then
// 'health', then the row's first key. Never returns a class with no row.
export function classifyTask(direction, subcommand, packet = null) {
  const agent = agentFromDirection(direction);
  const generic = GENERIC_TASK_CLASS[agent] ?? null;
  const row = ROUTING_TABLE[direction] ?? null;
  const candidate = laneTaskClass(packet, agent) ?? subcommandTaskClass(subcommand, agent, generic);
  if (!row) return candidate ?? generic;
  if (candidate && Object.prototype.hasOwnProperty.call(row, candidate)) return candidate;
  return safeFallbackClass(row, generic);
}

// -- resolveModel --
// (packet extractors packetModel/packetEffort/packetBestOfN are imported from
// pantheon-packet.mjs — see the import at the top of this file.)
function agentDefaultEffort(agent) {
  const def = MODEL_TIERS[agent]?.default;
  return def && typeof def === 'object' && 'effort' in def ? def.effort : null;
}
function envModelFor(agent, env) {
  const key = agent === 'claude' ? 'GROK_BRIDGE_CLAUDE_MODEL'
    : agent === 'codex' ? 'GROK_BRIDGE_CODEX_MODEL'
    : agent === 'grok' ? 'GROK_BRIDGE_GROK_MODEL'
    : null;
  if (!key) return null;
  const v = env?.[key];
  return nonEmptyString(v) ? v.trim() : null;
}
// Flatten a packet field that may be a string, object, or array. `constraints`
// is documented as an object, and template-interpolating one yields the literal
// "[object Object]", hiding every keyword inside it.
function flatten(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  try { return JSON.stringify(v); } catch { return ''; }
}

// `promptText` matters as much as the packet: most delegations are plain
// strings with no packet at all, so scanning only packet.objective/constraints
// meant the documented "auto-escalates on risk keywords" never fired for
// `/grok:task "migrate the production auth database"`.
function keywordHit(packet, promptText = '') {
  const haystack = [
    flatten(packet?.objective),
    flatten(packet?.constraints),
    flatten(promptText)
  ].join(' ');
  if (!haystack.trim()) return false;
  // Stem/prefix match (word-start anchored, trailing word-chars allowed) so a
  // keyword also matches its morphological family: credential(s), secret(s),
  // auth(entication|orization), migration(s), etc. Escalation only ever
  // upgrades the model tier, so mild over-matching here is safe and
  // preferred over missing a real security phrasing.
  return RISK_KEYWORD_RES.some((re) => re.test(haystack));
}
// The reason recorded in the ledger must be the signal that actually fired.
// This previously reported 'retry' whenever attempt >= 2 even when an explicit
// packet.escalate was the real trigger, so the audit field could disagree with
// the cause.
function escalationReason({ explicit, risky, attempt }) {
  if (explicit) return 'packet';
  if (risky) return 'keyword';
  if (attempt >= 2) return 'retry';
  return 'keyword';
}

// Cheap tier for an agent, sourced from MODEL_TIERS (never a fresh literal).
function pinCheap(agent) {
  const cheap = MODEL_TIERS[agent]?.cheap;
  if (!cheap) return { model: null, effort: null, bestOfN: null, escalated: false };
  if (typeof cheap === 'string') return { model: cheap, effort: null, bestOfN: null, escalated: false };
  return { model: cheap.model, effort: cheap.effort ?? null, bestOfN: null, escalated: false };
}
// Deep tier for an agent. Grok preserves the row's own bestOfN (not the
// tier's fixed 3) since not every grok taskClass carries a bestOfN.
function escalateToDeep(agent, currentBestOfN, reason) {
  const tier = MODEL_TIERS[agent]?.deep ?? MODEL_TIERS[agent]?.deepCreative;
  if (!tier) return { model: null, effort: null, bestOfN: null, escalated: reason };
  if (typeof tier === 'string') return { model: tier, effort: null, bestOfN: null, escalated: reason };
  const bestOfN = agent === 'grok' ? (currentBestOfN ?? null) : null;
  return { model: tier.model, effort: tier.effort ?? null, bestOfN, escalated: reason };
}

// Escalation/cost-cap logic — only invoked when source === 'table'.
//
// Ordering matters and is deliberate:
//   1. security-review and mechanical classes are never touched at all.
//   2. An explicit escalate/cost:high from the packet wins.
//   3. A RISK KEYWORD beats budget.cost:'low'. This inverted before: the cost
//      cap was checked first, so a packet saying `cost:'low'` on "rotate the
//      production credentials" pinned the CHEAP tier. A cost hint from an
//      untrusted delegator must not be able to downgrade risky work.
//   4. Only then does the cost cap apply.
export function applyEscalation({ agent, taskClass, packet, attempt = 1, promptText = '', model, effort, bestOfN }) {
  if (taskClass === 'security-review' || MECHANICAL_TASK_CLASSES.has(taskClass)) {
    return { model, effort, bestOfN, escalated: false };
  }
  const explicit = packet?.escalate === true || packet?.budget?.cost === 'high';
  const risky = keywordHit(packet, promptText);
  const retry = attempt >= 2;

  if (explicit || risky) {
    return escalateToDeep(agent, bestOfN, escalationReason({ explicit, risky, attempt }));
  }
  if (packet?.budget?.cost === 'low') return pinCheap(agent);
  if (retry) return escalateToDeep(agent, bestOfN, escalationReason({ explicit, risky, attempt }));
  return { model, effort, bestOfN, escalated: false };
}

// An effort only reaches the CLI if that CLI actually accepts it. A packet or
// env override can carry any string (`packetEffort` only checks non-empty), and
// an unknown level makes the child exit nonzero — dropping it instead lets the
// CLI apply its own default, which is always better than a hard failure.
export function safeEffort(agent, effort) {
  if (effort == null) return null;
  const allowed = AGENT_CAPABILITIES[agent]?.efforts;
  if (!allowed) return null;                 // agent has no effort flag at all
  return allowed.includes(effort) ? effort : null;
}

// bestOfN is deliberately NOT emitted: no CLI in the mesh has a --best-of-n
// flag. It survives on the resolved object as routing intent (the review
// prompt asks Grok to run best-of-n internally) and as a ledger field.
function buildArgs(agent, model, effort) {
  if (!agent || !model) return [];
  const eff = safeEffort(agent, effort);
  if (agent === 'claude') return ['--model', model];
  if (agent === 'codex') {
    const args = ['-m', model];
    if (eff != null) args.push('-c', `model_reasoning_effort=${eff}`);
    return args;
  }
  if (agent === 'grok') {
    const args = ['--model', model];
    if (eff != null) args.push('--effort', eff);
    return args;
  }
  return [];
}

// Test-time guard: every literal in MODEL_TIERS and ROUTING_TABLE must be legal
// for the CLI it targets. This is the check that would have caught the Grok 4.5
// cutover shipping a dead cheap slug and a nonexistent flag. Returns a list of
// human-readable problems; empty means the tables match the installed CLIs.
export function validateRoutingTables() {
  const problems = [];
  const check = (agent, where, row) => {
    const caps = AGENT_CAPABILITIES[agent];
    if (!caps) { problems.push(`${where}: unknown agent "${agent}"`); return; }
    if (row.model && !caps.models.includes(row.model)) {
      problems.push(`${where}: model "${row.model}" is not accepted by the ${agent} CLI`);
    }
    if (row.effort != null && (!caps.efforts || !caps.efforts.includes(row.effort))) {
      problems.push(`${where}: effort "${row.effort}" is not accepted by the ${agent} CLI`);
    }
  };
  for (const [agent, tiers] of Object.entries(MODEL_TIERS)) {
    for (const [tier, v] of Object.entries(tiers)) {
      check(agent, `MODEL_TIERS.${agent}.${tier}`, typeof v === 'string' ? { model: v } : v);
    }
  }
  for (const [direction, row] of Object.entries(ROUTING_TABLE)) {
    const agent = agentFromDirection(direction);
    for (const [taskClass, spec] of Object.entries(row)) {
      check(agent, `ROUTING_TABLE.${direction}.${taskClass}`, spec);
    }
  }
  return problems;
}

// Resolve the model/effort/bestOfN/args for one hop of the mesh. Precedence:
// explicitModel > packet.model > env var > routing table > none. Escalation
// and cost caps apply to the table source; a RISK KEYWORD additionally applies
// as a floor over packet/env models (see below). Returns a frozen object.
//
// `promptText` is the delegated request itself. Pass it: most hops carry no
// packet, and without it the risk-keyword escalation can never fire.
//
// `explicitModel` / `explicitEffort` / `attempt` are a RESERVED operator API —
// no companion passes them today, and the caller `--model`/`-m` flag must NOT
// be wired to `explicitModel`. On the reverse legs the "caller" is Grok or
// Codex, i.e. exactly the untrusted delegator the security-review pin exists to
// stop; routing a caller flag through the explicit branch would bypass that pin
// by design. Caller model flags are handled in the companions and gated there.
export function resolveModel({
  direction,
  taskClass,
  packet = null,
  explicitModel = null,
  explicitEffort = null,
  promptText = '',
  contextChars = 0,
  attempt = 1,
  env = process.env
} = {}) {
  const agent = agentFromDirection(direction);
  const tableRow = ROUTING_TABLE[direction]?.[taskClass] ?? null;
  let model = null;
  let effort = null;
  let bestOfN = null;
  let source = 'binary-default';
  let escalated = false;
  if (nonEmptyString(explicitModel)) {
    model = explicitModel.trim();
    effort = nonEmptyString(explicitEffort) ? explicitEffort.trim() : (tableRow?.effort ?? agentDefaultEffort(agent));
    source = 'explicit';
  } else if (taskClass === 'security-review' && tableRow) {
    // A security review must never be silently downgraded by an untrusted
    // delegator's packet.model or an env override — resolve straight from
    // the routing table (applyEscalation short-circuits security-review to
    // the table row, untouched by cost caps). Only an explicitModel (human
    // CLI --model, handled above) may override this.
    source = 'table';
    ({ model, effort, bestOfN, escalated } = applyEscalation({
      agent, taskClass, packet, attempt, promptText,
      model: tableRow.model, effort: tableRow.effort ?? null, bestOfN: tableRow.bestOfN ?? null
    }));
  } else {
    const pModel = packetModel(packet);
    if (nonEmptyString(pModel)) {
      model = pModel;
      effort = packetEffort(packet) ?? tableRow?.effort ?? null;
      bestOfN = packetBestOfN(packet);
      source = 'packet';
    } else {
      const envModel = envModelFor(agent, env);
      if (nonEmptyString(envModel)) {
        model = envModel;
        effort = tableRow?.effort ?? agentDefaultEffort(agent);
        bestOfN = tableRow?.bestOfN ?? null;
        source = 'env';
      } else if (tableRow) {
        source = 'table';
        ({ model, effort, bestOfN, escalated } = applyEscalation({
          agent, taskClass, packet, attempt, promptText,
          model: tableRow.model, effort: tableRow.effort ?? null, bestOfN: tableRow.bestOfN ?? null
        }));
      }
    }
  }

  // Risk floor. A packet.model or env override bypassed applyEscalation
  // entirely, so an untrusted delegator could pin a cheap model onto work that
  // trips a risk keyword. Precedence still holds for ordinary work — this only
  // raises the tier, never lowers it, and never touches an explicit human
  // --model or a mechanical/security-pinned class.
  if ((source === 'packet' || source === 'env')
      && taskClass !== 'security-review'
      && !MECHANICAL_TASK_CLASSES.has(taskClass)
      && keywordHit(packet, promptText)) {
    const deep = escalateToDeep(agent, bestOfN, 'keyword');
    if (deep.model) {
      model = deep.model;
      effort = deep.effort;
      bestOfN = deep.bestOfN;
      escalated = 'keyword';
      source = `${source}-risk-escalated`;
    }
  }
  // [1m] context suffix — claude agent only, applies regardless of source.
  const contextTriggered = agent === 'claude' && (contextChars > 600000 || packet?.budget?.context === '1m');
  if (contextTriggered && model) {
    if (model === 'claude-haiku-4-5-20251001') model = 'claude-sonnet-5[1m]';
    else if (!model.endsWith('[1m]')) model = `${model}[1m]`;
    if (!escalated) escalated = 'context';
  }

  return Object.freeze({
    agent,
    model,
    effort,
    bestOfN: bestOfN ?? null,
    args: buildArgs(agent, model, effort),
    source,
    escalated,
    taskClass
  });
}
