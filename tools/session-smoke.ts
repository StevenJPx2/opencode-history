// Real OpenCode API verification, isolated from production configuration/data.
// Usage: bun tools/session-smoke.ts /absolute/path/to/staged/release
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"

const release = resolve(process.argv[2] ?? ".")
const { Archive } = await import(join(release, "src/archive.ts"))
const { SessionPool } = await import(join(release, "src/sessions.ts"))
const root = mkdtempSync("/private/var/folders/tg/n2ghb0wx6x3flzwbvg_t32rw0000gn/T/opencode/optmem-child-smoke-")
const env = Object.fromEntries(Object.entries(process.env).filter(([key, value]) => value !== undefined &&
  !key.startsWith("OPENCODE") && !/^(OPENAI|ANTHROPIC|GOOGLE|GEMINI)_API_KEY$/.test(key))) as Record<string, string>
Object.assign(env, { XDG_CONFIG_HOME: join(root, "config"), XDG_DATA_HOME: join(root, "data"),
  XDG_STATE_HOME: join(root, "state"), XDG_CACHE_HOME: join(root, "cache") })
mkdirSync(join(root, "config/opencode"), { recursive: true, mode: 0o700 })
writeFileSync(join(root, "config/opencode/opencode.jsonc"), JSON.stringify({ plugins: ["-*"], model: "opencode/space-bunny-free" }))

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
  archive = new Archive(join(root, "archive.sqlite"))
  const session = {
    create: async (input: unknown) => { const row = api("POST", "/api/session", input); ids.add(row.id); return row },
    list: async ({ parentID, limit }: { parentID: string | null; limit: number }) => ({
      data: api("GET", `/api/session?parentID=${encodeURIComponent(parentID === null ? "null" : parentID)}&limit=${limit}`),
    }),
    get: async ({ sessionID }: { sessionID: string }) => api("GET", `/api/session/${sessionID}`),
    context: async ({ sessionID }: { sessionID: string }) => api("GET", `/api/session/${sessionID}/message`),
    generate: async ({ sessionID, prompt }: { sessionID: string; prompt: string }) => api("POST", `/api/session/${sessionID}/generate`, { prompt }),
    remove: async ({ sessionID }: { sessionID: string }) => { api("DELETE", `/api/session/${sessionID}`); ids.delete(sessionID) },
  }
  const pool = new SessionPool({ archive, session, models: [model], log: () => {} })
  let generated = false
  try { generated = (await pool.ask(model, "Reply with the single word OK.", "opencode/space-bunny-free#low", new AbortController().signal)).includes("OK") }
  catch { console.log("NOTE: isolated free-model generation unavailable; checking lifecycle independently") }
  const children = (await session.list({ parentID: parent.id, limit: 50 })).data
  assert(children.length === 1, "one linked historian child exists")
  assert(children[0].parentID === parent.id, "host preserves parentID rather than silently ignoring it")
  const roots = (await session.list({ parentID: null, limit: 50 })).data
  assert(roots.some((row: { id: string }) => row.id === parent.id) && !roots.some((row: { id: string }) => row.id === children[0].id), "root-session list excludes the historian")
  assert((await session.context({ sessionID: children[0].id })).length === 0, "historian history remains empty")
  console.log(`Real generation: ${generated ? "OK" : "unavailable in isolated service"}`)
} finally {
  archive?.close()
  let clean = true
  if (started) {
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
