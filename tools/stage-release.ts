// Staging never changes OpenCode configuration or an existing release.
import { createHash, randomUUID } from "node:crypto"
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { spawnSync } from "node:child_process"

type File = { path: string; bytes: Buffer }

function inputs(source: string): File[] {
  const paths = ["index.ts", "package.json", "bun.lock", "tools/embedding-server.py", "tools/embedding-server.py.lock"]
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

if (import.meta.main) {
  const source = resolve(import.meta.dir, "..")
  const releases = join(homedir(), ".local/share/optmem/releases")
  const release = stageRelease(source, releases)
  console.log(`Staged: ${release}`)
  console.log("Not activated. Update the plugin package path and embedding LaunchAgent only when you intend to deploy.")
}
