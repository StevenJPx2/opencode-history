// Real OpenCode API verification, isolated from production configuration/data.
// Usage: bun tools/session-smoke.ts /absolute/path/to/staged/release
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"

const release = resolve(process.argv[2] ?? ".")
const { Archive } = await import(join(release, "src/archive.ts"))
const { importTranscript } = await import(join(release, "src/capture.ts"))
const root = mkdtempSync("/private/var/folders/tg/n2ghb0wx6x3flzwbvg_t32rw0000gn/T/opencode/optmem-child-smoke-")
const env = Object.fromEntries(Object.entries(process.env).filter(([key, value]) => value !== undefined &&
  !key.startsWith("OPENCODE") && !/^(OPENAI|ANTHROPIC|GOOGLE|GEMINI)_API_KEY$/.test(key))) as Record<string, string>
Object.assign(env, { XDG_CONFIG_HOME: join(root, "config"), XDG_DATA_HOME: join(root, "data"),
  XDG_STATE_HOME: join(root, "state"), XDG_CACHE_HOME: join(root, "cache") })
mkdirSync(join(root, "config/opencode"), { recursive: true, mode: 0o700 })
const config = join(root, "config/opencode/opencode.jsonc")
const archivePath = join(root, "archive.sqlite")
writeFileSync(config, JSON.stringify({ plugins: [{ package: release, options: {
  mode: "unified", archivePath, memoryDir: join(root, "no-legacy"), model: "opencode/space-bunny-free#low", fallbackModel: false,
} }], model: "opencode/space-bunny-free" }))

function cli(args: string[], timeout = 60_000): string {
  const result = spawnSync("opencode", args, { cwd: root, env, timeout, maxBuffer: 8 << 20, encoding: "utf8" })
  if (result.error || result.status !== 0) throw new Error(`Isolated OpenCode ${args[0]} failed`)
  return result.stdout.trim()
}
function api(method: string, path: string, body?: unknown): any {
  const raw = cli(["api", method, path, ...(body === undefined ? [] : ["--data", JSON.stringify(body)])], 120_000)
  return raw ? JSON.parse(raw).data : undefined
}
function assert(ok: unknown, message: string) { if (!ok) throw new Error(message); console.log(`PASS: ${message}`) }
const ids = new Set<string>()
let started = false
let archive: InstanceType<typeof Archive> | undefined
try {
  console.log(`Isolated test directory: ${root}`)
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("unused") })
  const port = probe.port!
  probe.stop(true)
  cli(["service", "set", "hostname", "127.0.0.1"])
  cli(["service", "set", "port", String(port)])
  cli(["service", "start"])
  started = true
  assert(cli(["debug", "paths", "db"]).startsWith(root + "/"), "OpenCode database is isolated")
  const model = { providerID: "opencode", id: "space-bunny-free", variant: "low" }
  const parent = api("POST", "/api/session", { title: "OptMem isolated parent", model })
  ids.add(parent.id)
  archive = new Archive(archivePath)
  importTranscript(archive, archive.project(root), JSON.stringify({ info: { id: parent.id }, messages: [
    { id: "u", type: "user", text: "Remember our isolated test decision.", time: { created: 10 } },
    { id: "a", type: "assistant", content: [{ type: "text", text: "Decision confirmed: this isolated fixture uses SQLite WAL mode." }], time: { created: 11, completed: 12 } },
  ] }), parent.id)
  // The staged plugin, not this script, must create the child through its real
  // host context. This catches differences between HTTP and plugin methods.
  let children: any[] = []
  const deadline = Date.now() + 75_000
  while (Date.now() < deadline) {
    children = api("GET", `/api/session?parentID=${parent.id}&limit=50`) ?? []
    for (const row of children) ids.add(row.id)
    if (children.length) break
    await Bun.sleep(1000)
  }
  assert(children.length === 1, "real plugin host creates one linked historian child")
  assert(children[0].parentID === parent.id, "host preserves parentID rather than silently ignoring it")
  const roots = api("GET", "/api/session?parentID=null&limit=50")
  assert(roots.some((row: { id: string }) => row.id === parent.id) && !roots.some((row: { id: string }) => row.id === children[0].id), "root-session list excludes the historian")
  assert(api("GET", `/api/session/${children[0].id}/message`).length === 0, "historian history remains empty")
} finally {
  archive?.close()
  let clean = true
  if (started) {
    writeFileSync(config, JSON.stringify({ plugins: ["-*"], model: "opencode/space-bunny-free" }))
    await Bun.sleep(2000)
    for (const row of api("GET", "/api/session?limit=100") ?? []) ids.add(row.id)
    for (const sessionID of [...ids].reverse()) {
      try { api("DELETE", `/api/session/${sessionID}`); ids.delete(sessionID) } catch { clean = false }
    }
    try { assert((api("GET", "/api/session?limit=100") ?? []).length === 0, "all test sessions deleted") } catch { clean = false }
    try { cli(["service", "stop"]) } catch { clean = false }
  }
  if (clean) rmSync(root, { recursive: true, force: true })
  console.log(`${clean ? "Removed" : "Kept for cleanup"} isolated test directory: ${root}`)
  if (!clean) process.exitCode = 1
}
