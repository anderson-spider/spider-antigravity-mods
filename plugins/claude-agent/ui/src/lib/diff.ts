export type DiffLine = {
  type: 'ctx' | 'del' | 'add'
  oldLine?: number
  newLine?: number
  text: string
}

const MAX_LCS_CELLS = 40_000

/** Computes a compact unified line diff for ACP `{ oldText, newText }` tool call diffs. */
export function computeLineDiff(oldText: string | undefined, newText: string): DiffLine[] {
  const oldLines = oldText !== undefined ? oldText.split('\n') : []
  const newLines = newText.split('\n')

  if (oldLines.length === 0) {
    return newLines.map((text, idx) => ({ type: 'add', newLine: idx + 1, text }))
  }
  if (newLines.length === 0) {
    return oldLines.map((text, idx) => ({ type: 'del', oldLine: idx + 1, text }))
  }

  // Trim common prefix & suffix first so large files with small edits stay O(editedLines).
  let prefix = 0
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) {
    prefix++
  }

  let suffix = 0
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) {
    suffix++
  }

  const midOld = oldLines.slice(prefix, oldLines.length - suffix)
  const midNew = newLines.slice(prefix, newLines.length - suffix)

  const out: DiffLine[] = []
  const ctxStart = Math.max(0, prefix - 3)
  if (ctxStart > 0) {
    // Keep at most 3 leading context lines
  }
  for (let i = ctxStart; i < prefix; i++) {
    out.push({ type: 'ctx', oldLine: i + 1, newLine: i + 1, text: oldLines[i]! })
  }

  if (midOld.length * midNew.length <= MAX_LCS_CELLS) {
    const m = midOld.length
    const n = midNew.length
    const dp = new Int32Array((m + 1) * (n + 1))
    for (let i = m - 1; i >= 0; i--) {
      for (let j = n - 1; j >= 0; j--) {
        if (midOld[i] === midNew[j]) {
          dp[i * (n + 1) + j] = 1 + dp[(i + 1) * (n + 1) + (j + 1)]!
        } else {
          const down = dp[(i + 1) * (n + 1) + j]!
          const right = dp[i * (n + 1) + (j + 1)]!
          dp[i * (n + 1) + j] = down >= right ? down : right
        }
      }
    }

    let i = 0
    let j = 0
    while (i < m && j < n) {
      if (midOld[i] === midNew[j]) {
        out.push({ type: 'ctx', oldLine: prefix + i + 1, newLine: prefix + j + 1, text: midOld[i]! })
        i++
        j++
      } else if (dp[(i + 1) * (n + 1) + j]! >= dp[i * (n + 1) + (j + 1)]!) {
        out.push({ type: 'del', oldLine: prefix + i + 1, text: midOld[i]! })
        i++
      } else {
        out.push({ type: 'add', newLine: prefix + j + 1, text: midNew[j]! })
        j++
      }
    }
    while (i < m) {
      out.push({ type: 'del', oldLine: prefix + i + 1, text: midOld[i]! })
      i++
    }
    while (j < n) {
      out.push({ type: 'add', newLine: prefix + j + 1, text: midNew[j]! })
      j++
    }
  } else {
    for (let i = 0; i < midOld.length; i++) {
      out.push({ type: 'del', oldLine: prefix + i + 1, text: midOld[i]! })
    }
    for (let j = 0; j < midNew.length; j++) {
      out.push({ type: 'add', newLine: prefix + j + 1, text: midNew[j]! })
    }
  }

  const tailCount = Math.min(3, suffix)
  for (let k = 0; k < tailCount; k++) {
    const oldIdx = oldLines.length - suffix + k
    const newIdx = newLines.length - suffix + k
    out.push({ type: 'ctx', oldLine: oldIdx + 1, newLine: newIdx + 1, text: oldLines[oldIdx]! })
  }

  return out
}
