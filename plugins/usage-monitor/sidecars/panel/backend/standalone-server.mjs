/**
 * @fileoverview 无 `sidecar_sdk` 依赖的独立 Web 监控 HTTP 服务端 (`standalone-server.mjs`)。
 *
 * 面向无头 Linux CLI (`agy` / `agy remote-control serve`)、SSH 端口转发 (`ssh -L`) 与受保护远程访问场景：
 * 1. 默认严格绑定 `127.0.0.1`（本机浏览器或 `ssh -L` 零配置直连，校检回环地址与同端口 Host/Origin）；
 * 2. 若显式绑定非回环地址（如 `0.0.0.0`、`::` 或局域网 IP），强制要求配置 `--token <secret>` 或
 *    `USAGE_MONITOR_STANDALONE_TOKEN`，拒绝无鉴权公网/局域网裸奔启动；
 * 3. 完整托管四分页 Web 面板（`/`、`/app.js`、`/styles.css`、`/preload.js` 兼容桩）与 `/api/*` 路由。
 */

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import {
  bootWindowBridgeRuntime,
  dispatchBridgeApiRequest,
} from './api-actions.mjs';
import { lsRuntimeEndpoint, setLsRuntimeEndpoint } from './config.mjs';
import {
  NO_STORE_HEADERS,
  isLocalHostRequest,
  readLocalAsync,
  readStaticPanelAsset,
} from './http-helpers.mjs';
import { isTestRuntime } from './runtime-env.mjs';
import {
  formatStandaloneHelpText,
  parseStandaloneCliArgs,
} from './standalone-cli-args.mjs';

export { formatStandaloneHelpText, parseStandaloneCliArgs };

const MAX_JSON_BODY_BYTES = 1024 * 1024;
const AUTH_COOKIE_NAME = 'ag_um_token';

/**
 * 判断绑定监听地址是否属于纯本机回环地址。
 *
 * @param {string} host
 * @returns {boolean}
 */
export function isLoopbackBindHost(host) {
  const clean = String(host || '127.0.0.1')
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '');
  if (!clean) return true;
  if (clean === 'localhost' || clean === '::1' || clean === '0:0:0:0:0:0:0:1') {
    return true;
  }
  return /^127\.(?:25[0-5]|2[0-4]\d|1?\d?\d)\.(?:25[0-5]|2[0-4]\d|1?\d?\d)\.(?:25[0-5]|2[0-4]\d|1?\d?\d)$/.test(
    clean
  );
}

function isLoopbackRemoteAddress(remoteAddress) {
  const addr = String(remoteAddress || '').trim().toLowerCase();
  if (!addr) return true;
  if (addr === '::1' || addr === '127.0.0.1') return true;
  if (addr.startsWith('::ffff:')) {
    return isLoopbackBindHost(addr.slice(7));
  }
  return isLoopbackBindHost(addr);
}

function sha256Buffer(value) {
  return createHash('sha256').update(String(value ?? ''), 'utf8').digest();
}

function safeEqualSecret(candidate, expected) {
  if (typeof candidate !== 'string' || typeof expected !== 'string' || !expected) {
    return false;
  }
  return timingSafeEqual(sha256Buffer(candidate), sha256Buffer(expected));
}

function deriveCookieValue(secret) {
  return createHmac('sha256', 'ag-usage-monitor-standalone-cookie-v1')
    .update(secret, 'utf8')
    .digest('hex');
}

function parseCookies(cookieHeader) {
  const out = {};
  for (const part of String(cookieHeader || '').split(';')) {
    const idx = part.indexOf('=');
    if (idx <= 0) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (!k) continue;
    try {
      out[k] = decodeURIComponent(v);
    } catch {
      out[k] = v;
    }
  }
  return out;
}

function extractBearerToken(authHeader) {
  const raw = String(authHeader || '').trim();
  const m = raw.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : '';
}

