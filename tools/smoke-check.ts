// Run against a staged release, never a live working checkout. All OpenCode
// state and fixtures are temporary; every test session is deleted in finally.
import { Database } from "bun:sqlite"
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { homedir } from "node:os"

const release = resolve(process.argv[2] ?? "")
if (!process.argv[2] || !existsSync(join(release, "DEPLOYMENT.json"))) throw new Error("Pass a staged release directory")
const root = mkdtempSync("/private/var/folders/tg/n2ghb0wx6x3flzwbvg_t32rw0000gn/T/opencode/optmem-smoke-")
const archivePath = join(root, "archive.sqlite")
const alpha = join(root, "alpha")
const beta = join(root, "beta")
const legacy = join(root, "legacy")
const results: Array<{feature:string;status:string;detail:string}> = []
let started = false
const env: Record<string,string> = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string,string] => entry[1] !== undefined))
for (const key of Object.keys(env)) {
  if (key.startsWith("OPENCODE") || /^(OPENAI|ANTHROPIC|GOOGLE|GEMINI)_API_KEY$/.test(key)) delete env[key]
}
Object.assign(env, {
  XDG_CONFIG_HOME:join(root,"config"), XDG_DATA_HOME:join(root,"data"),
  XDG_STATE_HOME:join(root,"state"), XDG_CACHE_HOME:join(root,"cache"),
})
function cli(args: string[], cwd = alpha, timeout = 60_000): string {
  const result = spawnSync("opencode",args,{cwd,env,encoding:"utf8",timeout,maxBuffer:32<<20})
  if (result.error || result.status !== 0) {
    const errors = result.stdout?.split("\n").flatMap(line => {
      try { const event=JSON.parse(line); return event.type === "error" ? [JSON.stringify(event.error)] : [] } catch { return [] }
    }).join("\n")
    throw new Error(`opencode ${args[0]} failed: ${String(errors || result.stderr || result.error || "nonzero exit").slice(0,1200)}`)
  }
  return result.stdout
}
function api(args: string[], cwd = alpha): any { return JSON.parse(cli(["api",...args],cwd)) }
function sessions(directory: string): Array<{id:string;title?:string}> {
  return api(["GET",`/api/session?directory=${encodeURIComponent(directory)}&limit=100`],directory).data ?? []
}
function db<T>(fn:(db:Database)=>T): T {
  const connection = new Database(archivePath,{readonly:true})
  try { return fn(connection) } finally { connection.close() }
}
function report(feature:string,passed:boolean,detail:string) {
  results.push({feature,status:passed ? "PASS" : "FAIL",detail})
  console.log(`${passed ? "PASS" : "FAIL"}: ${feature}: ${detail}`)
}
async function until(check:()=>boolean, ms=90_000): Promise<boolean> {
  const deadline = Date.now()+ms
  while (Date.now()<deadline) {
    if (check()) return true
    await Bun.sleep(1000)
  }
  return check()
}
function fixtureProject(path:string) {
  mkdirSync(path,{recursive:true})
  writeFileSync(join(path,"README.md"),`# Isolated OptMem smoke fixture\n${path}\n`)
  for (const args of [["init","-q"],["add","README.md"],["-c","user.name=OptMem smoke","-c","user.email=smoke@example.invalid","commit","-qm","fixture"]]) {
    const result = spawnSync("git",args,{cwd:path,env,encoding:"utf8"})
    if (result.status !== 0) throw new Error("Could not initialize fixture repository")
  }
}
function text(output:string):string {
  return output.split("\n").flatMap(line=>{
    try { const event=JSON.parse(line); return event.part?.text ? [event.part.text] : event.text ? [event.text] : [] } catch { return [] }
  }).join("\n")
}
function run(prompt:string,cwd=alpha):string {
  return text(cli(["run","--format","json","--model","opencode/mimo-v2.6-flash-free",prompt],cwd,180_000))
}

