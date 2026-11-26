import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  discoverAntigravityLsEndpoint,
  getLocalHubPorts,
} from '../backend/ls-discovery.mjs';
import { setLoopbackHttpsRequester } from '../backend/http-helpers.mjs';
import { backendHarness } from './backend-harness.mjs';

function makeTempDaemonDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'usage-monitor-ls-disc-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('discoverAntigravityLsEndpoint discovers SSH/persistent ls_*.json daemon files and ignores non-JSON sidecar files', async (t) => {
  const daemonDir = makeTempDaemonDir(t);
  writeFileSync(
    join(daemonDir, 'ls_14b5b8b4e06bc747.json'),
    JSON.stringify({
      pid: 4242,
      httpsPort: 36123,
      httpPort: 39729,
      lspPort: 0,
      lsVersion: '2.35.2',
      csrfToken: 'ssh-hub-token',
    })
  );
  // Real Antigravity persistent hub also writes lock/lease sidecar files alongside ls_*.json
  writeFileSync(join(daemonDir, 'ls_14b5b8b4e06bc747.json.host'), 'remote-host\n');
  writeFileSync(join(daemonDir, 'ls_14b5b8b4e06bc747.json.keeper'), 'keeper\n');
  writeFileSync(join(daemonDir, 'ls_14b5b8b4e06bc747.json.lease'), 'lease\n');

  const probed = [];
  const found = await discoverAntigravityLsEndpoint({
    ppid: 4242,
    daemonDirs: [daemonDir],
    isPidAliveFn: (pid) => pid === 4242,
    fetchFn: async (url, init) => {
      probed.push({ url, csrf: init?.headers?.['x-codeium-csrf-token'] });
      if (url === 'http://127.0.0.1:39729/exa.language_server_pb.LanguageServerService/GetUserStatus') {
        return { ok: true, status: 200, json: async () => ({ userStatus: {} }) };
      }
      return { ok: false, status: 404 };
    },
  });

  assert.deepEqual(found, {
    addr: '127.0.0.1:39729',
    baseUrl: 'http://127.0.0.1:39729',
    csrfToken: 'ssh-hub-token',
    pid: 4242,
  });
  assert.equal(probed.length, 1);
  assert.equal(probed[0].csrf, 'ssh-hub-token');
});

test('discoverAntigravityLsEndpoint prioritizes parent PID across hub_*.json and ls_*.json and skips dead PIDs', async (t) => {
  const daemonDir = makeTempDaemonDir(t);
  mkdirSync(daemonDir, { recursive: true });
  writeFileSync(
    join(daemonDir, 'hub_58331.json'),
    JSON.stringify({ pid: 1001, httpPort: 58331, httpsPort: 58330, csrfToken: 'desktop-token' })
  );
  writeFileSync(
    join(daemonDir, 'ls_dead.json'),
    JSON.stringify({ pid: 9999, httpPort: 41000, csrfToken: 'dead-token' })
  );
  writeFileSync(
    join(daemonDir, 'ls_live.json'),
    JSON.stringify({ pid: 2002, httpPort: 39729, httpsPort: 36123, csrfToken: 'parent-ls-token' })
  );

  const visitedPorts = [];
  const found = await discoverAntigravityLsEndpoint({
    ppid: 2002,
    daemonDirs: [daemonDir],
    isPidAliveFn: (pid) => pid === 1001 || pid === 2002,
    fetchFn: async (url) => {
      visitedPorts.push(new URL(url).port);
      return { ok: true, status: 200 };
    },
  });

  assert.equal(found?.pid, 2002);
  assert.equal(found?.csrfToken, 'parent-ls-token');
  assert.deepEqual(visitedPorts, ['39729']);

  const ports = getLocalHubPorts({
    daemonDirs: [daemonDir],
    isPidAliveFn: (pid) => pid === 1001 || pid === 2002,
    force: true,
  });
  assert.equal(ports.httpPorts.has(58331), true);
  assert.equal(ports.httpPorts.has(39729), true);
  assert.equal(ports.httpsPorts.has(36123), true);
  assert.equal(ports.httpPorts.has(41000), false);
  assert.equal(ports.csrfTokens.has('parent-ls-token'), true);
});

test('discoverAntigravityLsEndpoint and callLsRpc support self-signed loopback HTTPS when only httpsPort is available', async (t) => {
  const daemonDir = makeTempDaemonDir(t);
  writeFileSync(
    join(daemonDir, 'ls_https_only.json'),
    JSON.stringify({ pid: 5555, httpPort: 0, httpsPort: 36123, csrfToken: 'https-only-token' })
  );

  const httpsRequests = [];
  setLoopbackHttpsRequester((options, onResponse) => {
    httpsRequests.push(options);
    const req = new EventEmitter();
    req.setTimeout = () => {};
    req.write = () => {};
    req.destroy = () => {};
    req.end = () => {
      const res = new EventEmitter();
      res.statusCode = 200;
      onResponse(res);
      res.emit('data', Buffer.from(JSON.stringify({ userStatus: { email: 'dev@example.com' } })));
      res.emit('end');
    };
    return req;
  });
  t.after(() => setLoopbackHttpsRequester(null));

  const found = await discoverAntigravityLsEndpoint({
    ppid: 5555,
    daemonDirs: [daemonDir],
    isPidAliveFn: (pid) => pid === 5555,
  });

  assert.deepEqual(found, {
    addr: 'https://127.0.0.1:36123',
    baseUrl: 'https://127.0.0.1:36123',
    csrfToken: 'https-only-token',
    pid: 5555,
  });
  assert.equal(httpsRequests.length, 1);
  assert.equal(httpsRequests[0].port, 36123);
  assert.equal(httpsRequests[0].rejectUnauthorized, false);
  assert.equal(httpsRequests[0].headers['x-codeium-csrf-token'], 'https-only-token');

  // Verify local callLsRpc also routes https://127.0.0.1 through postLoopbackHttpsJson
  const h = backendHarness();
  const rpcRequests = [];
  h.setLoopbackHttpsRequester((options, onResponse) => {
    rpcRequests.push(options);
    const req = new EventEmitter();
    req.setTimeout = () => {};
    req.write = () => {};
    req.destroy = () => {};
    req.end = () => {
      const res = new EventEmitter();
      res.statusCode = 200;
      onResponse(res);
      res.emit('data', Buffer.from(JSON.stringify({ response: { groups: [] } })));
      res.emit('end');
    };
    return req;
  });
  const remoteEp = h.registerRemoteEndpoint({
    origin: 'https://127.0.0.1:36123',
    baseUrl: 'https://127.0.0.1:36123',
    csrfToken: 'https-only-token',
  });
  const rpcRes = await h.callLsRpc('RetrieveUserQuotaSummary', { forceRefresh: true }, 2000, remoteEp);
  assert.deepEqual(structuredClone(rpcRes), { response: { groups: [] } });
  assert.equal(rpcRequests.length, 1);
  assert.equal(rpcRequests[0].rejectUnauthorized, false);
});
