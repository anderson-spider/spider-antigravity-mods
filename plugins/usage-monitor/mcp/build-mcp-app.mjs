/**
 * @fileoverview Builds both self-contained single-file MCP App HTML bundles
 * (`mcp/dist/dashboard.html` and `mcp/dist/health-card.html`) using Vite
 * (zero external network requests, CSP-safe, < 10 MiB each).
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build as viteBuild } from 'vite';

const MCP_DIR = dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = dirname(MCP_DIR);
const DIST_DIR = join(MCP_DIR, 'dist');
const MAX_RESOURCE_BYTES = 10 * 1024 * 1024;

function escapeInlineScript(code) {
  return String(code).replace(/<\/(script)/gi, '<\\/$1');
}

function escapeInlineStyle(css) {
  return String(css).replace(/<\/(style)/gi, '<\\/$1');
}

async function buildSingleHtmlApp({
  entryPath,
  outFileName,
  globalName,
  jsFileName,
  title,
  rootId,
  htmlAttrs,
}) {
  const result = await viteBuild({
    configFile: false,
    logLevel: 'silent',
    root: PLUGIN_DIR,
    build: {
      write: false,
      sourcemap: false,
      target: 'es2022',
      cssCodeSplit: false,
      assetsInlineLimit: 1024 * 1024,
      rollupOptions: {
        input: entryPath,
        output: {
          format: 'iife',
          name: globalName,
          entryFileNames: jsFileName,
          assetFileNames: '[name][extname]',
        },
      },
    },
  });

  const outputs = Array.isArray(result) ? result : [result];
  const items = outputs.flatMap((out) => out?.output ?? []);
  const jsChunk = items.find((item) => item?.type === 'chunk' && item?.isEntry);
  const cssAssets = items.filter(
    (item) => item?.type === 'asset' && String(item.fileName || '').endsWith('.css')
  );

  const bundleJs = jsChunk?.code;
  if (!bundleJs) {
    throw new Error(`Vite produced no JS chunk for ${entryPath}`);
  }
  const bundleCss = cssAssets
    .map((asset) =>
      typeof asset.source === 'string'
        ? asset.source
        : Buffer.from(asset.source).toString('utf8')
    )
    .join('\n');
  if (!bundleCss.trim()) {
    throw new Error(`Vite produced no CSS asset for ${entryPath}`);
  }

  const html = [
    '<!DOCTYPE html>',
    `<html ${htmlAttrs}>`,
    '<head>',
    '  <meta charset="utf-8">',
    '  <meta name="viewport" content="width=device-width, initial-scale=1">',
    `  <title>${title}</title>`,
    `  <style>\n${escapeInlineStyle(bundleCss)}\n  </style>`,
    '</head>',
    '<body>',
    `  <div id="${rootId}"></div>`,
    `  <script>\n${escapeInlineScript(bundleJs)}\n  </script>`,
    '</body>',
    '</html>',
    '',
  ].join('\n');

  const byteLength = Buffer.byteLength(html, 'utf8');
  if (byteLength >= MAX_RESOURCE_BYTES) {
    throw new Error(
      `MCP App bundle ${outFileName} exceeds Antigravity 10 MiB limit (${byteLength} bytes)`
    );
  }

  mkdirSync(DIST_DIR, { recursive: true });
  const outPath = join(DIST_DIR, outFileName);
  writeFileSync(outPath, html, 'utf8');
  console.log(`Built mcp/dist/${outFileName} (${(byteLength / 1024).toFixed(1)} kB)`);
  return { outPath, byteLength };
}

export async function buildMcpAppHtml() {
  const dashboard = await buildSingleHtmlApp({
    entryPath: join(MCP_DIR, 'dashboard-entry.mjs'),
    outFileName: 'dashboard.html',
    globalName: 'UsageMonitorDashboardApp',
    jsFileName: 'dashboard.js',
    title: 'Usage &amp; Speed Monitor',
    rootId: 'app-root',
    htmlAttrs: 'lang="en" data-mcp-app="true" data-surface="global"',
  });

  const healthCard = await buildSingleHtmlApp({
    entryPath: join(MCP_DIR, 'health-card-entry.mjs'),
    outFileName: 'health-card.html',
    globalName: 'UsageMonitorHealthCardApp',
    jsFileName: 'health-card.js',
    title: 'Session Health',
    rootId: 'health-card-root',
    htmlAttrs: 'lang="en" data-mcp-app="true" data-surface="inline"',
  });

  return {
    outPath: dashboard.outPath,
    byteLength: dashboard.byteLength,
    dashboard,
    healthCard,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await buildMcpAppHtml();
}
