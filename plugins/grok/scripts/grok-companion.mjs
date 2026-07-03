#!/usr/bin/env node
/**
 * grok-companion.mjs
 * Thin Pantheon companion for the Claude Code side of Pantheon.
 * Shells the local authenticated `grok` binary (headless) for /grok-imagine and /grok-review.
 * No API keys — only uses the already-logged-in local Grok CLI.
 *
 * Subcommands (called by the .md command frontmatter + Bash):
 *   setup
 *   imagine <request...>
 *   review <request...>
 *   task <request...>   (used by the grok-delegate subagent)
 *   status [job-id]
 *   result [job-id]
 *   cancel [job-id]
 */

import { spawn, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { assertHopAllowed, childEnv, armTimeout, startHeartbeat, currentHop, MAX_HOPS, writesAllowed } from './lib/bridge-guard.mjs';
import { upsertJob, readJob, listJobs } from './lib/state.mjs';
import { parsePantheonInput, packetJobFields } from './lib/pantheon-packet.mjs';
import { resolveModel, classifyTask, MODEL_TIERS, ROUTING_TABLE } from './lib/model-routing.mjs';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const PLUGIN_ROOT = path.resolve(ROOT, '..'); // plugins/grok
// Job ledger lives in cwd/.grok-bridge (managed by lib/state.mjs).
const MEDIA_ROOT = process.env.GROK_BRIDGE_MEDIA_DIR || path.join(process.env.HOME || process.env.USERPROFILE || '', 'Pictures', 'grok-imagine');

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function generateJobId() {
  return 'grok-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
}

function spawnSyncSafe(cmd, args, opts = {}) {
  try {
    return spawnSync(cmd, args, opts);
  } catch {
    return { status: 1, stdout: '', stderr: '' };
  }
}

function resolveGrokBinary() {
  // 1. PATH
  const which = process.platform === 'win32' ? 'where' : 'which';
  try {
    const res = spawnSyncSafe(which, ['grok'], { encoding: 'utf8' });
    if (res.status === 0 && res.stdout && res.stdout.trim()) {
      return res.stdout.trim().split(/\r?\n/)[0];
    }
  } catch {}

  // 2. ~/.grok/bin/grok (standard in this environment)
  const homeGrok = path.join(process.env.HOME || process.env.USERPROFILE || '', '.grok', 'bin', 'grok');
  if (fs.existsSync(homeGrok)) return homeGrok;

  // 3. Latest download (common in this setup)
  const downloads = path.join(process.env.HOME || '', '.grok', 'downloads');
  if (fs.existsSync(downloads)) {
    const files = fs.readdirSync(downloads)
      .filter(f => f.startsWith('grok-') && !f.endsWith('.tmp'))
      .sort()
      .reverse();
    if (files.length) return path.join(downloads, files[0]);
  }

  return null;
}

function resolveBinary(name, fallbacks = []) {
  const which = process.platform === 'win32' ? 'where' : 'which';
  const res = spawnSyncSafe(which, [name], { encoding: 'utf8' });
  if (res.status === 0 && res.stdout && res.stdout.trim()) {
    return res.stdout.trim().split(/\r?\n/)[0];
  }
  for (const candidate of fallbacks) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function resolvePreferredBinary(name, preferred = [], fallbacks = []) {
  for (const candidate of preferred) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  return resolveBinary(name, fallbacks);
}

function versionOf(bin, args = ['--version']) {
  if (!bin) return { ok: false, error: 'not found' };
  const res = spawnSyncSafe(bin, args, { encoding: 'utf8', timeout: 15000 });
  return {
    ok: res.status === 0,
    status: res.status,
    text: (res.stdout || res.stderr || '').trim()
  };
}

// Resolves the direction for a packet-bearing (or plain) request, validated
// against ROUTING_TABLE, falling back to this leg's legacy default direction.
function directionFor(packet, fallback = 'claude-to-grok') {
  if (packet && ROUTING_TABLE[`${packet.from}-to-${packet.to}`]) return `${packet.from}-to-${packet.to}`;
  return fallback;
}

// Bundles the ledger-facing fields for a resolveModel() result so every
// saveJob call carries the same routing shape.
function routingFieldsFor(routed) {
  return {
    model: routed.model,
    effort: routed.effort ?? null,
    bestOfN: routed.bestOfN ?? null,
    routing: { taskClass: routed.taskClass, source: routed.source, escalated: routed.escalated }
  };
}

async function runGrokHeadless(prompt, { extraArgs = [], jobId, label = 'Grok' } = {}) {
  const grokBin = resolveGrokBinary();
  if (!grokBin) {
    console.error('ERROR: Could not find local authenticated grok binary.\nRun "grok login" (or the equivalent) in your terminal, then try again. The bridge only uses the already-logged-in local CLI — no API keys.');
    process.exit(1);
  }

  // Loop guard: refuse if we've already crossed the bridge too many times.
  assertHopAllowed('hand off to Grok');

  const args = [
    '-p', withCompliance('grok', prompt),
    '--always-approve',
    '--output-format', 'json',
    '--cwd', process.cwd(),
    ...extraArgs
  ];

  return new Promise((resolve, reject) => {
    const child = spawn(grokBin, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: childEnv()
    });
    if (jobId) upsertJob(jobId, { pid: child.pid, status: 'running', hop: currentHop() });
    const stopBeat = startHeartbeat(label);
    armTimeout(child, reject);

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });

    child.on('close', (code) => {
      stopBeat();
      if (code === 0) {
        resolve({ stdout: stdout.trim(), stderr: stderr.trim(), code });
      } else {
        if (jobId) upsertJob(jobId, { status: 'failed', exitCode: code });
        reject(new Error(`grok exited ${code}\nstdout: ${stdout}\nstderr: ${stderr}`));
      }
    });

    child.on('error', (err) => { stopBeat(); reject(err); });
  });
}

