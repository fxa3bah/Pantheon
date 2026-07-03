// model-routing.mjs
// Single source of truth for model routing across the Pantheon delegation mesh.
// This is the ONLY file in the repo allowed to contain model-ID string literals
// (claude-*, gpt-*, grok-*, codex-*). Every other module must call
// classifyTask()/resolveModel() rather than hardcode a model string, so a
// model rename/retirement is a one-file edit.
// ESM only, no external deps, no API keys. Tables and returned objects are
// frozen (deep-frozen for the tables) — pure functions only, nothing mutates.
function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}
function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

// Model tiers per agent (for health reporting).
export const MODEL_TIERS = deepFreeze({
  claude: {
    deep: 'claude-opus-4-8',
    default: 'claude-opus-4-8',
    cheap: 'claude-haiku-4-5-20251001'
  },
  codex: {
    deep: { model: 'gpt-5.5', effort: 'xhigh' },
    default: { model: 'gpt-5.3-codex-spark', effort: 'high' },
    review: { model: 'codex-auto-review', effort: 'high' },
    cheap: { model: 'gpt-5.4-mini', effort: 'minimal' }
  },
  grok: {
    deepCreative: { model: 'grok-build', effort: 'xhigh', bestOfN: 3 },
    default: { model: 'grok-build', effort: 'high' },
    cheap: { model: 'grok-composer-2.5-fast', effort: 'low' }
  }
});

// Routing table: direction -> taskClass -> {model, effort?, bestOfN?}.
// effort is omitted for claude rows — claude has no --effort flag.
export const ROUTING_TABLE = deepFreeze({
  'claude-to-grok': {
    imagine: { model: 'grok-build', effort: 'high' },
    'creative-review': { model: 'grok-build', effort: 'xhigh', bestOfN: 3 },
    task: { model: 'grok-build', effort: 'medium' },
    health: { model: 'grok-composer-2.5-fast', effort: 'low' }
  },
  'claude-to-codex': {
    implement: { model: 'gpt-5.3-codex-spark', effort: 'high' },
    review: { model: 'codex-auto-review', effort: 'high' },
    verify: { model: 'gpt-5.3-codex-spark', effort: 'high' },
    health: { model: 'gpt-5.4-mini', effort: 'minimal' }
  },
  'grok-to-claude': {
    architecture: { model: 'claude-opus-4-8' },
    'second-opinion': { model: 'claude-opus-4-8' },
    'data-model': { model: 'claude-opus-4-8' },
    'security-review': { model: 'claude-opus-4-8' },
    summarize: { model: 'claude-haiku-4-5-20251001' },
    health: { model: 'claude-haiku-4-5-20251001' }
  },
  'grok-to-codex': {
    implement: { model: 'gpt-5.3-codex-spark', effort: 'high' },
    review: { model: 'codex-auto-review', effort: 'high' },
    verify: { model: 'gpt-5.3-codex-spark', effort: 'high' },
    health: { model: 'gpt-5.4-mini', effort: 'minimal' }
  },
  'codex-to-claude': {
    'second-opinion': { model: 'claude-opus-4-8' },
    reasoning: { model: 'claude-opus-4-8' },
    architecture: { model: 'claude-opus-4-8' },
    'security-review': { model: 'claude-opus-4-8' },
    health: { model: 'claude-haiku-4-5-20251001' }
  },
  'codex-to-grok': {
    imagine: { model: 'grok-build', effort: 'high' },
    assets: { model: 'grok-build', effort: 'high' },
    'creative-review': { model: 'grok-build', effort: 'xhigh', bestOfN: 3 },
    task: { model: 'grok-build', effort: 'medium' },
    draft: { model: 'grok-composer-2.5-fast', effort: 'medium' },
    health: { model: 'grok-composer-2.5-fast', effort: 'low' }
  }
});

