/**
 * @fileoverview 零业务状态依赖的静态资源读取与本机回环请求来源校验工具。
 *
 * 独立于 `./config.mjs` 与 `./api-actions.mjs`，使宿主入口 `main.mjs` 在生产环境下无需加载完整后端图谱与轨迹缓存。
 */

import { readFileSync, promises as fsPromises } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

function resolveHttpHelperPanelDir() {
  const modDir = dirname(fileURLToPath(import.meta.url));
  return /[\\/]backend$/i.test(modDir) ? dirname(modDir) : modDir;
}

/**
 * 异步读取 `sidecars/panel` 目录下的静态资源文件（兼容单元测试同步沙箱）。
 *
 * @param {string} relPath 相对路径
 * @returns {Promise<string>}
 */
export const readLocalAsync = async (relPath) => {
  const fullPath = join(resolveHttpHelperPanelDir(), relPath);
  if (typeof fsPromises !== 'undefined' && fsPromises?.readFile) {
    return fsPromises.readFile(fullPath, 'utf8');
  }
  return readFileSync(fullPath, 'utf8');
};

export const NO_STORE_HEADERS = Object.freeze({
  'Cache-Control': 'no-store, no-cache, must-revalidate',
  'X-Content-Type-Options': 'nosniff',
});

export const STATIC_PANEL_ASSETS = Object.freeze([
  Object.freeze({ path: '/', file: 'index.html', contentType: 'text/html; charset=utf-8' }),
  Object.freeze({ path: '/app.js', file: 'app.js', contentType: 'application/javascript; charset=utf-8' }),
  Object.freeze({ path: '/styles.css', file: 'styles.css', contentType: 'text/css; charset=utf-8' }),
]);

const STATIC_ASSET_BY_PATH = new Map([
  ...STATIC_PANEL_ASSETS.map((entry) => [entry.path, entry]),
  ['/index.html', STATIC_PANEL_ASSETS[0]],
]);

export async function readStaticPanelAsset(pathname, readAsset = readLocalAsync) {
  const asset = STATIC_ASSET_BY_PATH.get(pathname);
  if (!asset) return null;
  const body = await readAsset(asset.file);
  return {
    status: 200,
    contentType: asset.contentType,
    headers: NO_STORE_HEADERS,
    body,
  };
}

/**
 * 校验请求是否来自本机回环同端口地址 (`127.0.0.1` / `localhost` / `[::1]`) 或受信 Webview Origin，
 * 阻止跨端口本地服务（如本地其他端口的开发服务器）或跨站 DNS Rebinding 访问 API。
 *
 * @param {object} req
 * @returns {boolean}
 */
export function isLocalHostRequest(req) {
  if (!req?.headers) return true;
  const host = String(req.headers.host || '').trim().toLowerCase();
  const hostMatch = host.match(/^(127\.0\.0\.1|localhost|\[::1\])(?::(\d+))?$/);
  if (host && !hostMatch) {
    return false;
  }
  const origin = String(req.headers.origin || '').trim().toLowerCase();
  if (origin && /^vscode-webview:\/\/[a-z0-9._-]+$/.test(origin)) {
    return true;
  }
  const secFetchSite = String(req.headers['sec-fetch-site'] || '').toLowerCase();
  if (secFetchSite === 'cross-site') {
    return false;
  }
  if (origin) {
    const originMatch = origin.match(
      /^(https?):\/\/(127\.0\.0\.1|localhost|\[::1\])(?::(\d+))?$/
    );
    if (!originMatch) {
      return false;
    }
    if (hostMatch) {
      const defaultPort = originMatch[1] === 'https' ? '443' : '80';
      const originPort = originMatch[3] || defaultPort;
      const hostPort = hostMatch[2] || defaultPort;
      if (originPort !== hostPort) {
        return false;
      }
    }
  }
  return true;
}

const LOOPBACK_HTTPS_MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
let loopbackHttpsModulePromise = null;
let customLoopbackHttpsRequester = null;

export function setLoopbackHttpsRequester(requester) {
  customLoopbackHttpsRequester = typeof requester === 'function' ? requester : null;
}