// Best-effort cost/usage extraction from a parsed headless JSON object.
function extractCost(parsed) {
  if (!parsed || typeof parsed !== 'object') return null;
  return parsed.total_cost_usd ?? parsed.cost_usd ?? parsed.cost ?? parsed.usage?.cost_usd ?? null;
}

// Job persistence is delegated to the shared ledger (lib/state.mjs) so both
// directions of the bridge write one consistent schema.
const saveJob = (jobId, direction, data) => upsertJob(jobId, { direction, ...data });
const loadJob = (jobId) => readJob(jobId);
const listRecentJobs = (limit = 5) => listJobs(limit);

const MEDIA_EXT = 'jpg|jpeg|png|webp|gif|mp4|mov';

// Robustly extract generated asset paths from Grok's decoded output. Grok is
// inconsistent about emitting BRIDGE_MEDIA lines, so we also harvest file://
// links and bare session paths. Grok url-encodes the cwd into a single literal
// directory name (…/sessions/%2Fprivate%2F…/), so file:// remainders are used
// AS-IS rather than URL-decoded (decoding %2F→/ would break the path).
// Strip any file:// prefix and collapse repeated leading slashes so the same
// asset captured via different signals normalizes to one canonical path.
function normMediaPath(p) {
  return p.replace(/^file:\/\//i, '').replace(/^\/{2,}/, '/').trim();
}

function extractMediaPaths(text) {
  if (!text) return [];
  const found = new Set();
  // Cut a candidate at its first media extension so trailing markdown/punctuation
  // (e.g. "1.jpg**", "1.jpg)") never leaks into the path.
  const reCut = new RegExp(`^/[\\s\\S]*?\\.(?:${MEDIA_EXT})`, 'i');
  const add = (p) => {
    const cut = normMediaPath(p).match(reCut);
    if (cut) found.add(cut[0]);
  };

  // 1. Explicit BRIDGE_MEDIA: lines (preferred when present).
  for (const m of text.matchAll(/BRIDGE_MEDIA:\s*(\S[^\n\r]*?)\s*$/gm)) add(m[1]);
  // 2. file:// links (markdown embeds) — remainder kept literal (no URL-decode).
  for (const m of text.matchAll(new RegExp(`file://(/[^\\s'")\\]]+?\\.(?:${MEDIA_EXT}))`, 'gi'))) add(m[1]);
  // 3. Bare absolute Grok session paths mentioned anywhere ("saved to: …").
  for (const m of text.matchAll(new RegExp(`/[^\\s'")\\]]*\\.grok/sessions/[^\\s'")\\]]+?\\.(?:${MEDIA_EXT})`, 'gi'))) add(m[0]);

  return [...found];
}

async function cmdSetup(args) {
  const asJson = args.includes('--json');
  const grokBin = resolveGrokBinary();

  if (!grokBin) {
    const msg = 'No local grok binary found. Install / login Grok Build on this machine (normal OAuth).';
    if (asJson) console.log(JSON.stringify({ ok: false, error: msg }));
    else console.error(msg);
    process.exit(1);
  }

  // Quick smoke — trivial prompt
  try {
    const { stdout } = await runGrokHeadless('Reply with exactly: PANTHEON-BRIDGE-OK', { extraArgs: ['--max-turns', '1'], label: 'Grok setup' });
    const ok = stdout.includes('PANTHEON-BRIDGE-OK') || stdout.includes('PANTHEON-BRIDGE');
    const result = {
      ok,
      binary: grokBin,
      message: ok ? 'Grok Build reachable via local authenticated CLI (OAuth). No API key used.' : 'Binary found but smoke response unexpected.'
    };
    if (asJson) console.log(JSON.stringify(result, null, 2));
    else console.log(result.message + '\nBinary: ' + grokBin);
  } catch (e) {
    const result = { ok: false, binary: grokBin, error: String(e.message || e) };
    if (asJson) console.log(JSON.stringify(result, null, 2));
    else console.error('Smoke failed:', result.error);
    process.exit(1);
  }
}

async function cmdImagine(rawArgs) {
  const parsedInput = parsePantheonInput(rawArgs);
  const requestText = parsedInput.prompt || rawArgs;
  // rawArgs is the full user request string (including any --background etc. — companion receives the cleaned version from the .md)
  const prompt = [
    'You are Grok. The user has handed off a visual task via Pantheon.',
    'Use your Imagine superpower (image_gen, image_edit, image_to_video, reference_to_video, reference consistency, ffmpeg assembly, etc.) exactly as described in your imagine skill.',
    'User request (preserve intent exactly):',
    requestText,
    '',
    'Materialize all final images and short videos.',
    'For EVERY asset you generate or edit, print a machine-parseable line exactly in this format (one per file, use the actual absolute path the file was saved to by the harness):',
    'BRIDGE_MEDIA: /absolute/path/to/the/file.ext',
    'Also return clear ready-to-paste markdown embeds in your final text.',
    'If references are mentioned by path or "previous", use them.'
  ].join('\n');

  const direction = directionFor(parsedInput.packet);
  const taskClass = classifyTask(direction, 'imagine', parsedInput.packet);
  const routed = resolveModel({ direction, taskClass, packet: parsedInput.packet, contextChars: prompt.length });
  const routingFields = routingFieldsFor(routed);

  const jobId = generateJobId();
  const date = new Date().toISOString().slice(0, 10);
  const galleryDir = path.join(MEDIA_ROOT, date, jobId);
  ensureDir(galleryDir);

  console.log(`[pantheon] Starting imagine job ${jobId}... (gallery: ${galleryDir})`);
  saveJob(jobId, direction, { type: 'imagine', request: rawArgs, status: 'running', gallery: galleryDir, ...routingFields, ...packetJobFields(parsedInput) });

  try {
    const { stdout } = await runGrokHeadless(prompt, { jobId, label: 'Grok Imagine', extraArgs: routed.args });

    // Decode JSON first: headless grok returns {text, thought, ...}. Asset paths
    // can appear in either field with REAL newlines; parsing the raw JSON string
    // instead mashes paths together with escaped \n and breaks existsSync.
    let cleanText = stdout;
    let searchText = stdout;
    try {
      const parsed = JSON.parse(stdout);
      if (parsed.text) cleanText = parsed.text;
      else if (parsed.result) cleanText = parsed.result;
      // Harvest media from both the final text and the reasoning trace.
      searchText = [parsed.text, parsed.thought, parsed.result].filter(Boolean).join('\n');
    } catch {}

    // Extract asset paths from multiple signals (BRIDGE_MEDIA + file:// + session paths).
    let media = extractMediaPaths(searchText);

    // Last-resort fallback: recent files in cwd (older Grok behavior).
    if (media.length === 0) {
      media = findRecentMedia(process.cwd(), 120);
    }

    // Copy to gallery with deterministic names and collect final paths + links
    const finalMedia = [];
    media.forEach((src, idx) => {
      if (!fs.existsSync(src)) return;
      const ext = path.extname(src) || '.bin';
      const dest = path.join(galleryDir, `${jobId}-${idx}${ext}`);
      try {
        fs.copyFileSync(src, dest);
        finalMedia.push(dest);
      } catch (e) {
        console.error('Failed to copy media', src, e.message);
      }
    });

    let cost = null;
    try { cost = extractCost(JSON.parse(stdout)); } catch {}
    saveJob(jobId, direction, {
      type: 'imagine',
      request: rawArgs,
      output: stdout,
      media: finalMedia,
      gallery: galleryDir,
      cost,
      ...routingFields,
      ...packetJobFields(parsedInput),
      status: 'complete'
    });

    console.log(cleanText);

    if (finalMedia.length) {
      console.log('\n[pantheon] Generated media (copied to gallery — clickable file:// links + markdown):');
      finalMedia.forEach(p => {
        // pathToFileURL percent-encodes correctly (spaces, %, etc.) so the link
        // actually resolves when clicked. Gallery paths are clean (no %2F).
        const fileUri = pathToFileURL(p).href;
        const md = `![${path.basename(p)}](${fileUri})`;
        console.log(`  ${fileUri}`);
        console.log(`  ${md}`);
      });
    } else {
      console.log('\n[pantheon] No media files were captured/copied. Grok may not have emitted BRIDGE_MEDIA lines; check /grok:result ' + jobId + ' --json.');
    }

    if (cost != null) console.log(`[pantheon] cost: $${Number(cost).toFixed(4)}`);
    console.log(`\n[pantheon] Job ${jobId} complete. Gallery: ${galleryDir}`);
    console.log(`Use /grok:result ${jobId} (or --json) later if needed.`);
  } catch (e) {
    saveJob(jobId, direction, { status: 'failed', error: e.message });
    console.error('Imagine job failed:', e.message);
    process.exit(1);
  }
}

async function cmdReview(rawArgs) {
  const parsedInput = parsePantheonInput(rawArgs);
  const requestText = parsedInput.prompt || rawArgs;
  const prompt = [
    'You are Grok. Perform the following review/investigation using multiple agents and perspectives.',
    'At minimum use: reviewer, explorer/critic, security/reliability, implementer (or similar).',
    'You may spawn subagents or run best-of-n internally.',
    'Synthesize one clear, prioritized report with concrete findings and recommendations.',
    'User request / focus:',
    requestText
  ].join('\n');

  const direction = directionFor(parsedInput.packet);
  const taskClass = classifyTask(direction, 'review', parsedInput.packet);
  const routed = resolveModel({ direction, taskClass, packet: parsedInput.packet, contextChars: prompt.length });
  const routingFields = routingFieldsFor(routed);

  const jobId = generateJobId();
  console.log(`[pantheon] Starting multi-agent review job ${jobId}...`);
  saveJob(jobId, direction, { type: 'review', request: rawArgs, status: 'running', ...routingFields, ...packetJobFields(parsedInput) });

  try {
    const { stdout } = await runGrokHeadless(prompt, { jobId, label: 'Grok review', extraArgs: routed.args });
    // Clean output: prefer .text
    let clean = stdout, cost = null;
    try { const p = JSON.parse(stdout); if (p.text) clean = p.text; cost = extractCost(p); } catch {}
    saveJob(jobId, direction, { type: 'review', request: rawArgs, output: stdout, cost, status: 'complete', ...routingFields, ...packetJobFields(parsedInput) });
    console.log(clean);
    if (cost != null) console.log(`[pantheon] cost: $${Number(cost).toFixed(4)}`);
    console.log(`\n[pantheon] Job ${jobId} complete.`);
  } catch (e) {
    saveJob(jobId, direction, { status: 'failed', error: e.message });
    console.error('Review job failed:', e.message);
    process.exit(1);
  }
}

async function cmdTask(rawArgs) {
  const parsedInput = parsePantheonInput(rawArgs);
  const requestText = parsedInput.prompt || rawArgs;
  // Generic delegation used by the subagent. The .md already added routing flags if needed.
  const direction = directionFor(parsedInput.packet);
  const taskClass = classifyTask(direction, 'task', parsedInput.packet);
  const routed = resolveModel({ direction, taskClass, packet: parsedInput.packet, contextChars: requestText.length });
  const routingFields = routingFieldsFor(routed);

  const jobId = generateJobId();
  console.log(`[pantheon] Starting delegated task ${jobId}...`);
  saveJob(jobId, direction, { type: 'task', request: rawArgs, status: 'running', ...routingFields, ...packetJobFields(parsedInput) });
  try {
    const { stdout } = await runGrokHeadless(requestText, { jobId, label: 'Grok task', extraArgs: routed.args });
    let clean = stdout, cost = null;
    try { const p = JSON.parse(stdout); if (p.text) clean = p.text; cost = extractCost(p); } catch {}
    saveJob(jobId, direction, { type: 'task', request: rawArgs, output: stdout, cost, status: 'complete', ...routingFields, ...packetJobFields(parsedInput) });
    console.log(clean);
    if (cost != null) console.log(`[pantheon] cost: $${Number(cost).toFixed(4)}`);
  } catch (e) {
    saveJob(jobId, direction, { status: 'failed', error: e.message });
    console.error('Task failed:', e.message);
    process.exit(1);
  }
}

function runHealthHandshake(name, bin, args, expected) {
  if (!bin) return { ok: false, skipped: true, error: `${name} binary not found` };
  const res = spawnSyncSafe(bin, args, { encoding: 'utf8', timeout: 60000, cwd: process.cwd() });
  const text = `${res.stdout || ''}\n${res.stderr || ''}`.trim();
  return {
    ok: res.status === 0 && text.includes(expected),
    status: res.status,
    expected,
    text: text.slice(0, 1200)
  };
}

function cmdHealth(args) {
  const asJson = args.includes('--json');
  const live = args.includes('--live');
  const grokBin = resolveGrokBinary();
  const claudeBin = resolveBinary('claude', [
    path.join(process.env.HOME || '', '.local', 'bin', 'claude'),
    path.join(process.env.HOME || '', '.claude', 'bin', 'claude'),
    '/usr/local/bin/claude',
    '/opt/homebrew/bin/claude',
  ]);
  const codexBin = resolvePreferredBinary('codex', [
    process.env.CODEX_CLI_PATH,
    '/Applications/Codex.app/Contents/Resources/codex',
    path.join(process.env.HOME || '', '.nvm', 'versions', 'node', 'v24.13.0', 'bin', 'codex'),
  ], [
    path.join(process.env.HOME || '', '.local', 'bin', 'codex'),
    '/usr/local/bin/codex',
    '/opt/homebrew/bin/codex',
  ]);

  const report = {
    ok: true,
    timestamp: new Date().toISOString(),
    cwd: process.cwd(),
    pantheon: {
      hop: currentHop(),
      maxHops: MAX_HOPS,
      writesAllowed: writesAllowed(),
      claudeBareRequested: process.env.GROK_BRIDGE_CLAUDE_BARE === '1'
    },
    models: {
      grok: MODEL_TIERS.grok,
      claude: MODEL_TIERS.claude,
      codex: MODEL_TIERS.codex
    },
    binaries: {
      grok: { path: grokBin, version: versionOf(grokBin) },
      claude: { path: claudeBin, version: versionOf(claudeBin) },
      codex: { path: codexBin, version: versionOf(codexBin) }
    },
    legs: {
      'claude-to-grok': { configured: Boolean(grokBin), command: '/grok-imagine, /grok-review, /grok:setup' },
      'grok-to-claude': { configured: Boolean(claudeBin), command: 'claude-delegate via claude-companion.mjs' },
      'grok-to-codex': { configured: Boolean(codexBin), command: 'codex-delegate / codex companion' },
      'codex-to-grok': { configured: Boolean(grokBin), command: 'grok "..." or grok-delegate skill' },
      'codex-to-claude': { configured: Boolean(claudeBin), command: 'claude "..." or claude-delegate skill' },
      'claude-to-codex': { configured: Boolean(codexBin), command: 'codex "..." or Codex plugin' }
    },
    live: {}
  };

  if (live) {
    const claudeCompanion = path.join(ROOT, 'scripts', 'claude-companion.mjs');
    // Compute-challenge sentinels. The expected token embeds a number the model
    // must CALCULATE (6 * 7 = 42), so the echoed instruction can never contain
    // the answer. Only a genuine reply produces the matched string -- this
    // defeats the false-positive where a CLI that merely echoes the prompt (or
    // returns empty) would otherwise pass on the instruction text alone.
    const CHALLENGE = 'where N is the product of 6 and 7';
    const grokExpect = 'PANTHEON-GROK-42';
    const claudeExpect = 'PANTHEON-CLAUDE-42';
    const codexExpect = 'PANTHEON-CODEX-42';
    // Health-class routing for each handshake — pinned cheap/fast tiers via the
    // router (never a fresh model literal here).
    const grokHealthRouted = resolveModel({ direction: 'claude-to-grok', taskClass: 'health' });
    const claudeHealthRouted = resolveModel({ direction: 'grok-to-claude', taskClass: 'health' });
    const codexHealthRouted = resolveModel({ direction: 'claude-to-codex', taskClass: 'health' });
    const grokHandshake = [
      '-p', `Pantheon health check. Reply with exactly PANTHEON-GROK-N ${CHALLENGE}.`,
      '--output-format', 'json',
      '--cwd', process.cwd(),
      '--permission-mode', 'plan',
      '--max-turns', '2',
      '--no-subagents',
      '--disable-web-search',
      ...grokHealthRouted.args
    ];
    const claudeHandshake = [
      ...claudeHealthRouted.args,
      '-p', `Pantheon health check. Reply with exactly PANTHEON-CLAUDE-N ${CHALLENGE}.`,
      '--output-format', 'json',
      '--permission-mode', 'plan',
      '--allowedTools', 'Read,Glob,Grep',
      '--max-budget-usd', '0.75'
    ];
    const codexHandshake = [
      'exec',
      ...codexHealthRouted.args,
      '--sandbox', 'read-only',
      '--ephemeral',
      '--skip-git-repo-check',
      '-C', process.cwd(),
      `Pantheon health check. Reply with exactly PANTHEON-CODEX-N ${CHALLENGE}.`
    ];

    report.live['claude-to-grok'] = runHealthHandshake('claude-to-grok', grokBin, grokHandshake, grokExpect);
    report.live['grok-to-claude'] = runHealthHandshake('grok-to-claude', process.execPath, [
      claudeCompanion,
      `Pantheon health check. Reply with exactly PANTHEON-CLAUDE-N ${CHALLENGE}.`,
      '--max-turns', '1'
    ], claudeExpect);
    report.live['grok-to-codex'] = runHealthHandshake('grok-to-codex', codexBin, codexHandshake, codexExpect);
    report.live['codex-to-grok'] = runHealthHandshake('codex-to-grok', grokBin, grokHandshake, grokExpect);
    report.live['codex-to-claude'] = runHealthHandshake('codex-to-claude', claudeBin, claudeHandshake, claudeExpect);
    report.live['claude-to-codex'] = runHealthHandshake('claude-to-codex', codexBin, codexHandshake, codexExpect);
    report.ok = Object.values(report.live).every(item => item.ok || item.skipped);
  }

  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log(`Pantheon health: ${report.ok ? 'ok' : 'attention needed'}`);
  console.log(`hop ${report.pantheon.hop}/${report.pantheon.maxHops}; writes ${report.pantheon.writesAllowed ? 'allowed' : 'read-only default'}`);
  for (const [name, info] of Object.entries(report.binaries)) {
    console.log(`${name}: ${info.path || 'not found'}${info.version?.text ? ` (${info.version.text})` : ''}`);
  }
  if (live) {
    for (const [name, result] of Object.entries(report.live)) {
      console.log(`${name} live: ${result.ok ? 'ok' : 'failed'}`);
    }
  } else {
    console.log('Run with --live for paid/read-only handshake checks.');
  }
}

function findRecentMedia(dir, seconds = 60) {
  const exts = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.mp4', '.mov'];
  const cutoff = Date.now() - seconds * 1000;
  const results = [];

  function walk(d) {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        if (['node_modules', '.git', '.grok-bridge'].includes(e.name)) continue;
        walk(p);
      } else if (exts.some(ext => e.name.toLowerCase().endsWith(ext))) {
        try {
          const st = fs.statSync(p);
          if (st.mtimeMs > cutoff) results.push(path.relative(dir, p));
        } catch {}
      }
    }
  }
  walk(dir);
  return results.slice(0, 20); // reasonable cap
}

