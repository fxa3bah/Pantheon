// Pantheon handoff packet helpers.
//
// Existing bridge callers pass a plain prompt string. Pantheon packets are an
// additive opt-in shape: only JSON objects with pantheon_packet: true are parsed
// as structured handoffs. Everything else remains a normal prompt.

const REQUIRED_PACKET_FIELDS = ['from', 'to', 'lane', 'objective'];

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function normalizeText(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value.trim();
  return JSON.stringify(value, null, 2);
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
  const prompt = [
    'Pantheon handoff packet.',
    `From: ${parsed.from}`,
    `To: ${parsed.to}`,
    `Lane: ${parsed.lane}`,
    '',
    'Objective:',
    normalizeText(parsed.objective),
    '',
    'Context:',
    normalizeText(parsed.context) || '(none provided)',
    '',
    'Constraints:',
    normalizeText(parsed.constraints) || '(none provided)',
    '',
    'Permissions:',
    normalizeText(parsed.permissions) || '(unspecified; default to read-only unless explicitly allowed)',
    '',
    'Budget:',
    normalizeText(parsed.budget) || '(unspecified)',
    '',
    'Return format:',
    normalizeText(parsed.return_format) || '(clear concise result with provenance)',
    '',
    'Provenance:',
    normalizeText(parsed.provenance) || '(none provided)',
    media.length
      ? [
          '',
          'Media:',
          ...media.map(item => `- ${item.path}${item.type ? ` (${item.type})` : ''}${item.label ? ` - ${item.label}` : ''}`)
        ].join('\n')
      : '',
    '',
    'via Pantheon.'
  ].filter(Boolean).join('\n');

  return { isPacket: true, prompt, packet: parsed, media };
}

export function packetModel(packet) {
  if (!packet || packet.model == null) return null;
  if (typeof packet.model === 'string') return packet.model.trim() || null;
  if (typeof packet.model === 'object') {
    return packet.model.id || packet.model.name || packet.model.model || null;
  }
  return null;
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
      media: parsedInput.media
    }
  };
}
