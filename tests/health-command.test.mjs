import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const REPO_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

test('health command emits static Pantheon JSON without live handshakes', () => {
  const res = spawnSync(process.execPath, [
    'plugins/grok/scripts/grok-companion.mjs',
    'health',
    '--json'
  ], {
    cwd: REPO_ROOT,
    encoding: 'utf8'
  });

  assert.equal(res.status, 0, res.stderr || res.stdout);
  const parsed = JSON.parse(res.stdout);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.pantheon.maxHops >= 1, true);
  assert.ok(parsed.legs['grok-to-claude']);
  assert.deepEqual(parsed.live, {});
});
