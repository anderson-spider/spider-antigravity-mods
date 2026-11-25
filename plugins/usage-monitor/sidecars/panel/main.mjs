/**
 * @fileoverview Antigravity Usage Monitor 面板 Sidecar HTTP 服务入口。
 *
 * 职责边界：
 * - 提供前端静态资产路由（`/`、`/app.js`、`/styles.css`，每次请求从磁盘读取最新产物）；
 * - 提供严格同端口 Loopback 受保护的 JSON API 路由；
 * - 在真实宿主环境中通过 `node:worker_threads` 托管 `./backend/sidecar-worker.mjs`：
 *   当插件在客户端未关闭时执行自更新或外部覆盖文件，主进程保持常驻不退出（守护 `SidecarApp` 宿主端口不断连），
 *   仅在后台毫秒级平滑替换为全新 V8 Isolate 的 Worker 实例并复用桥接端口，彻底消除热更新后的「重试中」失联问题。
 */

import { Worker } from 'node:worker_threads';
import { Response, SidecarApp } from 'sidecar_sdk';
import { BRIDGE_API_ROUTE_DEFS } from './shared/window-bridge-protocol.mjs';
import {
  STATIC_PANEL_ASSETS,
  isLocalHostRequest,
  readStaticPanelAsset,
} from './backend/http-helpers.mjs';
import { createSidecarWorkerSupervisor } from './backend/sidecar-host.mjs';

const app = new SidecarApp();

const supervisor = createSidecarWorkerSupervisor({
  createWorker: () => new Worker(new URL('./backend/sidecar-worker.mjs', import.meta.url)),
});

async function handleProtectedApi(pathname, method, data, req) {
  if (!isLocalHostRequest(req)) {
    return new Response(JSON.stringify({ error: 'Forbidden host or origin' }), {
      status: 403,
      contentType: 'application/json',
    });
  }
  const out = await supervisor.forwardApiCall(pathname, method, data);
  return new Response(out.body, {
    status: out.status,
    contentType: out.contentType,
    headers: out.headers,
  });
}

for (const asset of STATIC_PANEL_ASSETS) {
  app.page(asset.path, async () => {
    const out = await readStaticPanelAsset(asset.path);
    return new Response(out.body, {
      contentType: out.contentType,
      headers: out.headers,
    });
  });
}

for (const route of BRIDGE_API_ROUTE_DEFS) {
  app.api(
    route.path,
    (data, req) =>
      handleProtectedApi(
        route.path,
        route.method,
        route.method === 'GET' && route.action !== 'telemetry' ? undefined : data,
        req
      ),
    route.method
  );
}

app.run();
void supervisor.ensureActiveWorker();
