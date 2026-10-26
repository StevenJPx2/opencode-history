import { expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { stageRelease } from "../tools/stage-release.ts"

test("source edits produce a new release without changing the installed one", () => {
  const root = mkdtempSync(join(tmpdir(), "history-release-test-"))
  const source = join(root, "source")
  const releases = join(root, "releases")
  mkdirSync(join(source, "src"), { recursive: true })
  for (const file of ["index.ts", "package.json", "bun.lock"]) {
    writeFileSync(join(source, file), "fixture")
  }
  writeFileSync(join(source, "src/index.ts"), "original")
  let installed = 0
  const install = () => { installed++ }
  try {
    const first = stageRelease(source, releases, install)
    expect(stageRelease(source, releases, install)).toBe(first)
    expect(installed).toBe(1)
    writeFileSync(join(source, "src/index.ts"), "edited")
    const second = stageRelease(source, releases, install)
    expect(second).not.toBe(first)
    expect(readFileSync(join(first, "src/index.ts"), "utf8")).toBe("original")
    expect(readFileSync(join(second, "src/index.ts"), "utf8")).toBe("edited")
    expect(installed).toBe(2)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
