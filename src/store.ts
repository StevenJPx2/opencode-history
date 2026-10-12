// Reading OptMem's store.
//
// The layout is fixed-width and positional, so every lookup is one seek:
// memory `i` at `i * LOG_REC` in LOG.txt, block `[lo,hi)` at
// `(lo / size) * TREE_REC` in TREE/<size>. Scope records are ours, in the same
// style at `i * SCOPE_REC` in SCOPE.txt, so positional writes from parallel
// sessions never collide.

import { closeSync, existsSync, fstatSync, ftruncateSync, openSync, readFileSync, readSync, statSync, writeSync } from "node:fs"
import { join } from "node:path"

export const LOG_REC = 320
export const TREE_REC = 288
export const SCOPE_REC = 128
export const SCOPE_FILE = "SCOPE.txt"
export const GLOBAL = "global"

export interface Memory {
  readonly id: number
  readonly date: string
  readonly text: string
}

export interface Sizes {
  readonly wakeLines: number
  readonly partChars: number
  readonly partLines: number
}

/** The store's own defaults, which its `config` file may override. */
const KNOBS: Record<keyof Sizes, number> = { wakeLines: 96, partChars: 20000, partLines: 500 }

function readAt(fd: number, position: number, length: number): string | undefined {
  const buffer = Buffer.alloc(length)
  const read = readSync(fd, buffer, 0, length, position)

  return read === 0 ? undefined : buffer.toString("utf8", 0, read).replace(/\s+$/, "")
}

/** The sizes `memo wake` reads, from the store's `config` file. */
export function readSizes(dir: string): Sizes {
  const overrides: Partial<Record<keyof Sizes, number>> = {}
  let text = ""

  try {
    text = readFileSync(join(dir, "config"), "utf8")
  } catch {
    return KNOBS
  }

  for (const line of text.split("\n")) {
    const match = /^\s*(WAKE_LINES|PART_CHARS|PART_LINES)\s*=\s*(\d+)/.exec(line.split("#")[0] ?? "")
    if (!match?.[2]) continue

    const key = match[1]?.toLowerCase() as keyof Sizes
    const value = Number(match[2])

    if (value > 0) overrides[key] = value
  }

  return { ...KNOBS, ...overrides }
}

export class Store {
  private readonly logFd: number
  private readonly logCount: number
  private readonly treeFds = new Map<number, number>()
  private scopeFd: number | undefined

  private constructor(
    readonly dir: string,
    logFd: number,
    logCount: number,
  ) {
    this.logFd = logFd
    this.logCount = logCount
  }

  /**
   * The store at `dir`, or `undefined` when its layout is not the one this
   * reader understands. Callers fall back to running `memo` itself.
   */
  static open(dir: string): Store | undefined {
    const log = join(dir, "LOG.txt")

    if (!existsSync(log)) return undefined

    const size = statSync(log).size

    if (size % LOG_REC !== 0) return undefined

    const fd = openSync(log, "r")
    const store = new Store(dir, fd, size / LOG_REC)

    if (store.logCount === 0) return store

    if (store.memory(0) === undefined) {
      store.close()
      return undefined
    }

    return store
  }

  count(): number {
    return this.logCount
  }

  /** Memory `i`, or `undefined` when it is out of range or unreadable. */
  memory(i: number): Memory | undefined {
    if (i < 0 || i >= this.logCount) return undefined

    const line = readAt(this.logFd, i * LOG_REC, LOG_REC)
    if (line === undefined) return undefined

    const [head, date, ...rest] = line.split(" ")

    if (!head?.startsWith("#")) return undefined

    const id = Number(head.slice(1))

    return Number.isInteger(id) ? { id, date: date ?? "", text: rest.join(" ") } : undefined
  }

  /** The summary of `[lo,hi)`, or `undefined` when it is not built yet. */
  summary(lo: number, hi: number): string | undefined {
    const size = hi - lo

    if (size < 2 || (size & (size - 1)) !== 0 || lo % size !== 0) return undefined

    const fd = this.treeFd(size)
    if (fd === undefined) return undefined

    return readAt(fd, (lo / size) * TREE_REC, TREE_REC) || undefined
  }

  /** The scope keys of memory `i`; empty when unclassified. */
  scope(i: number): readonly string[] {
    if (i < 0 || i >= this.logCount) return []

    const fd = this.scopeFd ?? (this.scopeFd = this.openScope())
    if (fd === undefined) return []

    return (readAt(fd, i * SCOPE_REC, SCOPE_REC) ?? "").split(",").filter(Boolean)
  }

  /**
   * Records `keys` as memory `i`'s scope. The write is positional, so it needs
   * no lock; a crash can only leave a partial trailing record, which the next
   * write trims.
   */
  writeScope(i: number, keys: readonly string[]): void {
    if (i < 0 || i >= this.logCount) throw new Error(`no memory #${i}; the store holds ${this.logCount}`)

    const text = keys.join(",")
    if (Buffer.byteLength(text) > SCOPE_REC - 1) throw new Error(`scope "${text}" is too long`)

    const fd = this.scopeFd ?? (this.scopeFd = this.openScope())
    if (fd === undefined) throw new Error(`cannot write ${SCOPE_FILE} in ${this.dir}`)

    const size = fstatSync(fd).size
    if (size % SCOPE_REC !== 0) ftruncateSync(fd, size - (size % SCOPE_REC))

    const record = Buffer.alloc(SCOPE_REC, 0x20)
    record.write(text, 0, "utf8")
    writeSync(fd, record, 0, SCOPE_REC, i * SCOPE_REC)
  }

  close(): void {
    closeSync(this.logFd)

    for (const fd of this.treeFds.values()) closeSync(fd)
    if (this.scopeFd !== undefined) closeSync(this.scopeFd)

    this.treeFds.clear()
    this.scopeFd = undefined
  }

  /** `TREE/<size>`, when it exists and holds whole records. */
  private treeFd(size: number): number | undefined {
    const open = this.treeFds.get(size)
    if (open !== undefined) return open

    const path = join(this.dir, "TREE", String(size))
    if (!existsSync(path) || statSync(path).size % TREE_REC !== 0) return undefined

    try {
      const fd = openSync(path, "r")
      this.treeFds.set(size, fd)
      return fd
    } catch {
      return undefined
    }
  }

  /** `SCOPE.txt`, created on first write. */
  private openScope(): number | undefined {
    const path = join(this.dir, SCOPE_FILE)

    try {
      return openSync(path, "r+")
    } catch {
      // Not there yet: create it empty, then reopen for positional writes.
    }

    try {
      closeSync(openSync(path, "w"))
      return openSync(path, "r+")
    } catch {
      return undefined
    }
  }
}
