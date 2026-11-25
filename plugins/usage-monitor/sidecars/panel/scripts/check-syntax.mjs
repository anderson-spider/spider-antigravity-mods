/**
 * @fileoverview Validates JavaScript module syntax across all plugin entrypoints,
 * backend/shared modules, scripts, and tests using Node's native `--check` flag.
 */

import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PANEL_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const files = [
  join(PANEL_DIR, 'main.mjs'),
  join(PANEL_DIR, 'standalone.mjs'),
  join(PANEL_DIR, 'cli-statusline.mjs'),
  join(PANEL_DIR, 'trajectory-metrics.mjs'),
  join(PANEL_DIR, 'app.js'),
];

for (const dir of ['backend', 'shared', 'scripts', 'test']) {
  const absDir = join(PANEL_DIR, dir);
  const entries = readdirSync(absDir, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name)
  );
  for (const entry of entries) {
    if (entry.isFile() && /\.(?:mjs|js)$/.test(entry.name)) {
      files.push(join(absDir, entry.name));
    }
  }
}

for (const file of files) {
  execFileSync(process.execPath, ['--check', file], { stdio: 'inherit' });
}