function renderTokenLoginHtml(hasError = false) {
  const errHtml = hasError
    ? '<p class="err">Invalid access token. Please verify and try again.</p>'
    : '';
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Usage Monitor · Access Verification</title>
  <style>
    :root { color-scheme: dark light; }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100dvh;
      display: flex;
      align-items: center;
      justify-content: center;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: #131720;
      color: #e6ebf2;
      padding: 16px;
    }
    .card {
      width: 100%;
      max-width: 360px;
      background: #1a202c;
      border: 1px solid #2b3445;
      border-radius: 6px;
      padding: 20px;
    }
    h1 { margin: 0 0 6px; font-size: 15px; font-weight: 600; }
    p { margin: 0 0 14px; font-size: 12px; color: #9aa6b8; line-height: 1.5; }
    p.err { color: #f06a6a; margin-bottom: 12px; }
    input {
      width: 100%;
      padding: 8px 10px;
      font-size: 13px;
      border-radius: 4px;
      border: 1px solid #364156;
      background: #11151d;
      color: #e6ebf2;
      margin-bottom: 12px;
      outline: none;
    }
    input:focus { border-color: #3b82f6; }
    button {
      width: 100%;
      padding: 8px 12px;
      font-size: 13px;
      font-weight: 500;
      border: none;
      border-radius: 4px;
      background: #2563eb;
      color: #ffffff;
      cursor: pointer;
    }
    button:hover { background: #1d4ed8; }
  </style>
</head>
<body>
  <form class="card" method="POST" action="/api/standalone-auth">
    <h1>Usage &amp; Speed Monitor</h1>
    <p>This standalone monitor requires an access token to continue.</p>
    ${errHtml}
    <input type="password" name="token" placeholder="Enter --token secret" autocomplete="current-password" required autofocus>
    <button type="submit">Verify &amp; Open Panel</button>
  </form>
</body>
</html>`;
}

function readRawBody(req, maxBytes = MAX_JSON_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let settled = false;
    req.on('data', (chunk) => {
      if (settled) return;
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
      total += buf.length;
      if (total > maxBytes) {
        settled = true;
        const err = new Error('Payload too large');
        err.statusCode = 413;
        reject(err);
        req.resume();
        return;
      }
      chunks.push(buf);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
  });
}

function isSameOriginPostRequest(req) {
  const secFetchSite = String(req.headers?.['sec-fetch-site'] || '').trim().toLowerCase();
  if (secFetchSite === 'cross-site') return false;
  const origin = String(req.headers?.origin || '').trim();
  if (!origin) return true;
  const host = String(req.headers?.host || '').trim().toLowerCase();
  if (!host) return false;
  try {
    const parsedOrigin = new URL(origin);
    return parsedOrigin.host.toLowerCase() === host;
  } catch {
    return false;
  }
}

/**
 * 创建独立 Web 监控服务器控制器。
 *
 * @param {{
 *   host?: string,
 *   port?: number,
 *   token?: string,
 *   lsAddr?: string,
 *   csrfToken?: string,
 *   handleApiRequest?: typeof dispatchBridgeApiRequest,
 *   readAssetFn?: typeof readLocalAsync,
 *   onRestart?: (() => void) | null,
 *   skipStartupDiscovery?: boolean
 * }} [options]
 */
export function createStandaloneWebServer(options = {}) {
  const host = String(options.host || '127.0.0.1').trim() || '127.0.0.1';
  const requestedPort = Number.isInteger(options.port) ? options.port : 8787;
  const token = String(options.token || '').trim();
  const loopbackHost = isLoopbackBindHost(host);

  if (!loopbackHost && !token) {
    throw new Error(
      `Refusing to bind standalone server to non-loopback host "${host}" without --token <secret> (or USAGE_MONITOR_STANDALONE_TOKEN). Bind to 127.0.0.1 with SSH port forwarding (ssh -L), or configure an access token.`
    );
  }

  if (options.lsAddr) {
    setLsRuntimeEndpoint(options.lsAddr, options.csrfToken || '', { isDynamic: false });
  }

  const expectedCookieVal = token ? deriveCookieValue(token) : '';
  const onRestart = typeof options.onRestart === 'function' ? options.onRestart : () => {};
  const handleApi =
    options.handleApiRequest ||
    ((pathname, method, data) =>
      dispatchBridgeApiRequest(pathname, method, data, { onRestart }));
  const readAsset = options.readAssetFn || readLocalAsync;

  let server = null;
  let boundPort = 0;

  function sendResponse(res, status, contentType, body, extraHeaders = {}) {
    const payload = Buffer.isBuffer(body) ? body : Buffer.from(String(body ?? ''), 'utf8');
    res.writeHead(status, {
      'Content-Type': contentType,
      'Content-Length': payload.length,
      ...NO_STORE_HEADERS,
      ...extraHeaders,
    });
    res.end(payload);
  }

  function checkRequestAuthorized(req, urlObj) {
    if (!token) {
      if (!isLoopbackRemoteAddress(req.socket?.remoteAddress)) {
        return { ok: false, status: 403, reason: 'Forbidden non-loopback client' };
      }
      if (!isLocalHostRequest(req)) {
        return { ok: false, status: 403, reason: 'Forbidden host or origin' };
      }
      return { ok: true, viaQueryToken: false };
    }

    const headerToken = String(req.headers?.['x-usage-monitor-token'] || '').trim();
    const bearerToken = extractBearerToken(req.headers?.authorization);
    const hasExplicitHeaderAuth =
      (headerToken && safeEqualSecret(headerToken, token)) ||
      (bearerToken && safeEqualSecret(bearerToken, token));

    if (hasExplicitHeaderAuth) {
      return { ok: true, viaQueryToken: false };
    }

    if (req.method === 'POST' && !isSameOriginPostRequest(req)) {
      return { ok: false, status: 403, reason: 'Forbidden cross-origin request' };
    }

    const cookies = parseCookies(req.headers?.cookie);
    if (cookies[AUTH_COOKIE_NAME] && safeEqualSecret(cookies[AUTH_COOKIE_NAME], expectedCookieVal)) {
      return { ok: true, viaQueryToken: false };
    }

    if (req.method === 'GET' || req.method === 'HEAD') {
      const queryToken = urlObj.searchParams.get('token') || '';
      if (queryToken && safeEqualSecret(queryToken, token)) {
        return { ok: true, viaQueryToken: true };
      }
    }

    return { ok: false, status: 401, reason: 'Unauthorized: valid access token required' };
  }

  async function handleHttpRequest(req, res) {
    try {
      const method = String(req.method || 'GET').toUpperCase();
      const rawUrl = String(req.url || '/');
      const urlObj = new URL(rawUrl, 'http://127.0.0.1');
      const pathname = urlObj.pathname || '/';

      if (token && pathname === '/api/standalone-auth' && method === 'POST') {
        if (!isSameOriginPostRequest(req)) {
          sendResponse(res, 403, 'text/plain; charset=utf-8', 'Forbidden cross-origin request');
          return;
        }
        const formRaw = await readRawBody(req, 16 * 1024);
        const formParams = new URLSearchParams(formRaw);
        const submitted = String(formParams.get('token') || '').trim();
        if (!safeEqualSecret(submitted, token)) {
          sendResponse(res, 401, 'text/html; charset=utf-8', renderTokenLoginHtml(true));
          return;
        }
        res.writeHead(303, {
          Location: '/',
          'Set-Cookie': `${AUTH_COOKIE_NAME}=${expectedCookieVal}; HttpOnly; SameSite=Strict; Path=/`,
          ...NO_STORE_HEADERS,
        });
        res.end();
        return;
      }

      const auth = checkRequestAuthorized(req, urlObj);
      if (!auth.ok) {
        if (auth.status === 401 && (pathname === '/' || pathname === '/index.html') && method === 'GET') {
          sendResponse(res, 401, 'text/html; charset=utf-8', renderTokenLoginHtml(false));
          return;
        }
        sendResponse(
          res,
          auth.status,
          'application/json; charset=utf-8',
          JSON.stringify({ error: auth.reason })
        );
        return;
      }

      if (auth.viaQueryToken && (pathname === '/' || pathname === '/index.html') && method === 'GET') {
        urlObj.searchParams.delete('token');
        const cleanSearch = urlObj.searchParams.toString();
        const redirectTarget = cleanSearch ? `/?${cleanSearch}` : '/';
        res.writeHead(302, {
          Location: redirectTarget,
          'Set-Cookie': `${AUTH_COOKIE_NAME}=${expectedCookieVal}; HttpOnly; SameSite=Strict; Path=/`,
          ...NO_STORE_HEADERS,
        });
        res.end();
        return;
      }

      if (method === 'GET' || method === 'HEAD') {
        const asset = await readStaticPanelAsset(pathname, readAsset);
        if (asset) {
          sendResponse(res, asset.status, asset.contentType, method === 'HEAD' ? '' : asset.body, asset.headers);
          return;
        }
        if (pathname === '/preload.js') {
          sendResponse(
            res,
            200,
            'application/javascript; charset=utf-8',
            method === 'HEAD' ? '' : '/* standalone web mode */\n'
          );
          return;
        }
        if (pathname === '/favicon.ico') {
          res.writeHead(204, NO_STORE_HEADERS);
          res.end();
          return;
        }
      }

      if (pathname.startsWith('/api/')) {
        let data = undefined;
        if (method === 'GET') {
          data = Object.fromEntries(urlObj.searchParams.entries());
          delete data.token;
        } else if (method === 'POST') {
          const rawBody = await readRawBody(req, MAX_JSON_BODY_BYTES);
          if (rawBody.trim()) {
            try {
              data = JSON.parse(rawBody);
            } catch {
              sendResponse(
                res,
                400,
                'application/json; charset=utf-8',
                JSON.stringify({ error: 'Invalid JSON request body' })
              );
              return;
            }
          } else {
            data = {};
          }
        } else {
          sendResponse(
            res,
            405,
            'application/json; charset=utf-8',
            JSON.stringify({ error: 'Method not allowed' })
          );
          return;
        }

        const out = await handleApi(pathname, method, data);
        sendResponse(
          res,
          out?.status || 200,
          out?.contentType || 'application/json; charset=utf-8',
          out?.body ?? '{}',
          out?.headers || {}
        );
        return;
      }

      sendResponse(
        res,
        404,
        'application/json; charset=utf-8',
        JSON.stringify({ error: 'Not found' })
      );
    } catch (err) {
      const status = Number(err?.statusCode) || 500;
      sendResponse(
        res,
        status,
        'application/json; charset=utf-8',
        JSON.stringify({ error: err?.message || 'Internal server error' })
      );
    }
  }

  async function start() {
    if (server && boundPort > 0) {
      return getStatus();
    }
    if (!options.skipStartupDiscovery && !isTestRuntime()) {
      bootWindowBridgeRuntime({ allowDynamicLs: true });
    }

    const srv = http.createServer((req, res) => {
      void handleHttpRequest(req, res);
    });

    await new Promise((resolve, reject) => {
      const onError = (err) => {
        srv.removeListener('listening', onListening);
        reject(err);
      };
      const onListening = () => {
        srv.removeListener('error', onError);
        resolve();
      };
      srv.once('error', onError);
      srv.once('listening', onListening);
      srv.listen(requestedPort, host);
    });

    server = srv;
    const addrInfo = srv.address();
    boundPort = typeof addrInfo === 'object' && addrInfo ? Number(addrInfo.port || 0) : requestedPort;
    return getStatus();
  }

  async function stop() {
    const srv = server;
    server = null;
    boundPort = 0;
    if (!srv) return;
    await new Promise((resolve) => {
      srv.close(() => resolve());
    });
  }

  function getStatus() {
    const displayHost = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
    return {
      running: Boolean(server && boundPort > 0),
      host,
      port: boundPort,
      loopbackOnly: loopbackHost,
      tokenProtected: Boolean(token),
      url: boundPort > 0 ? `http://${displayHost}:${boundPort}` : '',
    };
  }

  return {
    start,
    stop,
    getStatus,
  };
}