const GENERIC_TASK_CLASS = deepFreeze({ grok: 'task', claude: 'second-opinion', codex: 'implement' });
const MECHANICAL_TASK_CLASSES = new Set(['verify', 'summarize', 'draft', 'health']);
const RISK_KEYWORDS = [
  'security', 'auth', 'payment', 'credential', 'secret', 'data-loss', 'migration', 'destructive', 'production'
];

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
function packetModelOf(packet) {
  if (!packet || packet.model == null) return null;
  if (typeof packet.model === 'string') return packet.model.trim() || null;
  if (typeof packet.model === 'object') return packet.model.id || packet.model.name || packet.model.model || null;
  return null;
}
function packetEffortOf(packet) {
  if (!packet || !nonEmptyString(packet.effort)) return null;
  return packet.effort.trim();
}
function packetBestOfNOf(packet) {
  if (!packet || packet.best_of_n == null) return null;
  const n = Number(packet.best_of_n);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}
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
function keywordHit(packet) {
  const haystack = `${packet?.objective || ''} ${packet?.constraints || ''}`;
  if (!haystack.trim()) return false;
  // Stem/prefix match (word-start anchored, trailing word-chars allowed) so a
  // keyword also matches its morphological family: credential(s), secret(s),
  // auth(entication|orization), migration(s), etc. Escalation only ever
  // upgrades the model tier, so mild over-matching here is safe and
  // preferred over missing a real security phrasing.
  return RISK_KEYWORDS.some((kw) => new RegExp(`\\b${kw}\\w*`, 'i').test(haystack));
}
function escalationReason(attempt, packet) {
  if (attempt >= 2) return 'retry';
  if (packet?.budget?.cost === 'high') return 'packet';
  if (packet?.escalate === true) return 'packet';
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
function applyEscalation({ agent, taskClass, packet, attempt, model, effort, bestOfN }) {
  if (taskClass === 'security-review' || MECHANICAL_TASK_CLASSES.has(taskClass)) {
    return { model, effort, bestOfN, escalated: false };
  }
  const costLow = packet?.budget?.cost === 'low';
  const escalateSignal = packet?.escalate === true || packet?.budget?.cost === 'high' || keywordHit(packet) || attempt >= 2;
  if (packet?.escalate === true) return escalateToDeep(agent, bestOfN, escalationReason(attempt, packet));
  if (costLow) return pinCheap(agent);
  if (escalateSignal) return escalateToDeep(agent, bestOfN, escalationReason(attempt, packet));
  return { model, effort, bestOfN, escalated: false };
}

function buildArgs(agent, model, effort, bestOfN) {
  if (!agent || !model) return [];
  if (agent === 'claude') return ['--model', model];
  if (agent === 'codex') {
    const args = ['-m', model];
    if (effort != null) args.push('-c', `model_reasoning_effort=${effort}`);
    return args;
  }
  if (agent === 'grok') {
    const args = ['--model', model];
    if (effort != null) args.push('--effort', effort);
    if (bestOfN) args.push('--best-of-n', String(bestOfN));
    return args;
  }
  return [];
}

// Resolve the model/effort/bestOfN/args for one hop of the mesh. Precedence:
// explicitModel > packet.model > env var > routing table > none. Escalation
// and cost caps apply only to the table source. Returns a frozen object.
export function resolveModel({
  direction,
  taskClass,
  packet = null,
  explicitModel = null,
  explicitEffort = null,
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
      agent, taskClass, packet, attempt,
      model: tableRow.model, effort: tableRow.effort ?? null, bestOfN: tableRow.bestOfN ?? null
    }));
  } else {
    const pModel = packetModelOf(packet);
    if (nonEmptyString(pModel)) {
      model = pModel;
      effort = packetEffortOf(packet) ?? tableRow?.effort ?? null;
      bestOfN = packetBestOfNOf(packet);
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
          agent, taskClass, packet, attempt,
          model: tableRow.model, effort: tableRow.effort ?? null, bestOfN: tableRow.bestOfN ?? null
        }));
      }
    }
  }
  // [1m] context suffix — claude agent only, applies regardless of source.
  const contextTriggered = agent === 'claude' && (contextChars > 600000 || packet?.budget?.context === '1m');
  if (contextTriggered && model) {
    if (model === 'claude-haiku-4-5-20251001') model = 'claude-opus-4-8[1m]';
    else if (!model.endsWith('[1m]')) model = `${model}[1m]`;
    if (!escalated) escalated = 'context';
  }

  return Object.freeze({
    agent,
    model,
    effort,
    bestOfN: bestOfN ?? null,
    args: buildArgs(agent, model, effort, bestOfN),
    source,
    escalated,
    taskClass
  });
}
