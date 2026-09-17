import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadHosts, sshArgv, remoteCommand, findHost } from '../plugins/grok/scripts/lib/host-bridge.mjs';

const SAMPLE = JSON.stringify({
  hosts: [
    { id: 'mini', local: true },
    { id: 'vps', ssh: 'faadi@vps', cwd: '/opt/pantheon', companion: 'plugins/grok/scripts/grok-companion.mjs' }
  ]
});

test('loadHosts reads {hosts:[]} and marks missing ssh as local', () => {
  const hosts = loadHosts('/tmp/hosts.json', { readFile: () => SAMPLE });
  assert.equal(hosts[0].local, true);
  assert.equal(hosts[1].local, false);
  assert.equal(hosts[1].ssh, 'faadi@vps');
});

test('missing hosts file is an empty inventory', () => {
  const hosts = loadHosts('/no/such/hosts.json', {
    readFile: () => { const e = new Error('no'); e.code = 'ENOENT'; throw e; }
  });
  assert.deepEqual(hosts, []);
});

test('sshArgv uses ControlMaster and BatchMode', () => {
  const host = loadHosts('/x', { readFile: () => SAMPLE })[1];
  const args = sshArgv(host, 'node grok-companion.mjs auto', { controlDir: '/tmp/pantheon-ssh' });
  assert.equal(args[0], '-o');
  assert.ok(args.includes('BatchMode=yes'));
  assert.ok(args.includes('ControlMaster=auto'));
  assert.ok(args.some((a) => String(a).startsWith('ControlPath=')));
  assert.equal(args.at(-2), 'faadi@vps');
});

test('remoteCommand quotes the packet so JSON stays one argv on the far side', () => {
  const host = loadHosts('/x', { readFile: () => SAMPLE })[1];
  const cmd = remoteCommand(host, 'auto', '{"pantheon_packet":true}');
  assert.match(cmd, /cd '\/opt\/pantheon'/);
  assert.match(cmd, /node 'plugins\/grok\/scripts\/grok-companion.mjs' auto '\{"pantheon_packet":true\}'/);
});

test('findHost returns null for unknown ids', () => {
  assert.equal(findHost('nope', '/no/such.json'), null);
});