try {
  console.log(`Temporary test root: ${root}`)
  for (const name of ["config/opencode","data","state","cache","legacy/TREE"]) mkdirSync(join(root,name),{recursive:true,mode:0o700})
  fixtureProject(alpha); fixtureProject(beta)
  const pad=(line:string,size:number)=>Buffer.from(line.padEnd(size," "))
  writeFileSync(join(legacy,"LOG.txt"),Buffer.concat([
    pad("#0 2026-10-14 Alpha stores its archive in SQLite WAL.",320),
    pad("#1 2026-10-14 Beta deployment codename is violet-kestrel.",320),
    pad("#2 2026-10-14 User prefers concise answers.",320),
  ]))
  writeFileSync(join(legacy,"SCOPE.txt"),Buffer.concat([pad("alpha",128),pad("beta",128),pad("global",128)]))
  writeFileSync(join(legacy,"scopes.json"),JSON.stringify({alpha,beta}))
  writeFileSync(join(legacy,"config"),"WAKE_LINES=96\n")
  writeFileSync(join(legacy,"TREE/2"),pad("Alpha and Beta project notes.",288))
  const original=readFileSync(join(legacy,"LOG.txt"))
  writeFileSync(join(root,"config/opencode/opencode.jsonc"),JSON.stringify({
    model:"opencode/mimo-v2.6-flash-free",
    plugins:[{package:release,options:{mode:"unified",archivePath,memoryDir:legacy,
      model:"opencode/mimo-v2.6-flash-free",fallbackModel:false,embeddingURL:"http://127.0.0.1:18791"}}],
  },null,2))
  const probe=Bun.serve({hostname:"127.0.0.1",port:0,fetch:()=>new Response("unused")})
  const port=probe.port!; probe.stop(true)
  cli(["service","set","hostname","127.0.0.1"])
  cli(["service","set","port",String(port)])
  cli(["service","start"]); started=true
  const actualDb=cli(["debug","paths","db"]).trim()
  if (!actualDb.startsWith(root+"/")) throw new Error(`OpenCode database was not isolated: ${actualDb}`)
  report("isolated OpenCode database",true,actualDb)

  let answer=""
  let providerError=""
  try { answer=run("This is a smoke check. We decided the project's release code is amber-otter. Reply only: Decision confirmed: our project release code is amber-otter.") }
  catch(error) { providerError=error instanceof Error ? error.message : "provider unavailable" }
  report("real model prompt",answer.includes("amber-otter"),answer.slice(0,200))
  const archiveExists=await until(()=>existsSync(archivePath),20_000)
  if (!archiveExists) throw new Error("Plugin did not create its isolated archive")
  const imported=db(db=>db.query<{n:number},[]>("SELECT count(*) n FROM memories WHERE id LIKE 'optmem:%'").get()!.n)
  report("legacy migration",imported===3 && original.equals(readFileSync(join(legacy,"LOG.txt"))),`${imported}/3 notes; source bytes unchanged`)
  const scopes=db(db=>db.query<{scope:string;canonical:string},[]>("SELECT scope,canonical FROM projects ORDER BY scope").all())
  report("project scope identities",scopes.some(r=>r.scope==="alpha"&&r.canonical===alpha)&&scopes.some(r=>r.scope==="beta"&&r.canonical===beta),JSON.stringify(scopes))
  const captured=await until(()=>db(db=>db.query<{n:number},[]>("SELECT count(*) n FROM evidence WHERE kind='transcript'").get()!.n)>0)
  report("automatic full-transcript capture",captured,db(db=>JSON.stringify(db.query("SELECT kind,count(*) n FROM evidence GROUP BY kind").all())))
  if (!captured) {
    console.log("Queued exports:",db(db=>JSON.stringify(db.query("SELECT session,error FROM captures").all())))
    const work=sessions(alpha).find(session=>session.title!=="OptMem historian (background memory)")
    if(work) {
      try { const raw=cli(["session","export",work.id]); console.log("Manual CLI export:",JSON.parse(raw).messages.length,"messages") }
      catch(error) { console.log("Manual CLI export failure:",error instanceof Error ? error.message : "unknown") }
    }
  }
  if(providerError) {
    const indexed=await until(()=>db(db=>db.query<{n:number},[]>("SELECT count(*) n FROM vectors").get()!.n)>=3,45_000)
    report("live embeddings for imported notes",indexed,db(db=>`${db.query<{n:number},[]>("SELECT count(*) n FROM vectors").get()!.n} indexed memories`))
    throw new Error(`Real-model extraction, injection and recall blocked: ${providerError}`)
  }
  const extracted=captured && await until(()=>db(db=>db.query<{n:number},[]>("SELECT count(*) n FROM memories WHERE id LIKE 'memory:%' AND text LIKE '%amber-otter%'").get()!.n)>0)
  report("real historian extraction",extracted,db(db=>JSON.stringify(db.query("SELECT phase,state,error FROM jobs WHERE evidence NOT LIKE 'optmem:%'").all())))
  const vectors=await until(()=>db(db=>db.query<{n:number},[]>("SELECT count(*) n FROM vectors").get()!.n)>=3,45_000)
  report("live embeddings",vectors,db(db=>`${db.query<{n:number},[]>("SELECT count(*) n FROM vectors").get()!.n} indexed memories`))
  const injected=run("Without using any tools, what is this project's release code? Answer UNKNOWN if the retrieved memories do not say.")
  report("automatic injection in a new session",injected.includes("amber-otter"),injected.slice(0,300))
  const other=run("Without using any tools, what is the Alpha project's release code? Answer UNKNOWN if the retrieved memories do not say.",beta)
  report("cross-project injection isolation",!other.includes("amber-otter"),other.slice(0,300))
  const recalled=run("Use the memory tool with scope project to find this project's release code. State the answer and include its source citation.")
  report("on-demand recall",recalled.includes("amber-otter")&&/passage:|optmem:|memory:/.test(recalled),recalled.slice(0,400))
  const across=run("Use the memory tool with scope all to find the Beta project's deployment codename. State that codename.")
  report("explicit cross-project recall",across.includes("violet-kestrel"),across.slice(0,300))
  const historianCount=sessions(alpha).filter(s=>s.title==="OptMem historian (background memory)").length+
    sessions(beta).filter(s=>s.title==="OptMem historian (background memory)").length
  report("no persistent background sessions",historianCount===0,`${historianCount} historian sessions were created`)
} catch(error) {
  report("smoke execution",false,error instanceof Error ? error.message : "Unknown error")
} finally {
  let cleanup=true
  if (started) {
    // Disable plugins before deleting so the test writer cannot recreate a
    // historian. This file belongs only to the temporary test environment.
    writeFileSync(join(root,"config/opencode/opencode.jsonc"),JSON.stringify({plugins:["-*"],model:"opencode/mimo-v2.6-flash-free"}))
    await Bun.sleep(1000)
    for (const directory of [alpha,beta,root,homedir()]) {
      try {
        for(const session of sessions(directory)) cli(["session","delete",session.id],directory)
        if(sessions(directory).length) cleanup=false
      } catch { cleanup=false }
    }
    try { cli(["service","stop"]) } catch { cleanup=false }
  }
  report("test sessions deleted and isolated service stopped",cleanup,root)
  if(cleanup) rmSync(root,{recursive:true,force:true})
  else console.log(`Kept isolated files for cleanup: ${root}`)
  console.log(JSON.stringify({results,testDirectories:[alpha,beta],productionChanged:false},null,2))
  if(results.some(row=>row.status==="FAIL")) process.exitCode=1
}
