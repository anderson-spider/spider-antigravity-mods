// Pure path-compressed file tree builder and path helpers for the Code Diff sidebar (zero runtime deps).
import type { DiffFile } from '../types.ts'

export type SplitPath = {
  dir: string
  name: string
}

export function splitFilePath(path: string): SplitPath {
  const idx = path.lastIndexOf('/')
  if (idx < 0) return { dir: '', name: path }
  return { dir: path.slice(0, idx + 1), name: path.slice(idx + 1) }
}

export type DiffTreeDirNode = {
  kind: 'dir'
  /** Full path from repo root (no leading/trailing slash), used as collapse key. */
  path: string
  /** Compressed display label (e.g. ".claude/skills/template-mr"). */
  name: string
  children: DiffTreeNode[]
  fileCount: number
}

export type DiffTreeFileNode = {
  kind: 'file'
  name: string
  file: DiffFile
}

export type DiffTreeNode = DiffTreeDirNode | DiffTreeFileNode

type MutableDir = {
  name: string
  path: string
  dirs: Map<string, MutableDir>
  files: DiffTreeFileNode[]
}

function createDir(name: string, path: string): MutableDir {
  return { name, path, dirs: new Map(), files: [] }
}

function finalizeDir(dir: MutableDir): DiffTreeDirNode {
  // Path compression: merge single-child directory chains that have no direct files
  let cur = dir
  let label = cur.name
  while (cur.files.length === 0 && cur.dirs.size === 1) {
    const onlyChild = [...cur.dirs.values()][0]!
    label = label ? `${label}/${onlyChild.name}` : onlyChild.name
    cur = onlyChild
  }

  const childDirs = [...cur.dirs.values()]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(finalizeDir)

  const childFiles = [...cur.files].sort((a, b) => a.name.localeCompare(b.name))
  const children: DiffTreeNode[] = [...childDirs, ...childFiles]
  const fileCount = childFiles.length + childDirs.reduce((sum, d) => sum + d.fileCount, 0)

  return {
    kind: 'dir',
    path: cur.path,
    name: label,
    children,
    fileCount,
  }
}

/**
 * Builds a path-compressed directory tree from changed diff files so files sharing
 * the same basename (e.g. multiple SKILL.md or README.md files) are always unambiguous.
 */
export function buildDiffFileTree(files: readonly DiffFile[]): DiffTreeNode[] {
  const root = createDir('', '')

  for (const file of files) {
    const parts = file.newPath.split('/').filter(Boolean)
    if (parts.length <= 1) {
      root.files.push({ kind: 'file', name: file.newPath, file })
      continue
    }
    let cur = root
    for (let i = 0; i < parts.length - 1; i++) {
      const seg = parts[i]!
      const nextPath = cur.path ? `${cur.path}/${seg}` : seg
      let child = cur.dirs.get(seg)
      if (!child) {
        child = createDir(seg, nextPath)
        cur.dirs.set(seg, child)
      }
      cur = child
    }
    cur.files.push({ kind: 'file', name: parts[parts.length - 1]!, file })
  }

  const topDirs = [...root.dirs.values()]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(finalizeDir)

  const topFiles = [...root.files].sort((a, b) => a.name.localeCompare(b.name))
  return [...topDirs, ...topFiles]
}

export function filterDiffFiles(files: readonly DiffFile[], query: string): DiffFile[] {
  const q = query.trim().toLowerCase()
  if (!q) return [...files]
  return files.filter((f) => f.newPath.toLowerCase().includes(q) || f.oldPath.toLowerCase().includes(q))
}
