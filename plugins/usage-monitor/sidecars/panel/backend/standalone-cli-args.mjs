/**
 * @fileoverview Standalone CLI argument parser, help formatter, and pre-import environment overrides.
 */

export function parseStandaloneCliArgs(argv = [], env = process.env, { defaultPort = 8787 } = {}) {
  const out = {
    help: false,
    standaloneFlag: false,
    host: String(env.USAGE_MONITOR_STANDALONE_HOST || '127.0.0.1').trim() || '127.0.0.1',
    port: null,
    portExplicit: false,
    token: String(env.USAGE_MONITOR_STANDALONE_TOKEN || '').trim(),
    lsAddr: String(env.ANTIGRAVITY_LS_ADDRESS || '').trim(),
    csrfToken: String(env.ANTIGRAVITY_CSRF_TOKEN || env.ANTIGRAVITY_SERVER_CSRF_TOKEN || '').trim(),
    dataDir: String(env.USAGE_MONITOR_DATA_DIR || '').trim(),
    appDataDir: String(env.USAGE_MONITOR_APP_DATA_DIR || env.ANTIGRAVITY_APP_DATA_DIR || '').trim(),
    geminiDir: String(env.ANTIGRAVITY_GEMINI_DIR || '').trim(),
  };

  if (env.USAGE_MONITOR_STANDALONE_PORT !== undefined && String(env.USAGE_MONITOR_STANDALONE_PORT).trim() !== '') {
    const envPort = Number(env.USAGE_MONITOR_STANDALONE_PORT);
    if (Number.isInteger(envPort) && envPort >= 0 && envPort <= 65535) {
      out.port = envPort;
      out.portExplicit = true;
    }
  }

  const args = Array.isArray(argv) ? argv : [];
  for (let i = 0; i < args.length; i++) {
    const raw = String(args[i] || '');
    if (!raw) continue;
    if (raw === '--help' || raw === '-h') {
      out.help = true;
      continue;
    }
    if (raw === '--standalone') {
      out.standaloneFlag = true;
      continue;
    }

    const eqIdx = raw.indexOf('=');
    const flag = eqIdx > 0 ? raw.slice(0, eqIdx) : raw;
    const readVal = () => {
      if (eqIdx > 0) return raw.slice(eqIdx + 1);
      if (i + 1 < args.length) {
        i += 1;
        return String(args[i] || '');
      }
      return '';
    };

    if (flag === '--port' || flag === '-p') {
      const num = Number(readVal().trim());
      if (!Number.isInteger(num) || num < 0 || num > 65535) {
        throw new Error('Invalid --port value (expected 0..65535)');
      }
      out.port = num;
      out.portExplicit = true;
    } else if (flag === '--host' || flag === '-H') {
      const val = readVal().trim();
      if (!val) throw new Error('Missing value for --host');
      out.host = val;
    } else if (flag === '--token') {
      out.token = readVal().trim();
    } else if (flag === '--ls-addr') {
      out.lsAddr = readVal().trim();
    } else if (flag === '--csrf-token') {
      out.csrfToken = readVal().trim();
    } else if (flag === '--data-dir') {
      out.dataDir = readVal().trim();
    } else if (flag === '--app-data-dir') {
      out.appDataDir = readVal().trim();
    } else if (flag === '--gemini-dir') {
      out.geminiDir = readVal().trim();
    }
  }

  if (out.port === null) {
    out.port = defaultPort;
  }
  return out;
}

export function applyStandaloneEnvOverrides(parsed, env = process.env) {
  if (!parsed || !env) return;
  if (parsed.dataDir) env.USAGE_MONITOR_DATA_DIR = parsed.dataDir;
  if (parsed.appDataDir) env.USAGE_MONITOR_APP_DATA_DIR = parsed.appDataDir;
  if (parsed.geminiDir) env.ANTIGRAVITY_GEMINI_DIR = parsed.geminiDir;
  if (parsed.lsAddr) env.ANTIGRAVITY_LS_ADDRESS = parsed.lsAddr;
  if (parsed.csrfToken) env.ANTIGRAVITY_CSRF_TOKEN = parsed.csrfToken;
}

export function formatStandaloneHelpText() {
  return [
    'Antigravity Usage Monitor — Standalone Web Server (CLI / Remote Mode)',
    '',
    'Usage:',
    '  node sidecars/panel/standalone.mjs [options]',
    '',
    'Options:',
    '  -p, --port <port>          HTTP listen port (default: 8787; 0 picks a random port)',
    '  -H, --host <host>          Bind address (default: 127.0.0.1)',
    '      --token <secret>       Access token (required when --host is non-loopback)',
    '      --ls-addr <host:port>  Explicit Language Server / Hub address override',
    '      --csrf-token <token>   Explicit Language Server CSRF token override',
    '      --app-data-dir <dir>   Additional product data dir (e.g. ~/.gemini/antigravity-cli)',
    '      --data-dir <dir>       Persistent cache & settings storage directory',
    '  -h, --help                 Show this help message',
    '',
    'Examples:',
    '  # 1) Recommended for headless Linux servers (use with ssh -L 8787:127.0.0.1:8787 user@host):',
    '  node sidecars/panel/standalone.mjs --port 8787',
    '',
    '  # 2) Direct LAN / reverse-proxy bind (requires --token):',
    '  node sidecars/panel/standalone.mjs --host 0.0.0.0 --port 8787 --token <your-secret>',
  ].join('\n');
}