function cmdStatus(args) {
  const asJson = args.includes('--json');
  const id = args.find(a => !a.startsWith('-'));
  if (id) {
    const job = loadJob(id);
    if (asJson) console.log(JSON.stringify(job || { error: 'not found' }, null, 2));
    else if (job) console.log(JSON.stringify(job, null, 2));
    else console.log('Job not found:', id);
    return;
  }
  const jobs = listRecentJobs(8);
  if (asJson) {
    console.log(JSON.stringify(jobs, null, 2));
  } else {
    if (!jobs.length) { console.log('No recent bridge jobs.'); return; }
    jobs.forEach(j => {
      const cost = j.cost != null ? ` $${Number(j.cost).toFixed(4)}` : '';
      const n = Array.isArray(j.media) ? ` ${j.media.length} media` : '';
      console.log(`${j.id}  [${j.status || '?'}] ${j.type || ''}${n}${cost}  ${j.updated || j.ts}`);
    });
  }
}

function cmdResult(args) {
  const asJson = args.includes('--json');
  const id = args.find(a => !a.startsWith('-')) || listRecentJobs(1)[0]?.id;
  if (!id) {
    console.log('No job id and no recent jobs.');
    return;
  }
  const job = loadJob(id);
  if (!job) {
    console.log('Job not found:', id);
    return;
  }
  if (asJson) {
    console.log(JSON.stringify(job, null, 2));
  } else {
    console.log(job.output || '(no text output stored)');
    if (job.media && job.media.length) {
      console.log('\nMedia:');
      job.media.forEach(m => console.log('  ' + m));
    }
  }
}

