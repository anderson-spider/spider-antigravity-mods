/**
 * @fileoverview Hot-reloadable Worker supervisor for `main.mjs`.
 * Keeps the parent SidecarApp HTTP server alive across worker reloads and retries GET RPCs once on worker crash.
 */

export function createSidecarWorkerSupervisor({
  createWorker,
  restartDelayMs = 120,
  rpcTimeoutMs = 30000,
  shutdownTimeoutMs = 1200,
} = {}) {
  let activeWorker = null;
  let workerSwapPromise = null;
  let stopped = false;
  let rpcSeq = 0;
  const pendingWorkerRpcs = new Map();

  function spawnWorker() {
    const worker = createWorker();

    worker.on('message', (msg) => {
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === 'reload_request') {
        if (worker === activeWorker && !stopped) {
          void reloadBackendWorker();
        }
        return;
      }
      if (msg.type === 'api_result' || msg.type === 'shutdown_ack') {
        const pending = pendingWorkerRpcs.get(msg.id);
        if (!pending) return;
        pendingWorkerRpcs.delete(msg.id);
        clearTimeout(pending.timer);
        if (msg.type === 'shutdown_ack' || msg.ok) {
          pending.resolve(msg.response ?? true);
        } else {
          pending.reject(new Error(msg.error || 'Backend worker error'));
        }
      }
    });

    worker.on('exit', () => {
      for (const [id, entry] of pendingWorkerRpcs.entries()) {
        if (entry.worker === worker) {
          pendingWorkerRpcs.delete(id);
          clearTimeout(entry.timer);
          entry.reject(new Error('Backend worker exited during request'));
        }
      }
      if (activeWorker === worker) {
        activeWorker = null;
        if (!workerSwapPromise && !stopped) {
          const timer = setTimeout(() => {
            if (!activeWorker && !workerSwapPromise && !stopped) {
              activeWorker = spawnWorker();
            }
          }, restartDelayMs);
          timer.unref?.();
        }
      }
    });

    worker.on('error', () => {
      // Exit handler handles cleanup and respawn
    });

    return worker;
  }

  function sendWorkerMessage(worker, payload, timeoutMs = rpcTimeoutMs) {
    return new Promise((resolve, reject) => {
      const id = ++rpcSeq;
      const timer = setTimeout(() => {
        pendingWorkerRpcs.delete(id);
        reject(new Error('Backend worker request timeout'));
      }, timeoutMs);
      timer.unref?.();
      pendingWorkerRpcs.set(id, { worker, timer, resolve, reject });
      try {
        worker.postMessage({ ...payload, id });
      } catch (err) {
        pendingWorkerRpcs.delete(id);
        clearTimeout(timer);
        reject(err);
      }
    });
  }

  async function stopWorkerGracefully(worker) {
    if (!worker) return;
    try {
      await sendWorkerMessage(worker, { type: 'shutdown' }, shutdownTimeoutMs);
    } catch {
      // Terminate immediately on timeout or closed channel
    }
    try {
      await worker.terminate();
    } catch {
      // Ignore already-terminated worker errors
    }
  }

  function reloadBackendWorker() {
    if (stopped) return Promise.resolve(null);
    if (workerSwapPromise) return workerSwapPromise;
    workerSwapPromise = (async () => {
      const prev = activeWorker;
      activeWorker = null;
      await stopWorkerGracefully(prev);
      if (stopped) return null;
      activeWorker = spawnWorker();
      return activeWorker;
    })().finally(() => {
      workerSwapPromise = null;
    });
    return workerSwapPromise;
  }

  async function ensureActiveWorker() {
    if (stopped) {
      throw new Error('Sidecar worker supervisor stopped');
    }
    if (workerSwapPromise) {
      return workerSwapPromise;
    }
    if (!activeWorker) {
      activeWorker = spawnWorker();
    }
    return activeWorker;
  }

  async function forwardApiCall(pathname, method, data) {
    const upperMethod = String(method || 'GET').toUpperCase();
    try {
      const worker = await ensureActiveWorker();
      return await sendWorkerMessage(worker, { type: 'api', pathname, method: upperMethod, data });
    } catch (err) {
      if (upperMethod === 'GET' && !stopped) {
        const retryWorker = await ensureActiveWorker();
        return sendWorkerMessage(retryWorker, { type: 'api', pathname, method: upperMethod, data });
      }
      throw err;
    }
  }

  async function stop() {
    stopped = true;
    const prev = activeWorker;
    activeWorker = null;
    await stopWorkerGracefully(prev);
  }

  return {
    ensureActiveWorker,
    forwardApiCall,
    reloadBackendWorker,
    stop,
  };
}
