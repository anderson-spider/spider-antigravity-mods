/**
 * @fileoverview Validates JavaScript module syntax across all plugin backend,
 * shared, CLI, MCP, UI, script, and test modules using Node's native `--check` flag.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PLUGIN_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const files = [];

function collectJsFiles(absDir) {
  if (!existsSync(absDir)) return;
  const entries = readdirSync(absDir, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name)
  );
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (entry.name === 'dist' || entry.name === 'node_modules') continue;
      collectJsFiles(join(absDir, entry.name));
    } else if (entry.isFile() && /\.(?:mjs|js)$/.test(entry.name)) {
      files.push(join(absDir, entry.name));
    }
  }
}

for (const dir of ['backend', 'shared', 'cli', 'mcp', 'scripts', 'tests', 'ui']) {
  collectJsFiles(join(PLUGIN_DIR, dir));
}

for (const file of files) {
  execFileSync(process.execPath, ['--check', file], { stdio: 'inherit' });
}
