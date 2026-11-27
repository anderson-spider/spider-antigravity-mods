// Central security policy: fail-closed 3-tier workspace jail, symlink escape defense,
// portable secret-file denylist, `.git` write protection, and edit kill-switch.
import { existsSync, promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AuditLog } from './audit.ts'
import { redactSecrets } from './redact.ts'

export const ENV_WORKSPACE_ROOTS = 'BATCH_TOOLS_WORKSPACE_ROOTS'
export const ENV_EXTRA_DENY_GLOBS = 'BATCH_TOOLS_EXTRA_DENY_GLOBS'
export const ENV_ALLOW_EDITS = 'BATCH_TOOLS_ALLOW_EDITS'

const DEFAULT_PLUGIN_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
)

const ALLOWED_ENV_TEMPLATES = new Set([
  '.env.example',
  '.env.sample',
  '.env.template',
])

const SECRET_DIR_SEGMENTS = new Set(['secrets', '.secrets'])

const SECRET_EXACT_BASENAMES = new Set([
  '.env',
  'id_rsa',
  'id_ed25519',
  '.netrc',
  '.npmrc',
  '.pypirc',
])

const SECRET_EXTENSIONS = new Set(['.pem', '.key', '.p12', '.pfx', '.jks'])

const RG_BUILTIN_DENY_PATTERNS: readonly string[] = [
  '**/.env',
  '**/.env.local',
  '**/.env.local.*',
  '**/.env.development',
  '**/.env.development.*',
  '**/.env.production',
  '**/.env.production.*',
  '**/.env.staging',
  '**/.env.staging.*',
  '**/.env.test',
  '**/.env.test.*',
  '**/.env.secret*',
  '**/secrets/**',
  '**/.secrets/**',
  '**/*.pem',
  '**/*.key',
  '**/*.p12',
  '**/*.pfx',
  '**/*.jks',
  '**/id_rsa',
  '**/id_ed25519',
  '**/.netrc',
  '**/.npmrc',
  '**/.pypirc',
]

export type PolicyDenyReason =
  | 'no_workspace_roots'
  | 'invalid_path'
  | 'tilde_forbidden'
  | 'outside_workspace'
  | 'secret_file'
  | 'git_internal'
  | 'symlink_forbidden'
  | 'edits_disabled'

export type PolicyDecision<T> =
  | { ok: true; value: T }
  | { ok: false; reason: PolicyDenyReason; error: string }

export interface ResolvedTarget {
  absPath: string
  canonicalPath: string
  root: string
  relPath: string
}

export interface PolicyOptions {
  mcpRoots?: readonly string[]
  env?: NodeJS.ProcessEnv
  processCwd?: () => string
  pluginRoot?: string
  platform?: NodeJS.Platform
  audit?: AuditLog
}

export interface PolicyGuard {
  getRoots(): Promise<PolicyDecision<readonly string[]>>
  resolveCwd(requestedCwd?: string, toolName?: string): Promise<PolicyDecision<{ cwd: string; root: string }>>
  authorizeRead(targetPath: string, baseCwd?: string, toolName?: string): Promise<PolicyDecision<ResolvedTarget>>
  authorizeWrite(targetPath: string, baseCwd?: string, toolName?: string): Promise<PolicyDecision<ResolvedTarget>>
  isAllowedOutputPath(targetPath: string, baseCwd: string): Promise<boolean>
  isSecretPath(filePath: string): boolean
  isGitInternalPath(filePath: string): boolean
  isEditAllowed(): boolean
  getRgDenyGlobs(): string[]
  getExtraDenyGlobs(): readonly string[]
  sanitizePathForAudit(targetPath: string, roots?: readonly string[]): string
}

export function isTildePath(inputPath: string): boolean {
  const trimmed = inputPath.trim()
  return trimmed === '~' || trimmed.startsWith('~/') || trimmed.startsWith('~\\')
}

