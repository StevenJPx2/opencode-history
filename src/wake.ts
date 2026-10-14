// Scoped wake.
//
// memo's `cover` tiles [0,T) with aligned power-of-two blocks and keeps a block
// whole only while it is small relative to its age, so detail decays with age.
// This is the same tiling, then one filter: a block stands in for the view only
// when everything it covers is in scope, and otherwise splits. A block whose
// summary has not been built splits too, so scoped wake never refuses where
// memo would.

import { GLOBAL, type Store } from "./store.ts"

export const THRESHOLD = 1

export interface Line {
  readonly text: string
  /** The block a summary line stands for, for splitting when budget remains. */
  readonly block?: [number, number]
}

export type Relevant = (i: number) => boolean

/** Aligned blocks covering [0,total), coarser as `alpha` grows. */
function coverBlocks(total: number, alpha: number): Array<[number, number]> {
  let root = 1
  while (root < total) root *= 2

  const out: Array<[number, number]> = []
  const stack: Array<[number, number]> = [[0, root]]

  while (stack.length > 0) {
    const [lo, hi] = stack.pop() as [number, number]
    if (lo >= total) continue

    const size = hi - lo

    if (size > 1 && (hi > total || size > alpha * (total - lo))) {
      const mid = Math.floor((lo + hi) / 2)
      stack.push([mid, hi], [lo, mid])
    } else {
      out.push([lo, hi])
    }
  }

  return out.sort((a, b) => a[0] - b[0])
}

/** How many memories in `[lo,hi)` are in scope, by prefix sums in one pass. */
function inScopeCounts(store: Store, total: number, relevant: Relevant): Int32Array {
  const counts = new Int32Array(total + 1)

  for (let i = 0; i < total; i++) counts[i + 1] = (counts[i] ?? 0) + (relevant(i) ? 1 : 0)
  return counts
}

function relevantIn(counts: Int32Array, lo: number, hi: number): number {
  return (counts[hi] ?? 0) - (counts[lo] ?? 0)
}

function emit(
  store: Store,
  block: [number, number],
  counts: Int32Array,
  relevant: Relevant,
  out: Line[],
): void {
  const [lo, hi] = block

  if (hi - lo === 1) {
    if (!relevant(lo)) return

    const memory = store.memory(lo)
    if (memory !== undefined) out.push({ text: `#${memory.id} ${memory.date} ${memory.text}` })

    return
  }

  const inScope = relevantIn(counts, lo, hi)
  const summary = inScope >= (hi - lo) * THRESHOLD ? store.summary(lo, hi) : undefined

  if (summary !== undefined) {
    out.push({ text: `#${lo}-${hi - 1} ${summary}`, block })
    return
  }

  const mid = Math.floor((lo + hi) / 2)
  emit(store, [lo, mid], counts, relevant, out)
  emit(store, [mid, hi], counts, relevant, out)
}

function render(store: Store, total: number, alpha: number, counts: Int32Array, relevant: Relevant): Line[] {
  const out: Line[] = []

  for (const block of coverBlocks(total, alpha)) emit(store, block, counts, relevant, out)
  return out
}

/** Spend leftover budget on the newest block, where detail is worth most. */
function refine(store: Store, lines: Line[], budget: number, counts: Int32Array, relevant: Relevant): void {
  let newest = lines.length - 1

  while (lines.length < budget && newest >= 0) {
    const line = lines[newest]
    const block = line?.block

    if (block === undefined) {
      newest -= 1
      continue
    }

    const mid = Math.floor((block[0] + block[1]) / 2)
    const halves: Line[] = []
    emit(store, [block[0], mid], counts, relevant, halves)
    emit(store, [mid, block[1]], counts, relevant, halves)
    if (halves.length === 0) {
      newest -= 1
      continue
    }

    lines.splice(newest, 1, ...halves)
  }
}

/**
 * The view for a session: at most `budget` lines, finest where memories are
 * recent and in scope. `total` is the store's memory count, `snapshot` its id
 * so later parts read the same view.
 */
export function scopedView(store: Store, relevant: Relevant, budget: number): { lines: Line[]; snapshot: number } {
  const total = store.count()
  const counts = inScopeCounts(store, total, relevant)

  if (total === 0) return { lines: [], snapshot: 0 }

  // Nothing in scope: an empty view, still paging-safe.
  if ((counts[total] ?? 0) === 0) return { lines: [], snapshot: total }

  let lo = 0
  let hi = 1

  for (let step = 0; step < 48; step++) {
    const mid = (lo + hi) / 2
    if (render(store, total, mid, counts, relevant).length > budget) lo = mid
    else hi = mid
  }

  const lines = render(store, total, hi, counts, relevant)

  // Even the coarsest tiling can overshoot when one project owns most of the
  // recent memories; the present is worth more than the past.
  if (lines.length > budget) return { lines: lines.slice(-budget), snapshot: total }

  refine(store, lines, budget, counts, relevant)
  return { lines, snapshot: total }
}

/** Whether `keys` make memory `i` relevant to a session watching `watch`. */
export function matches(keys: readonly string[], watch: readonly string[]): boolean {
  return keys.some((key) => key === GLOBAL || watch.includes(key))
}
