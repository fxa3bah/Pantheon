// Pantheon handoff packet helpers.
//
// Existing bridge callers pass a plain prompt string. Pantheon packets are an
// additive opt-in shape: only JSON objects with pantheon_packet: true are parsed
// as structured handoffs. Everything else remains a normal prompt.

const REQUIRED_PACKET_FIELDS = ['from', 'to', 'lane', 'objective'];

export function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function normalizeText(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value.trim();
  return JSON.stringify(value, null, 2);
}

function section(title, value) {
  const text = normalizeText(value);
  return text ? [title, text, ''] : [];
}

const DEFAULT_DO_NOT = 'No preamble. No sycophancy. Do not restate the objective. Do not pad.';
const RETURN_CONTRACT = [
  'Return exactly these fields, nothing else:',
  'status: done | blocked',
  'result: the answer',
  'files: paths or none',
  'blocker: one line or none',
  'Stop when the objective is met or blocked. Do not narrate tool use.'
].join('\n');

export function formatHandoffPrompt(packet, media = []) {
  const lines = [
    `Handoff: ${packet.from} → ${packet.to} [${packet.lane}]`,
    '',
    ...section('Objective', packet.objective),
    ...section('Context', packet.context),
    ...section('Constraints', packet.constraints),
    ...section('Permissions', packet.permissions),
    ...section('Budget', packet.budget),
    ...section('Success', packet.success_criteria || packet.success),
    ...section('Do not', packet.do_not || packet.avoid || DEFAULT_DO_NOT),
    ...section('Provenance', packet.provenance)
  ];
  if (media.length) {
    lines.push(
      'Media',
      ...media.map(item => `- ${item.path}${item.type ? ` (${item.type})` : ''}${item.label ? ` — ${item.label}` : ''}`),
      ''
    );
  }
  const ret = normalizeText(packet.return_format);
  lines.push(ret ? `Return format\n${ret}\n\n${RETURN_CONTRACT}` : RETURN_CONTRACT);
  return lines.join('\n').trim();
}

function normalizeMedia(media) {
  if (!Array.isArray(media)) return [];
  return media
    .filter(item => item && typeof item === 'object')
    .map(item => ({
      path: item.path || item.url || '',
      type: item.type || item.kind || '',
      label: item.label || item.name || ''
    }))
    .filter(item => item.path);
}

export function parsePantheonInput(rawInput) {
  const raw = String(rawInput ?? '').trim();
  if (!raw) {
    return { isPacket: false, prompt: '', packet: null, media: [] };
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { isPacket: false, prompt: raw, packet: null, media: [] };
  }

  if (!parsed || typeof parsed !== 'object' || parsed.pantheon_packet !== true) {
    return { isPacket: false, prompt: raw, packet: null, media: [] };
  }

  const missing = REQUIRED_PACKET_FIELDS.filter(field => !nonEmptyString(parsed[field]));
  if (missing.length) {
    throw new Error(`Invalid Pantheon packet: missing required field(s): ${missing.join(', ')}`);
  }

  const media = normalizeMedia(parsed.media);
  return {
    isPacket: true,
    prompt: formatHandoffPrompt(parsed, media),
    packet: parsed,
    media
  };
}

export function packetMaxTurns(packet) {
  if (!packet) return null;
  const n = Number(packet.max_turns ?? packet.budget?.max_turns);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

export function packetModel(packet) {
  if (!packet || packet.model == null) return null;
  if (typeof packet.model === 'string') return packet.model.trim() || null;
  if (typeof packet.model === 'object') {
    return packet.model.id || packet.model.name || packet.model.model || null;
  }
  return null;
}

export function packetEffort(packet) {
  if (!packet || packet.effort == null) return null;
  return typeof packet.effort === 'string' ? (packet.effort.trim() || null) : null;
}

export function packetBestOfN(packet) {
  if (!packet || packet.best_of_n == null) return null;
  const n = Number(packet.best_of_n);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

export function packetJobFields(parsedInput) {
  if (!parsedInput?.isPacket) return {};
  return {
    pantheon_packet: true,
    pantheon: {
      from: parsedInput.packet.from,
      to: parsedInput.packet.to,
      lane: parsedInput.packet.lane,
      objective: parsedInput.packet.objective,
      provenance: parsedInput.packet.provenance || null,
      model: packetModel(parsedInput.packet),
      effort: packetEffort(parsedInput.packet),
      escalate: parsedInput.packet.escalate === true ? true : null,
      max_turns: packetMaxTurns(parsedInput.packet),
      media: parsedInput.media
    }
  };
}
