#!/usr/bin/env node
// Probe the installed CLIs and diff them against AGENT_CAPABILITIES.
//
// AGENT_CAPABILITIES is a hand-maintained record of what each local binary
// accepts. tests/cli-contract.test.mjs enforces that the routing tables stay
// inside it, but nothing in the test suite can notice when a CLI *itself*
// changes underneath us — which is exactly how the Grok 4.5 update retired
// `grok-composer-2.5-fast` and `--best-of-n` without a single test going red.
//
// This script is the other half: run it after a CLI update, before trusting
// the manifest. It spawns real binaries, so it is deliberately NOT part of
// `node --test` (slow, network-dependent, and it burns tokens on codex).
//
//   node plugins/grok/scripts/probe-cli-capabilities.mjs
//
// Exit 0 = manifest matches the installed CLIs. Exit 1 = drift (details above).
import { spawnSync } from 'node:child_process';
import { AGENT_CAPABILITIES } from './lib/model-routing.mjs';

const run = (bin, args) => {
  const r = spawnSync(bin, args, { encoding: 'utf8', timeout: 60_000 });
  return { ok: r.status === 0, out: `${r.stdout || ''}${r.stderr || ''}`, err: r.error };
};

const drift = [];
const note = (msg) => { drift.push(msg); console.log(`  DRIFT  ${msg}`); };
const good = (msg) => console.log(`  ok     ${msg}`);

// ---- grok -----------------------------------------------------------------
console.log('grok:');
const grokModels = run('grok', ['models']);
if (grokModels.err) {
  console.log('  skip   grok not on PATH');
} else {
  for (const m of AGENT_CAPABILITIES.grok.models) {
    if (grokModels.out.includes(m)) good(`model ${m} is listed`);
    else note(`manifest claims grok model "${m}" but \`grok models\` does not list it`);
  }
  // Anything grok offers that we don't route to is worth knowing about too.
  for (const line of grokModels.out.split('\n')) {
    const m = line.match(/^\s*\*?\s*([a-z0-9][\w.-]+)\s*(\(default\))?\s*$/i);
    if (m && !AGENT_CAPABILITIES.grok.models.includes(m[1]) && !/available|logged/i.test(line)) {
      console.log(`  info   grok offers "${m[1]}" which the manifest does not list`);
    }
  }
  const grokHelp = run('grok', ['--help']);
  if (grokHelp.out.includes('--best-of-n')) {
    note('grok CLI now HAS --best-of-n; buildArgs() could emit it again');
  } else {
    good('no --best-of-n flag (buildArgs correctly omits it)');
  }
  const effortLine = grokHelp.out.match(/reasoning-effort[\s\S]{0,200}/i)?.[0] ?? '';
  for (const e of AGENT_CAPABILITIES.grok.efforts) {
    const probe = run('grok', ['-m', AGENT_CAPABILITIES.grok.models[0], '--effort', e, '--help']);
    if (/unknown effort level/i.test(probe.out)) note(`grok rejects effort "${e}"`);
    else good(`effort ${e} accepted`);
  }
  if (/xhigh/.test(effortLine)) note('grok help mentions xhigh — manifest excludes it');
}

// ---- codex ----------------------------------------------------------------
console.log('codex:');
const codexHelp = run('codex', ['exec', '--help']);
if (codexHelp.err) {
  console.log('  skip   codex not on PATH');
} else {
  good('codex exec reachable');
  console.log('  info   model slugs and effort levels are only verifiable by a real run;');
  console.log('         `codex exec -m <slug> -c model_reasoning_effort=<e> "reply OK"` is the check.');
  console.log('         Note: effort "minimal" 400s while web_search is enabled — kept out of the manifest.');
}

// ---- claude ---------------------------------------------------------------
console.log('claude:');
const claudeHelp = run('claude', ['--help']);
if (claudeHelp.err) {
  console.log('  skip   claude not on PATH');
} else {
  const hasEffort = /--effort/.test(claudeHelp.out);
  const manifestHasEffort = Array.isArray(AGENT_CAPABILITIES.claude.efforts);
  if (hasEffort !== manifestHasEffort) {
    note(`claude --effort present=${hasEffort} but manifest efforts=${JSON.stringify(AGENT_CAPABILITIES.claude.efforts)}`);
  } else {
    good(`--effort presence matches the manifest (present=${hasEffort}; Pantheon does not route it)`);
  }
  for (const m of AGENT_CAPABILITIES.claude.models) {
    // `--help` does not enumerate models; a bad slug only fails at run time.
    console.log(`  info   model ${m} not verifiable from --help; confirm with a real \`claude --model ${m} -p ok\``);
  }
}

console.log('');
if (drift.length) {
  console.log(`${drift.length} drift item(s) — update AGENT_CAPABILITIES in lib/model-routing.mjs.`);
  process.exit(1);
}
console.log('No drift: AGENT_CAPABILITIES matches the installed CLIs.');
