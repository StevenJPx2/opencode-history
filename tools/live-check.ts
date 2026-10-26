// End-to-end check in a real, isolated OpenCode: its own config, data and
// service, a staged release of this plugin, and a free model. Nothing touches
// your OpenCode configuration or database.
//   bun tools/live-check.ts [provider/model]
import { spawnSync } from "node:child_process"
import { Database } from "bun:sqlite"
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { stageRelease } from "./stage-release.ts"

const [providerID, id] = (process.argv[2] ?? "opencode/deepseek-v4.1-flash-free").split("/") as [string, string]
const model = { providerID, id }
const root = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "history-live-"))
const release = stageRelease(resolve(import.meta.dir, ".."), join(root, "releases"))
const env = Object.fromEntries(Object.entries(process.env).filter(([key, value]) => value !== undefined &&
  !key.startsWith("OPENCODE") && !/^(OPENAI|ANTHROPIC|GOOGLE|GEMINI)_API_KEY$/.test(key))) as Record<string, string>
Object.assign(env, { XDG_CONFIG_HOME: join(root, "config"), XDG_DATA_HOME: join(root, "data"), XDG_STATE_HOME: join(root, "state"), XDG_CACHE_HOME: join(root, "cache") })
mkdirSync(join(root, "config/opencode"), { recursive: true, mode: 0o700 })
writeFileSync(join(root, "config/opencode/opencode.jsonc"), JSON.stringify({ plugins: [release], model: `${providerID}/${id}` }))
// Provider credentials for this run only; removed again in `finally`.
const realAuth = join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local/share"), "opencode/auth.json")
const isolatedAuth = join(root, "data/opencode/auth.json")
if (existsSync(realAuth)) {
  mkdirSync(join(root, "data/opencode"), { recursive: true, mode: 0o700 })
  copyFileSync(realAuth, isolatedAuth)
  chmodSync(isolatedAuth, 0o600)
}
const work = join(root, "work")
mkdirSync(work)

function cli(args: string[], timeout = 60_000): string {
  const result = spawnSync("opencode", args, { cwd: work, env, timeout, maxBuffer: 16 << 20, encoding: "utf8" })
  if (result.error || result.status !== 0) throw new Error(`isolated opencode ${args.slice(0, 3).join(" ")} failed: ${result.stderr?.slice(0, 300)}`)
  return result.stdout.trim()
}
const api = (method: string, path: string, body?: unknown) => {
  const raw = cli(["api", method, path, ...(body === undefined ? [] : ["--data", JSON.stringify(body)])], 300_000)
  return raw ? JSON.parse(raw).data : undefined
}
function check(ok: unknown, message: string): void {
  if (!ok) throw new Error(`FAIL: ${message}`)
  console.log(`PASS: ${message}`)
}
async function ask(title: string, text: string): Promise<{ id: string; transcript: string }> {
  const session = api("POST", "/api/session", { title, model })
  api("POST", `/api/session/${session.id}/prompt`, { text })
  api("POST", `/api/experimental/session/${session.id}/wait`, {})
  return { id: session.id, transcript: JSON.stringify(api("GET", `/api/session/${session.id}/message?limit=100`)) }
}

let started = false
let passed = false
try {
  console.log(`isolated root: ${root}`)
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") })
  const port = probe.port!
  probe.stop(true)
  cli(["service", "set", "hostname", "127.0.0.1"])
  cli(["service", "set", "port", String(port)])
  cli(["service", "start"])
  started = true
  check(cli(["debug", "paths", "db"]).startsWith(root), "OpenCode's database is the isolated one")

  const first = await ask("Codeword session", "Remember this for later: the deployment codeword is PELICAN-4417. Reply with just OK.")
  const second = await ask("Lookup session",
    "Use the history_search tool to find the deployment codeword from an earlier session, then reply with just the codeword.")
  const calls = second.transcript.match(/"name":"history_search"/g)?.length ?? 0
  check(calls > 0, `the model called history_search (${calls}x)`)
  check(second.transcript.includes(first.id) && second.transcript.includes("PELICAN"), "history_search returned the earlier session and its passage")

  const audit = readFileSync(join(root, "data/opencode-history/audit.jsonl"), "utf8")
  const events = audit.trim().split("\n").map(line => JSON.parse(line))
  check(events.some(event => event.session === second.id && event.mode === "search" && event.status === "ok" && event.results > 0), "the real tool call wrote a successful audit row")
  check(!audit.includes("PELICAN") && !audit.includes("codeword"), "the audit contains neither query nor passage text")

  const index = new Database(join(root, "data/opencode-history/index.sqlite"), { readonly: true })
  const block = index.query<{ text: string }, [string]>("SELECT text FROM blocks WHERE session=?").get(second.id)?.text ?? ""
  index.close()
  check(block.includes("<recent_work>") && block.includes(first.id), "the real host ran the context hook: the second session's frozen block lists the first")
  passed = true
} finally {
  if (started) {
    try { cli(["service", "stop"]) } catch { console.log("could not stop the isolated service") }
  }
  rmSync(isolatedAuth, { force: true })
  if (passed) rmSync(root, { recursive: true, force: true })
  else console.log(`kept for inspection: ${root}`)
  if (!passed) process.exitCode = 1
}