export function isEditAllowedFromEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[ENV_ALLOW_EDITS]
  if (typeof raw !== 'string') return true
  const normalized = raw.trim().toLowerCase()
  return normalized !== 'false' && normalized !== '0'
}

export function parseExtraDenyGlobs(raw: string | undefined): string[] {
  if (typeof raw !== 'string' || !raw.trim()) return []
  return raw
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
}

/**
 * Returns true if any path segment targets Git internal metadata (`.git`),
 * including case-insensitive mounts and Win32 trailing dots/spaces or ADS streams.
 */
export function isGitInternalPath(
  filePath: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const segments = filePath.split(/[\\/]+/)
  for (const rawSeg of segments) {
    if (!rawSeg) continue
    let seg = rawSeg.toLowerCase()
    if (platform === 'win32') {
      seg = seg
        .replace(/[. ]+$/, '')
        .replace(/:.*$/, '')
        .replace(/[. ]+$/, '')
    }
    if (seg === '.git') return true
  }
  return false
}

/**
 * Portable built-in secret-file denylist evaluated against path segments and basenames.
 * Allows `.env.example`, `.env.sample`, and `.env.template`.
 */
export function isBuiltinSecretPath(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
  if (!normalized) return false
  const segments = normalized.split('/').filter(Boolean)
  for (const seg of segments) {
    if (SECRET_DIR_SEGMENTS.has(seg.toLowerCase())) {
      return true
    }
  }
  const base = segments[segments.length - 1]!.toLowerCase()
  if (SECRET_EXACT_BASENAMES.has(base)) return true
  if (base.startsWith('.env.') && !ALLOWED_ENV_TEMPLATES.has(base)) return true
  for (const ext of SECRET_EXTENSIONS) {
    if (base.endsWith(ext) && base.length > ext.length) return true
  }
  return false
}

function compileSimpleGlob(pattern: string): { re: RegExp; hasSlash: boolean } | null {
  const cleaned = pattern
    .trim()
    .replace(/^!+/, '')
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/\*{3,}/g, '**')
    .replace(/(?:\*\*\/)+/g, '**/')
  if (!cleaned) return null
  const hasSlash = cleaned.includes('/')
  let body = ''
  for (let i = 0; i < cleaned.length; ) {
    const ch = cleaned[i]!
    if (ch === '*') {
      if (cleaned[i + 1] === '*') {
        if (cleaned[i + 2] === '/') {
          body += '(?:.*/)?'
          i += 3
        } else {
          body += '.*'
          i += 2
        }
      } else {
        body += '[^/]*'
        i += 1
      }
    } else if (ch === '?') {
      body += '[^/]'
      i += 1
    } else if ('.+^$()|[]{}' .includes(ch) || ch === '\\') {
      body += `\\${ch}`
      i += 1
    } else {
      body += ch
      i += 1
    }
  }
  try {
    return { re: new RegExp(`^${body}$`, 'i'), hasSlash }
  } catch {
    return null
  }
}

export function getRgDenyGlobs(extraDenyGlobs: readonly string[] = []): string[] {
  const flags = RG_BUILTIN_DENY_PATTERNS.map((pattern) => `--glob=!${pattern}`)
  for (const raw of extraDenyGlobs) {
    const cleaned = raw.trim().replace(/^!+/, '').replace(/\\/g, '/')
    if (!cleaned) continue
    flags.push(`--glob=!${cleaned}`)
    if (!cleaned.includes('/')) {
      flags.push(`--glob=!**/${cleaned}`)
    }
  }
  return flags
}

export function isPathInsideRoot(
  candidate: string,
  root: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const caseInsensitive = platform === 'darwin' || platform === 'win32'
  const normCandidate = caseInsensitive ? candidate.toLowerCase() : candidate
  const normRoot = caseInsensitive ? root.toLowerCase() : root
  const rel = path.relative(normRoot, normCandidate)
  return (
    rel === '' ||
    (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel))
  )
}

