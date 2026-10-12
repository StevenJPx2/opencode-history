// Rendering a scoped view as the text a session reads.
//
// The shape matches what `memo wake` prints, so the instructions injected into
// the system prompt and the Orchestrator rules that watch for its footers both
// keep working.

import type { Sizes } from "./store.ts"
import type { Line } from "./wake.ts"

/** Split into parts that survive any harness's output cap. */
export function paginate(lines: readonly string[], sizes: Sizes): string[][] {
  const parts: string[][] = []
  let current: string[] = []
  let size = 0

  for (const line of lines) {
    const width = Buffer.byteLength(line) + 1

    if (current.length > 0 && (current.length >= sizes.partLines || size + width > sizes.partChars)) {
      parts.push(current)
      current = []
      size = 0
    }

    current.push(line)
    size += width
  }

  if (current.length > 0) parts.push(current)

  return parts
}

export function renderWake(options: {
  readonly lines: readonly Line[]
  readonly total: number
  readonly scopes: readonly string[]
  readonly part: number
  readonly snapshot: number
  readonly sizes: Sizes
  readonly awake: string
}): string {
  const { lines, total, scopes, part, snapshot, sizes, awake } = options

  if (lines.length === 0) {
    return [`No memories are scoped to ${scopes.join(", ")} yet.`, awake].join("\n")
  }

  const parts = paginate(lines.map((line) => line.text), sizes)
  const out: string[] = []

  if (part < 1 || part > parts.length) {
    return `No part ${part}: the memory has ${parts.length === 1 ? "1 part" : `${parts.length} parts`}. Call memo_wake again.`
  }

  if (parts.length > 1) {
    out.push(`Your memory, part ${part} of ${parts.length}, oldest first (${total} memories, scope: ${scopes.join(", ") || "none"}).`)
  }

  out.push(...(parts[part - 1] ?? []))

  if (part < parts.length) {
    out.push(`Not awake yet. Call memo_wake with part ${part + 1} and snapshot ${snapshot}.`)
    return out.join("\n")
  }

  out.push(awake)
  return out.join("\n")
}
