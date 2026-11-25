import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createSidecarWorkerSupervisor } from '../backend/sidecar-host.mjs';

function createFakeWorker(onPost) {
  const worker = new EventEmitter();
  worker.posted = [];
  worker.terminated = false;
  worker.postMessage = (msg) => {
    worker.posted.push(msg);
    onPost?.(worker, msg);
  };
  worker.terminate = async () => {
    worker.terminated = true;
    worker.emit('exit', 0);
  };
  return worker;
}

test('createSidecarWorkerSupervisor dispatches API calls, retries GET once on crash, does not retry POST, and handles reload_request', async () => {
  const workers = [];
  let failFirstGet = true;

  const supervisor = createSidecarWorkerSupervisor({
    restartDelayMs: 10,
    createWorker: () => {
      const idx = workers.length;
      const w = createFakeWorker((worker, msg) => {
        if (msg.type === 'shutdown') {
          queueMicrotask(() => worker.emit('message', { type: 'shutdown_ack', id: msg.id }));
          return;
        }
        if (msg.type === 'api') {
          if (idx === 0 && msg.method === 'GET' && failFirstGet) {
            failFirstGet = false;
            queueMicrotask(() => worker.emit('exit', 1));
            return;
          }
          if (msg.pathname === '/api/fail-post') {
            queueMicrotask(() => worker.emit('exit', 1));
            return;
          }
          queueMicrotask(() =>
            worker.emit('message', {
              type: 'api_result',
              id: msg.id,
              ok: true,
              response: { status: 200, body: JSON.stringify({ worker: idx, path: msg.pathname }) },
            })
          );
        }
      });
      workers.push(w);
      return w;
    },
  });

  // 1. GET retries once when worker 0 exits mid-flight, succeeding on worker 1
  const res = await supervisor.forwardApiCall('/api/telemetry', 'GET', {});
  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(res.body), { worker: 1, path: '/api/telemetry' });
  assert.equal(workers.length, 2);

  // 2. POST does NOT retry on worker exit
  await assert.rejects(
    () => supervisor.forwardApiCall('/api/fail-post', 'POST', {}),
    /Backend worker exited during request/
  );

  // 3. Ensure active worker spawns worker 2, then reload_request gracefully shuts down worker 2 and spawns worker 3
  const w2 = await supervisor.ensureActiveWorker();
  assert.equal(workers.length, 3);
  w2.emit('message', { type: 'reload_request' });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(w2.terminated, true);
  assert.ok(w2.posted.some((m) => m.type === 'shutdown'));
  assert.equal(workers.length, 4);

  await supervisor.stop();
});