function isSameDir(a: string, b: string, platform: NodeJS.Platform): boolean {
  const caseInsensitive = platform === 'darwin' || platform === 'win32'
  return caseInsensitive ? a.toLowerCase() === b.toLowerCase() : a === b
}

function isInstalledPluginPath(dirPath: string): boolean {
  const posix = dirPath.replace(/\\/g, '/')
  return /(?:^|\/)(?:\.gemini\/(?:config\/|antigravity[^/]*\/)?plugins|\.agents\/plugins)\/[^/]+(?:\/|$)/i.test(
    posix,
  )
}

/**
 * Canonicalizes `absPath` using `fs.realpath`, walking up to the nearest
 * existing ancestor when the target does not yet exist. If `absPath` is a
 * dangling symlink, resolves the symlink target against its parent directory
 * and canonicalizes that target so escapes are caught reliably.
 */
export async function canonicalizePath(absPath: string): Promise<string> {
  const resolved = path.resolve(absPath)
  try {
    return await fs.realpath(resolved)
  } catch {
    try {
      const lst = await fs.lstat(resolved)
      if (lst.isSymbolicLink()) {
        const linkTarget = await fs.readlink(resolved)
        const parentCanon = await canonicalizePath(path.dirname(resolved))
        const targetAbs = path.resolve(parentCanon, linkTarget)
        if (targetAbs !== resolved) {
          return canonicalizePath(targetAbs)
        }
      }
    } catch {
      // Target does not exist; walk up to nearest existing ancestor below.
    }

    const trailing: string[] = []
    let current = resolved
    while (true) {
      const parent = path.dirname(current)
      if (parent === current) return resolved
      trailing.push(path.basename(current))
      current = parent
      try {
        const realAncestor = await fs.realpath(current)
        return path.join(realAncestor, ...trailing.reverse())
      } catch {
        // Keep walking up.
      }
    }
  }
}

async function canonicalizeExistingDir(dirPath: string): Promise<string | null> {
  const trimmed = dirPath.trim()
  if (!trimmed || isTildePath(trimmed)) return null
  const resolved = path.resolve(trimmed)
  try {
    const canon = await fs.realpath(resolved)
    const st = await fs.stat(canon)
    return st.isDirectory() ? canon : null
  } catch {
    return null
  }
}

async function collectHomeDirs(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): Promise<string[]> {
  const candidates: string[] = []
  const driveHome =
    platform === 'win32' &&
    typeof env.HOMEDRIVE === 'string' &&
    typeof env.HOMEPATH === 'string' &&
    env.HOMEDRIVE.trim() &&
    env.HOMEPATH.trim()
      ? `${env.HOMEDRIVE.trim()}${env.HOMEPATH.trim()}`
      : ''
  for (const h of [env.HOME, env.USERPROFILE, driveHome]) {
    if (typeof h === 'string' && h.trim()) candidates.push(h.trim())
  }
  if (env === process.env) {
    try {
      const osHome = os.homedir()
      if (osHome) candidates.push(osHome)
    } catch {
      // Ignore if homedir is unavailable.
    }
  }
  const out: string[] = []
  for (const c of candidates) {
    const canon = await canonicalizeExistingDir(c)
    out.push(canon ?? path.resolve(c))
  }
  return out
}

async function isUnsafeFallbackCwd(
  canonCwd: string,
  env: NodeJS.ProcessEnv,
  pluginRoot: string,
  platform: NodeJS.Platform,
): Promise<string | null> {
  if (path.parse(canonCwd).root === canonCwd) {
    return 'the filesystem root'
  }
  const homes = await collectHomeDirs(env, platform)
  for (const home of homes) {
    if (isSameDir(canonCwd, home, platform)) {
      return 'the home directory'
    }
  }
  for (const envRoot of [env.PLUGIN_ROOT, env.AGY_PLUGIN_ROOT]) {
    if (typeof envRoot === 'string' && envRoot.trim()) {
      const canonEnvRoot = (await canonicalizeExistingDir(envRoot)) ?? path.resolve(envRoot.trim())
      if (isPathInsideRoot(canonCwd, canonEnvRoot, platform)) {
        return 'the plugin directory'
      }
    }
  }
  const canonPluginRoot = (await canonicalizeExistingDir(pluginRoot)) ?? path.resolve(pluginRoot)
  if (isPathInsideRoot(canonCwd, canonPluginRoot, platform)) {
    const looksLikePlugin = existsSync(path.join(canonPluginRoot, 'plugin.json'))
    if (looksLikePlugin || isInstalledPluginPath(canonPluginRoot)) {
      return 'the plugin directory'
    }
  }
  if (isInstalledPluginPath(canonCwd)) {
    return 'an installed plugin directory'
  }
  return null
}