function cmdCancel(args) {
  const id = args.find(a => !a.startsWith('-')) || listRecentJobs(1)[0]?.id;
  if (!id) { console.log('No job id and no recent jobs to cancel.'); return; }
  const job = loadJob(id);
  if (!job) { console.log('Job not found:', id); return; }
  if (!job.pid) {
    console.log(`[pantheon] Job ${id} has no tracked PID (already finished or never spawned). Status: ${job.status || 'unknown'}.`);
    return;
  }
  try {
    process.kill(job.pid, 'SIGTERM');
    saveJob(id, job.direction, { status: 'cancelled' });
    console.log(`[pantheon] Sent SIGTERM to PID ${job.pid} for job ${id}. Marked cancelled.`);
  } catch (e) {
    // ESRCH = process already gone.
    const note = e.code === 'ESRCH' ? 'process already exited' : e.message;
    saveJob(id, job.direction, { status: 'cancelled' });
    console.log(`[pantheon] Could not signal PID ${job.pid} (${note}). Marked ${id} cancelled.`);
  }
}

async function main() {
  const [, , sub, ...rest] = process.argv;
  const raw = rest.join(' ').trim();

  switch (sub) {
    case 'setup': return cmdSetup(rest);
    case 'imagine': return cmdImagine(raw || 'a simple test image');
    case 'review': return cmdReview(raw || 'review the recent changes in this workspace');
    case 'task': return cmdTask(raw);
    case 'status': return cmdStatus(rest);
    case 'result': return cmdResult(rest);
    case 'cancel': return cmdCancel(rest);
    case 'health': return cmdHealth(rest);
    default:
      console.log('grok-companion (Pantheon bridge)');
      console.log('  setup | health [--json] [--live] | imagine <request> | review <request> | task <request> | status [id] | result [id] | cancel [id]');
      process.exit(1);
  }
}

// Only run when invoked directly (node grok-companion.mjs …), not on import —
// so the helpers above are unit-testable.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(e => {
    console.error(e);
    process.exit(1);
  });
}

export { extractMediaPaths };
