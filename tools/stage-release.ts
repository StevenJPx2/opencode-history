// Staging never changes OpenCode configuration or an existing release.
// Activation rewrites one file, `plugins/opencode-history/index.ts` in
// OpenCode's config directory, to re-export a release. OpenCode discovers that
// directory without a config entry and reloads it in place when the file changes.
//   bun tools/stage-release.ts                   stage only
//   bun tools/stage-release.ts --activate        stage this source and activate it
//   bun tools/stage-release.ts --activate DIR    activate an existing release, such as a rollback
import { createHash, randomUUID } from "node:crypto"
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { spawnSync } from "node:child_process"

type File = { path: string; bytes: Buffer }

function inputs(source: string): File[] {
  const paths = ["index.ts", "package.json", "bun.lock"]
  function walk(directory: string): void {
    for (const entry of readdirSync(join(source, directory), { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw new Error("Release source must not contain symlinks")

      const path = `${directory}/${entry.name}`
      if (entry.isDirectory()) walk(path)
      else if (entry.name.endsWith(".ts")) paths.push(path)
    }
  }
  walk("src")
  return paths.sort().map(path => ({ path, bytes: readFileSync(join(source, path)) }))
}

function hash(files: File[]): string {
  const digest = createHash("sha256")
  for (const file of files) digest.update(file.path + "\0").update(file.bytes)
  return digest.digest("hex")
}

function install(directory: string): void {
  const result = spawnSync("bun", ["install", "--frozen-lockfile", "--production"], { cwd: directory, stdio: "inherit" })
  if (result.error || result.status !== 0) throw new Error("Release dependency installation failed")
}

/** Copies runtime files and installs independent, locked dependencies. */
export function stageRelease(source: string, releases: string, installDependencies = install): string {
  const files = inputs(source)
  const sha256 = hash(files)
  const target = join(releases, sha256.slice(0, 16))
  if (existsSync(target)) {
    if (hash(inputs(target)) !== sha256 || !existsSync(join(target, "DEPLOYMENT.json"))) throw new Error("Existing release failed verification")

    return target
  }

  mkdirSync(releases, { recursive: true, mode: 0o700 })
  const staging = join(releases, `.staging-${randomUUID()}`)
  mkdirSync(staging, { mode: 0o700 })
  try {
    for (const file of files) {
      const path = join(staging, file.path)
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
      writeFileSync(path, file.bytes, { flag: "wx", mode: 0o600 })
    }
    installDependencies(staging)
    if (hash(inputs(staging)) !== sha256) throw new Error("Installation changed release inputs")

    writeFileSync(join(staging, "DEPLOYMENT.json"), JSON.stringify({
      sha256,
      policy: "Fixed snapshot. Do not edit deployed files; explicitly switch configuration to deploy a new release.",
    }, null, 2) + "\n", { flag: "wx", mode: 0o400 })
    for (const file of files) chmodSync(join(staging, file.path), 0o400)
    renameSync(staging, target)
    return target
  } catch (error) {
    // Only our uniquely named staging directory, never an existing release.
    rmSync(staging, { recursive: true, force: true })
    throw error
  }
}

/** Refuses a directory that is not an intact staged release. */
function verifyRelease(release: string): void {
  const deployment = join(release, "DEPLOYMENT.json")
  if (!existsSync(deployment)) throw new Error(`Not a staged release: ${release}`)
  const { sha256 } = JSON.parse(readFileSync(deployment, "utf8")) as { sha256?: string }
  if (hash(inputs(release)) !== sha256) throw new Error(`Release failed verification: ${release}`)
}

/** The directory OpenCode loads this plugin from, under its config directory. */
export function pluginDirectory(env: Record<string, string | undefined> = process.env): string {
  return join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "opencode/plugins/opencode-history")
}

const ENTRY_HEADER = "// Written by opencode-history's stage-release --activate. Do not edit; activate another release instead.\n"

/** The release `plugin` loads now, if any. */
export function activeRelease(plugin: string): string | undefined {
  const entry = join(plugin, "index.ts")
  if (!existsSync(entry)) return undefined
  const target = /^export \{ default \} from (".*")$/m.exec(readFileSync(entry, "utf8"))?.[1]
  return target ? dirname(JSON.parse(target) as string) : undefined
}

/**
 * Points OpenCode at `release` by atomically replacing the one file it loads,
 * and returns the release it loaded before.
 */
export function activateRelease(release: string, plugin: string): string | undefined {
  verifyRelease(release)
  const previous = activeRelease(plugin)
  mkdirSync(plugin, { recursive: true, mode: 0o700 })
  const temporary = join(plugin, `.index-${randomUUID()}.ts`)
  try {
    writeFileSync(temporary, `${ENTRY_HEADER}export { default } from ${JSON.stringify(join(resolve(release), "index.ts"))}\n`, { flag: "wx", mode: 0o600 })
    renameSync(temporary, join(plugin, "index.ts"))
  } catch (error) {
    rmSync(temporary, { force: true })
    throw error
  }
  return previous
}

if (import.meta.main) {
  const source = resolve(import.meta.dir, "..")
  const releases = join(homedir(), ".local/share/opencode-history/releases")
  const [flag, existing] = process.argv.slice(2)
  if (flag !== undefined && flag !== "--activate") throw new Error(`Unknown option ${flag}`)

  const release = existing ? resolve(existing) : stageRelease(source, releases)
  if (!existing) console.log(`Staged: ${release}`)
  if (flag === "--activate") {
    const plugin = pluginDirectory()
    const previous = activateRelease(release, plugin)
    console.log(`Active: ${release}`)
    console.log(`Loaded from ${plugin}; OpenCode reloads it in place.`)
    if (previous && previous !== release) console.log(`Previous: ${previous}  (roll back with --activate ${previous})`)
  } else {
    console.log("Not activated. Run with --activate to deploy it.")
  }
}
