// Background compression.
//
// `memo nap` with no arguments prints the next block that needs a summary, in
// the order memo builds them, and the command that answers it. So the plugin
// never reimplements the tree: memo chooses the block and the prompt, and the
// plugin supplies one line from its configured model chain. Models cannot
// count bytes, so a line that comes back too long is cut and retried the way
// memo's own retry asks an agent to.

export interface Pending {
  readonly lo: number
  readonly hi: number
  /** The byte limit memo enforces on the line. */
  readonly limit: number
}

const NOTHING = "Nothing left to compress."
const HEADER = /^Compress memories #(\d+)-(\d+) into one line of at most (\d+) bytes\.$/m

/** The block `memo nap` is asking for, or `undefined` when none is. */
export function parsePending(output: string): Pending | undefined {
  if (output.includes(NOTHING)) return undefined

  const header = HEADER.exec(output)
  if (header?.[1] === undefined || header[2] === undefined || header[3] === undefined) return undefined

  return { lo: Number(header[1]), hi: Number(header[2]), limit: Number(header[3]) }
}

/** The task for one compression: memo's own wording, and the block's halves. */
export function task(pending: Pending, input: string): string {
  return [
    `Compress memories #${pending.lo}-${pending.hi} into one line of at most ${pending.limit} bytes.`,
    "Keep what has lasting effect, drop what does not. Invent nothing.",
    "Tag each item with its kind (\"user: ...; echo: ...\"), and credit quoted text to its real author.",
    "Never make anything look further along than it was.",
    "",
    input,
    "",
    "Reply with that one line only: no id head, no quotes, no explanation.",
  ].join("\n")
}

/** The retry for a line memo rejected, with the cut marked where it falls. */
export function cutTask(pending: Pending, input: string, previous: string, bytes: number): string {
  const limit = pending.limit

  return [
    `Too long: your line is ${bytes} bytes, over the ${limit}-byte limit.`,
    "Write the whole line again for the same <input>, cutting just enough of the least valuable items to fit before this cut:",
    `${prefixBytes(previous, limit)}| ← LIMIT`,
    "",
    input,
    "",
    "Reply with that one line only: no id head, no quotes, no explanation.",
  ].join("\n")
}

/** One line of plain text from a model's reply. */
export function line(text: string): string {
  const lines = text
    .split("\n")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "")

  let first = lines[0]
  if (first === undefined) return ""
  if (first.startsWith("```") && lines[1] !== undefined) first = lines[1]

  return first
    .replace(/```$/, "")
    .replace(/^#\d+(-\d+)?\s*\|?\s*/, "")
    .replace(/^(["'`])(.*)\1$/, "$2")
    .trim()
}

export function bytes(text: string): number {
  return Buffer.byteLength(text)
}

/** A whole-character prefix no longer than a UTF-8 byte limit. */
function prefixBytes(text: string, limit: number): string {
  let prefix = ""
  let size = 0

  for (const char of text) {
    const width = bytes(char)
    if (size + width > limit) break

    prefix += char
    size += width
  }

  return prefix
}
