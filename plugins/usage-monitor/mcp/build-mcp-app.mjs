/**
 * @fileoverview Builds the self-contained single-file MCP App HTML bundle
 * (`mcp/dist/dashboard.html`) from `sidecars/panel/styles.css`,
 * `mcp/ui-bridge-entry.mjs` (bundled via Vite with `@modelcontextprotocol/ext-apps`),
 * and `sidecars/panel/app.js`.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build as viteBuild } from 'vite';

const MCP_DIR = dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = dirname(MCP_DIR);
const PANEL_DIR = join(PLUGIN_DIR, 'sidecars', 'panel');
const DIST_DIR = join(MCP_DIR, 'dist');
const OUT_HTML = join(DIST_DIR, 'dashboard.html');
const MAX_RESOURCE_BYTES = 10 * 1024 * 1024;

function escapeInlineScript(code) {
  return String(code).replace(/<\/(script)/gi, '<\\/$1');
}

function escapeInlineStyle(css) {
  return String(css).replace(/<\/(style)/gi, '<\\/$1');
}

export async function buildMcpAppHtml() {
  const stylesCss = readFileSync(join(PANEL_DIR, 'styles.css'), 'utf8');
  const appJs = readFileSync(join(PANEL_DIR, 'app.js'), 'utf8');

  const result = await viteBuild({
    configFile: false,
    logLevel: 'silent',
    root: MCP_DIR,
    build: {
      write: false,
      sourcemap: false,
      target: 'es2022',
      lib: {
        entry: join(MCP_DIR, 'ui-bridge-entry.mjs'),
        name: 'UsageMonitorMcpBridge',
        formats: ['iife'],
        fileName: () => 'ui-bridge.js',
      },
    },
  });

  const outputs = Array.isArray(result) ? result : [result];
  const chunk = outputs.flatMap((out) => out?.output ?? []).find((item) => item?.type === 'chunk');
  const bridgeJs = chunk?.code;
  if (!bridgeJs) {
    throw new Error('Vite produced no chunk output for mcp/ui-bridge-entry.mjs');
  }

  const html = [
    '<!DOCTYPE html>',
    '<html lang="en" data-mcp-app="true" data-surface="global">',
    '<head>',
    '  <meta charset="utf-8">',
    '  <meta name="viewport" content="width=device-width, initial-scale=1">',
    '  <title>Usage &amp; Speed Monitor</title>',
    `  <style>\n${escapeInlineStyle(stylesCss)}\n  </style>`,
    '</head>',
    '<body>',
    '  <div id="app-root"></div>',
    `  <script>\n${escapeInlineScript(bridgeJs)}\n  </script>`,
    `  <script>\n${escapeInlineScript(appJs)}\n  </script>`,
    '</body>',
    '</html>',
    '',
  ].join('\n');

  const byteLength = Buffer.byteLength(html, 'utf8');
  if (byteLength >= MAX_RESOURCE_BYTES) {
    throw new Error(
      `MCP App bundle exceeds Antigravity 10 MiB limit (${byteLength} bytes)`
    );
  }

  mkdirSync(DIST_DIR, { recursive: true });
  writeFileSync(OUT_HTML, html, 'utf8');

  console.log(
    `Built mcp/dist/dashboard.html (${(byteLength / 1024).toFixed(1)} kB)`
  );
  return { outPath: OUT_HTML, byteLength };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await buildMcpAppHtml();
}
