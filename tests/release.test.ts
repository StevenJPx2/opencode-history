import { expect, test } from "bun:test"
import { chmodSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { activateRelease, activeRelease, pluginDirectory, stageRelease } from "../tools/stage-release.ts"

function sourceTree(root: string, content: string): string {
  const source = join(root, `source-${content}`)
  mkdirSync(join(source, "src"), { recursive: true })
  for (const file of ["index.ts", "package.json", "bun.lock"]) writeFileSync(join(source, file), "fixture")
  writeFileSync(join(source, "src/index.ts"), content)
  return source
}

test("activation rewrites only the plugin entry, reports the previous release, and rolls back", () => {
  const root = mkdtempSync(join(tmpdir(), "history-release-test-"))
  const releases = join(root, "releases")
  const plugin = join(root, "config/opencode/plugins/opencode-history")
  try {
    const first = stageRelease(sourceTree(root, "one"), releases, () => {})
    const second = stageRelease(sourceTree(root, "two"), releases, () => {})

    expect(activateRelease(first, plugin)).toBeUndefined()
    expect(activeRelease(plugin)).toBe(first)
    const entry = readFileSync(join(plugin, "index.ts"), "utf8")
    expect(entry).toContain(`export { default } from ${JSON.stringify(join(first, "index.ts"))}`)

    expect(activateRelease(second, plugin)).toBe(first)
    expect(activeRelease(plugin)).toBe(second)
    expect(activateRelease(first, plugin)).toBe(second)
    expect(readdirSync(plugin)).toEqual(["index.ts"])
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test("activation refuses a directory that is not an intact release and leaves the entry alone", () => {
  const root = mkdtempSync(join(tmpdir(), "history-release-test-"))
  const plugin = join(root, "plugin")
  try {
    const good = stageRelease(sourceTree(root, "one"), join(root, "releases"), () => {})
    activateRelease(good, plugin)

    expect(() => activateRelease(sourceTree(root, "unstaged"), plugin)).toThrow("Not a staged release")
    chmodSync(join(good, "src/index.ts"), 0o600)
    writeFileSync(join(good, "src/index.ts"), "tampered")
    expect(() => activateRelease(good, plugin)).toThrow("failed verification")
    expect(activeRelease(plugin)).toBe(good)
    expect(readdirSync(plugin)).toEqual(["index.ts"])
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test("the plugin entry lives in OpenCode's config directory", () => {
  expect(pluginDirectory({ XDG_CONFIG_HOME: "/cfg" })).toBe("/cfg/opencode/plugins/opencode-history")
  expect(pluginDirectory({})).toEndWith("/.config/opencode/plugins/opencode-history")
})

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
