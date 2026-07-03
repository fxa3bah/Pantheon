// Guards against the class of bug where a companion USES a helper from a lib
// module without importing it. `node --check` passes on such code (valid
// syntax) and the failure only surfaces at runtime on the live path — exactly
// how the grok-companion `withCompliance is not defined` regression shipped.
//
// For each companion, any bare `symbol(` call to a known shared lib export must
// be backed by an `import { symbol } from './lib/...'`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'plugins', 'grok', 'scripts');
const COMPANIONS = ['claude-companion.mjs', 'grok-companion.mjs', 'codex-companion.mjs'];

// Shared lib exports the companions call by bare name. If a file uses one, it
// must import it. Extend this list as new shared helpers are introduced.
const SHARED_SYMBOLS = [
  'withCompliance', 'resolveModel', 'classifyTask', 'parsePantheonInput',
  'packetJobFields', 'upsertJob', 'assertHopAllowed', 'sanitizeClaudeArgs',
  'sanitizeCodexArgs', 'childEnv', 'armTimeout', 'startHeartbeat'
];

for (const file of COMPANIONS) {
  test(`${file}: every used shared lib symbol is imported`, () => {
    const src = fs.readFileSync(path.join(scriptsDir, file), 'utf8');
    const importSection = src.slice(0, src.indexOf('\n\n', src.lastIndexOf('\nimport ')) + 1);
    for (const sym of SHARED_SYMBOLS) {
      const used = new RegExp(`\\b${sym}\\s*\\(`).test(src);
      if (!used) continue;
      const imported = new RegExp(`import\\s*\\{[^}]*\\b${sym}\\b[^}]*\\}\\s*from`).test(src);
      assert.ok(imported, `${file} calls ${sym}() but never imports it (used-but-not-imported bug)`);
    }
  });
}

test('all three companions inject the compliance header', () => {
  for (const file of COMPANIONS) {
    const src = fs.readFileSync(path.join(scriptsDir, file), 'utf8');
    assert.match(src, /withCompliance\(/, `${file} should call withCompliance() on the delegated prompt`);
    assert.match(src, /from '\.\/lib\/compliance\.mjs'/, `${file} should import from compliance.mjs`);
  }
});