export function isStrictLoopbackUrl(rawUrl) {
  try {
    const parsed = new URL(String(rawUrl || ''));
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    const host = parsed.hostname.toLowerCase();
    return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]';
  } catch {
    return false;
  }
}

async function getLoopbackHttpsRequestFn() {
  if (customLoopbackHttpsRequester) return customLoopbackHttpsRequester;
  if (typeof globalThis !== 'undefined' && typeof globalThis.__agLoopbackHttpsRequest === 'function') {
    return globalThis.__agLoopbackHttpsRequest;
  }
  if (!loopbackHttpsModulePromise) {
    loopbackHttpsModulePromise = import('node:https')
      .then((mod) => (mod.default || mod)?.request || null)
      .catch(() => null);
  }
  return loopbackHttpsModulePromise;
}

/**
 * Sends a JSON POST request to a strict loopback HTTPS endpoint (`127.0.0.1`/`localhost`/`::1`),
 * allowing the host's self-signed localhost TLS certificate.
 */
export async function postLoopbackHttpsJson(urlStr, csrfToken, bodyText, timeoutMs) {
  const parsed = new URL(urlStr);
  if (!isStrictLoopbackUrl(urlStr) || parsed.protocol !== 'https:') {
    throw new Error('Refusing non-loopback HTTPS request');
  }
  const requestFn = await getLoopbackHttpsRequestFn();
  if (typeof requestFn !== 'function') {
    return fetch(urlStr, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(csrfToken ? { 'x-codeium-csrf-token': csrfToken } : {}),
      },
      body: bodyText,
      signal: AbortSignal.timeout(timeoutMs),
    });
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    let wallTimer = null;
    const clearWallTimer = () => {
      if (wallTimer) {
        clearTimeout(wallTimer);
        wallTimer = null;
      }
    };
    const finishErr = (err) => {
      if (settled) return;
      settled = true;
      clearWallTimer();
      reject(err);
    };
    const bodyBuf = Buffer.from(bodyText, 'utf8');
    const req = requestFn(
      {
        hostname: parsed.hostname.replace(/^\[|\]$/g, ''),
        port: Number(parsed.port || 443),
        path: `${parsed.pathname}${parsed.search}`,
        method: 'POST',
        rejectUnauthorized: false,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': bodyBuf.length,
          ...(csrfToken ? { 'x-codeium-csrf-token': csrfToken } : {}),
        },
      },
      (res) => {
        const chunks = [];
        let totalBytes = 0;
        res.on('data', (chunk) => {
          if (settled) return;
          totalBytes += chunk.length;
          if (totalBytes > LOOPBACK_HTTPS_MAX_RESPONSE_BYTES) {
            const sizeErr = new Error('Loopback LS response exceeded size limit');
            finishErr(sizeErr);
            req.destroy(sizeErr);
            return;
          }
          chunks.push(chunk);
        });
        res.on('aborted', () => {
          finishErr(new Error('Loopback LS HTTPS response aborted'));
        });
        res.on('end', () => {
          if (settled) return;
          settled = true;
          clearWallTimer();
          const status = Number(res.statusCode || 0);
          const rawText = Buffer.concat(chunks).toString('utf8');
          resolve({
            ok: status >= 200 && status < 300,
            status,
            json: async () => JSON.parse(rawText || '{}'),
            text: async () => rawText,
          });
        });
        res.on('error', finishErr);
      }
    );

    wallTimer = setTimeout(() => {
      const timeoutErr = new Error(`Loopback LS HTTPS timeout (${timeoutMs}ms)`);
      finishErr(timeoutErr);
      req.destroy(timeoutErr);
    }, timeoutMs);
    wallTimer?.unref?.();

    req.setTimeout(timeoutMs, () => {
      const timeoutErr = new Error(`Loopback LS HTTPS timeout (${timeoutMs}ms)`);
      finishErr(timeoutErr);
      req.destroy(timeoutErr);
    });
    req.on('error', finishErr);
    req.write(bodyBuf);
    req.end();
  });
}
