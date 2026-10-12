// Scope keys.
//
// A key names a project across all of its worktrees, so memories recorded in a
// worktree are visible from the repository's canonical checkout and the other
// way round. The key is the canonical directory's basename; a colliding
// basename gets a numeric suffix, and the mapping is kept in `scopes.json` so
// keys stay stable between sessions.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { basename, dirname, join } from "node:path"

const REGISTRY = "scopes.json"
const MAX_ATTEMPTS = 100

export class Registry {
  private constructor(
    private readonly path: string,
    private readonly byPath: Map<string, string>,
    private readonly byKey: Map<string, string>,
  ) {}

  static load(dir: string): Registry {
    let saved: Record<string, string> = {}

    try {
      saved = JSON.parse(readFileSync(join(dir, REGISTRY), "utf8")) as Record<string, string>
    } catch {
      saved = {}
    }

    return new Registry(
      join(dir, REGISTRY),
      new Map(Object.entries(saved).map(([key, path]) => [path, key])),
      new Map(Object.entries(saved)),
    )
  }

  /** The key for `canonical`, adding it to the registry when it is new. */
  keyFor(canonical: string): string {
    const known = this.byPath.get(canonical)
    if (known !== undefined) return known

    const base = basename(canonical) || "project"
    let key = base

    for (let attempt = 2; attempt < MAX_ATTEMPTS; attempt++) {
      const taken = this.byKey.get(key)
      if (taken === undefined || taken === canonical) break
      key = `${base}-${attempt}`
    }

    this.byKey.set(key, canonical)
    this.byPath.set(canonical, key)
    // A store we cannot write to still works in memory; only the stable key
    // across sessions is lost, so this must not stop the plugin from loading.
    this.save()
    return key
  }

  /** Known keys and their canonical directories, for error messages. */
  list(): ReadonlyMap<string, string> {
    return this.byKey
  }

  has(key: string): boolean {
    return key === "global" || this.byKey.has(key)
  }

  private save(): void {
    try {
      const sorted = Object.fromEntries([...this.byKey].sort(([a], [b]) => a.localeCompare(b)))
      const temporary = `${this.path}.tmp`

      mkdirSync(dirname(this.path), { recursive: true })
      writeFileSync(temporary, JSON.stringify(sorted, null, 2) + "\n")
      renameSync(temporary, this.path)
    } catch {
      // Keep the mapping in memory for this session.
    }
  }
}