async function hasSymlinkComponentBelowRoot(
  absPath: string,
  root: string,
): Promise<boolean> {
  const rel = path.relative(root, absPath)
  if (!rel || rel === '.') return false
  const segments = rel.split(/[\\/]+/).filter(Boolean)
  let current = root
  for (const seg of segments) {
    current = path.join(current, seg)
    try {
      const lst = await fs.lstat(current)
      if (lst.isSymbolicLink()) return true
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
        // Non-existent suffix cannot be a symlink.
        break
      }
      return true
    }
  }
  return false
}

export function createPolicyGuard(options: PolicyOptions = {}): PolicyGuard {
  const env = options.env ?? process.env
  const getProcessCwd = options.processCwd ?? (() => process.cwd())
  const pluginRoot = options.pluginRoot ?? DEFAULT_PLUGIN_ROOT
  const platform = options.platform ?? process.platform
  const audit = options.audit

  const extraDenyGlobs = parseExtraDenyGlobs(env[ENV_EXTRA_DENY_GLOBS])
  const compiledExtraGlobs = extraDenyGlobs
    .map(compileSimpleGlob)
    .filter((entry): entry is { re: RegExp; hasSlash: boolean } => entry !== null)

  let cachedRootsPromise: Promise<PolicyDecision<readonly string[]>> | null = null

  function matchesExtraDenyGlobs(relPosix: string): boolean {
    if (compiledExtraGlobs.length === 0) return false
    const clean = relPosix.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '')
    if (!clean) return false
    const base = path.posix.basename(clean)
    for (const { re, hasSlash } of compiledExtraGlobs) {
      if (re.test(clean)) return true
      if (!hasSlash && re.test(base)) return true
    }
    return false
  }

  function isSecretRelativePath(relPath: string): boolean {
    return isBuiltinSecretPath(relPath) || matchesExtraDenyGlobs(relPath)
  }

  function sanitizePathForAudit(targetPath: string, roots?: readonly string[]): string {
    const trimmed = targetPath.trim()
    if (!trimmed) return '(empty)'
    if (roots && roots.length > 0 && path.isAbsolute(trimmed)) {
      for (const root of roots) {
        if (isPathInsideRoot(trimmed, root, platform)) {
          const rel = path.relative(root, trimmed).split(path.sep).join('/')
          return redactSecrets(rel || '.')
        }
      }
    }
    return redactSecrets(trimmed)
  }

  function deny<T>(
    reason: PolicyDenyReason,
    error: string,
    toolName?: string,
    targetPath?: string,
    roots?: readonly string[],
  ): PolicyDecision<T> {
    if (audit && toolName) {
      audit.record({
        tool: toolName,
        status: 'blocked',
        reason,
        ...(targetPath !== undefined
          ? { sanitizedPath: sanitizePathForAudit(targetPath, roots) }
          : {}),
      })
    }
    return { ok: false, reason, error }
  }

  async function resolveRootsUncached(): Promise<PolicyDecision<readonly string[]>> {
    // Tier 1: MCP roots/list
    if (options.mcpRoots && options.mcpRoots.length > 0) {
      const resolved: string[] = []
      const seen = new Set<string>()
      for (const raw of options.mcpRoots) {
        const canon = await canonicalizeExistingDir(raw)
        if (!canon) continue
        const key = platform === 'darwin' || platform === 'win32' ? canon.toLowerCase() : canon
        if (!seen.has(key)) {
          seen.add(key)
          resolved.push(canon)
        }
      }
      if (resolved.length > 0) {
        return { ok: true, value: resolved }
      }
      return {
        ok: false,
        reason: 'no_workspace_roots',
        error: 'Access denied: MCP client reported no accessible workspace root directories.',
      }
    }

    // Tier 2: Optional BATCH_TOOLS_WORKSPACE_ROOTS env var
    const rawEnvRoots = env[ENV_WORKSPACE_ROOTS]
    if (typeof rawEnvRoots === 'string' && rawEnvRoots.trim().length > 0) {
      const parts = rawEnvRoots
        .split(path.delimiter)
        .map((s) => s.trim())
        .filter(Boolean)
      const resolved: string[] = []
      const seen = new Set<string>()
      for (const part of parts) {
        const canon = await canonicalizeExistingDir(part)
        if (!canon) continue
        const key = platform === 'darwin' || platform === 'win32' ? canon.toLowerCase() : canon
        if (!seen.has(key)) {
          seen.add(key)
          resolved.push(canon)
        }
      }
      if (resolved.length > 0) {
        return { ok: true, value: resolved }
      }
      return {
        ok: false,
        reason: 'no_workspace_roots',
        error: `Access denied: ${ENV_WORKSPACE_ROOTS} did not resolve to any valid workspace directory.`,
      }
    }

    // Tier 3: Safe process.cwd() fallback (fail-closed for /, $HOME, plugin dir)
    let rawCwd: string
    try {
      rawCwd = getProcessCwd()
    } catch {
      return {
        ok: false,
        reason: 'no_workspace_roots',
        error: `Access denied: could not determine workspace root. Set ${ENV_WORKSPACE_ROOTS} or use a host supporting MCP roots/list.`,
      }
    }
    const canonCwd = await canonicalizeExistingDir(rawCwd)
    if (!canonCwd) {
      return {
        ok: false,
        reason: 'no_workspace_roots',
        error: `Access denied: server working directory is not accessible. Set ${ENV_WORKSPACE_ROOTS} or use a host supporting MCP roots/list.`,
      }
    }
    const unsafePlace = await isUnsafeFallbackCwd(canonCwd, env, pluginRoot, platform)
    if (unsafePlace) {
      return {
        ok: false,
        reason: 'no_workspace_roots',
        error: `Access denied: no workspace roots reported via MCP roots/list and process.cwd() is ${unsafePlace}. Configure ${ENV_WORKSPACE_ROOTS} to allow a workspace.`,
      }
    }
    return { ok: true, value: [canonCwd] }
  }

  function getRoots(): Promise<PolicyDecision<readonly string[]>> {
    if (!cachedRootsPromise) {
      cachedRootsPromise = resolveRootsUncached()
    }
    return cachedRootsPromise
  }

  function findContainingRoot(
    candidate: string,
    roots: readonly string[],
  ): string | null {
    for (const root of roots) {
      if (isPathInsideRoot(candidate, root, platform)) {
        return root
      }
    }
    return null
  }

  async function resolveCwd(
    requestedCwd?: string,
    toolName?: string,
  ): Promise<PolicyDecision<{ cwd: string; root: string }>> {
    const rootsRes = await getRoots()
    if (!rootsRes.ok) {
      return deny(rootsRes.reason, rootsRes.error, toolName, requestedCwd)
    }
    const roots = rootsRes.value
    const defaultRoot = roots[0]!

    if (requestedCwd === undefined || requestedCwd.trim() === '') {
      return { ok: true, value: { cwd: defaultRoot, root: defaultRoot } }
    }
    if (typeof requestedCwd !== 'string') {
      return deny('invalid_path', 'Invalid cwd: must be a string path.', toolName)
    }
    const trimmed = requestedCwd.trim()
    if (isTildePath(trimmed)) {
      return deny(
        'tilde_forbidden',
        'Access denied: home-directory (~) paths are forbidden.',
        toolName,
        trimmed,
        roots,
      )
    }

    const absCwd = path.resolve(defaultRoot, trimmed)
    const canonCwd = await canonicalizePath(absCwd)
    const matchedRoot = findContainingRoot(canonCwd, roots)
    if (!matchedRoot) {
      return deny(
        'outside_workspace',
        `Access denied: cwd '${sanitizePathForAudit(trimmed, roots)}' resolves outside allowed workspace roots.`,
        toolName,
        trimmed,
        roots,
      )
    }
    try {
      const st = await fs.stat(canonCwd)
      if (!st.isDirectory()) {
        return deny(
          'invalid_path',
          `Invalid cwd: '${sanitizePathForAudit(trimmed, roots)}' is not a directory.`,
          toolName,
          trimmed,
          roots,
        )
      }
    } catch {
      return deny(
        'invalid_path',
        `Invalid cwd: directory does not exist (${sanitizePathForAudit(trimmed, roots)}).`,
        toolName,
        trimmed,
        roots,
      )
    }
    return { ok: true, value: { cwd: canonCwd, root: matchedRoot } }
  }

  async function authorizeRead(
    targetPath: string,
    baseCwd?: string,
    toolName?: string,
  ): Promise<PolicyDecision<ResolvedTarget>> {
    if (typeof targetPath !== 'string' || !targetPath.trim()) {
      return deny('invalid_path', 'Invalid path: must be a non-empty string.', toolName)
    }
    const trimmed = targetPath.trim()
    if (isTildePath(trimmed)) {
      return deny(
        'tilde_forbidden',
        'Access denied: home-directory (~) paths are forbidden.',
        toolName,
        trimmed,
      )
    }

    const cwdRes = await resolveCwd(baseCwd, toolName)
    if (!cwdRes.ok) return cwdRes
    const rootsRes = await getRoots()
    if (!rootsRes.ok) return rootsRes
    const roots = rootsRes.value

    const absPath = path.resolve(cwdRes.value.cwd, trimmed)
    const canonicalPath = await canonicalizePath(absPath)
    const matchedRoot = findContainingRoot(canonicalPath, roots)
    if (!matchedRoot) {
      return deny(
        'outside_workspace',
        `Access denied: '${sanitizePathForAudit(trimmed, roots)}' escapes allowed workspace roots.`,
        toolName,
        trimmed,
        roots,
      )
    }

    const relCanonical = path.relative(matchedRoot, canonicalPath).split(path.sep).join('/')
    const logicalRoot = findContainingRoot(absPath, roots)
    const relLogical = logicalRoot
      ? path.relative(logicalRoot, absPath).split(path.sep).join('/')
      : trimmed.replace(/\\/g, '/')

    if (isSecretRelativePath(relLogical) || isSecretRelativePath(relCanonical)) {
      return deny(
        'secret_file',
        `Access denied: '${relLogical || path.basename(absPath)}' matches the secret-file denylist.`,
        toolName,
        relLogical || trimmed,
        roots,
      )
    }

    return {
      ok: true,
      value: {
        absPath,
        canonicalPath,
        root: matchedRoot,
        relPath: relCanonical || path.basename(canonicalPath),
      },
    }
  }

  async function authorizeWrite(
    targetPath: string,
    baseCwd?: string,
    toolName?: string,
  ): Promise<PolicyDecision<ResolvedTarget>> {
    if (!isEditAllowedFromEnv(env)) {
      return deny(
        'edits_disabled',
        `Write access denied: edits are disabled by ${ENV_ALLOW_EDITS}=false.`,
        toolName,
        targetPath,
      )
    }
    if (typeof targetPath !== 'string' || !targetPath.trim()) {
      return deny('invalid_path', 'Invalid path: must be a non-empty string.', toolName)
    }
    const trimmed = targetPath.trim()
    if (isTildePath(trimmed)) {
      return deny(
        'tilde_forbidden',
        'Access denied: home-directory (~) paths are forbidden.',
        toolName,
        trimmed,
      )
    }

    const cwdRes = await resolveCwd(baseCwd, toolName)
    if (!cwdRes.ok) return cwdRes
    const rootsRes = await getRoots()
    if (!rootsRes.ok) return rootsRes
    const roots = rootsRes.value

    const absPath = path.resolve(cwdRes.value.cwd, trimmed)
    const canonicalPath = await canonicalizePath(absPath)
    const matchedRoot = findContainingRoot(canonicalPath, roots)
    const logicalRoot = findContainingRoot(absPath, roots)
    if (!matchedRoot || !logicalRoot) {
      return deny(
        'outside_workspace',
        `Access denied: '${sanitizePathForAudit(trimmed, roots)}' escapes allowed workspace roots.`,
        toolName,
        trimmed,
        roots,
      )
    }

    // Reject writing to or through any symlink inside the workspace root.
    if (await hasSymlinkComponentBelowRoot(absPath, logicalRoot)) {
      return deny(
        'symlink_forbidden',
        `Write access denied: '${sanitizePathForAudit(absPath, roots)}' targets or traverses a symlink.`,
        toolName,
        absPath,
        roots,
      )
    }

    const relLogical = path.relative(logicalRoot, absPath).split(path.sep).join('/')
    const relCanonical = path.relative(matchedRoot, canonicalPath).split(path.sep).join('/')

    if (
      isGitInternalPath(relLogical, platform) ||
      isGitInternalPath(relCanonical, platform) ||
      isGitInternalPath(absPath, platform) ||
      isGitInternalPath(canonicalPath, platform)
    ) {
      return deny(
        'git_internal',
        `Write access denied: refusing to modify Git internal metadata path (.git) at '${relLogical}'.`,
        toolName,
        relLogical,
        roots,
      )
    }

    if (isSecretRelativePath(relLogical) || isSecretRelativePath(relCanonical)) {
      return deny(
        'secret_file',
        `Write access denied: '${relLogical}' matches the secret-file denylist.`,
        toolName,
        relLogical,
        roots,
      )
    }

    return {
      ok: true,
      value: {
        absPath,
        canonicalPath,
        root: matchedRoot,
        relPath: relCanonical || path.basename(canonicalPath),
      },
    }
  }

  async function isAllowedOutputPath(
    targetPath: string,
    baseCwd: string,
  ): Promise<boolean> {
    if (!targetPath || isTildePath(targetPath)) return false
    const rootsRes = await getRoots()
    if (!rootsRes.ok) return false
    const roots = rootsRes.value
    const canonBase = await canonicalizePath(baseCwd)
    const absPath = path.resolve(canonBase, targetPath)
    const canonicalPath = await canonicalizePath(absPath)
    const matchedRoot = findContainingRoot(canonicalPath, roots)
    if (!matchedRoot) return false
    const relCanonical = path.relative(matchedRoot, canonicalPath).split(path.sep).join('/')
    if (isSecretRelativePath(relCanonical)) return false
    const logicalRoot = findContainingRoot(absPath, roots)
    if (logicalRoot) {
      const relLogical = path.relative(logicalRoot, absPath).split(path.sep).join('/')
      if (isSecretRelativePath(relLogical)) return false
    } else if (!path.isAbsolute(targetPath) && isSecretRelativePath(targetPath)) {
      return false
    }
    return true
  }

  return {
    getRoots,
    resolveCwd,
    authorizeRead,
    authorizeWrite,
    isAllowedOutputPath,
    isSecretPath: (filePath: string) => isSecretRelativePath(filePath),
    isGitInternalPath: (filePath: string) => isGitInternalPath(filePath, platform),
    isEditAllowed: () => isEditAllowedFromEnv(env),
    getRgDenyGlobs: () => getRgDenyGlobs(extraDenyGlobs),
    getExtraDenyGlobs: () => [...extraDenyGlobs],
    sanitizePathForAudit,
  }
}
