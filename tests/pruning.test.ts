import { expect, test } from "bun:test"
import { Archive } from "../src/archive.ts"
import { importTranscript } from "../src/capture.ts"
import { Historian } from "../src/historian.ts"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { removeRoot, startHost } from "./host.ts"

const user = { id: "u", type: "user", text: "Please confirm the archive decision for this project.", time: { created: 10 } }
const assistant = {
  id: "a", type: "assistant", time: { created: 11, completed: 12 },
  content: [
    { type: "text", text: "I checked the archive configuration before answering." },
    { type: "tool", id: "tool-1", name: "read", state: {
      status: "completed", input: { filePath: "PRIVATE_TOOL_ARGUMENT" },
      content: [{ type: "text", text: "PRIVATE_TOOL_OUTPUT" }], metadata: { note: "PRIVATE_TOOL_METADATA" },
    } },
    { type: "text", text: "Decision confirmed: the archive uses SQLite WAL." },
  ],
}
const raw = JSON.stringify({ info: { id: "ses_prune" }, messages: [user, assistant] })

test("historian receives conversation and tool status, while the archive retains the complete tool call", async () => {
  const archive = new Archive(":memory:")
  const prompts: string[] = []
  const worker = new Historian(archive, { log: () => {}, generate: async prompt => {
    prompts.push(prompt)
    return JSON.stringify({ memories: [] })
  } })
  try {
    importTranscript(archive, "alpha", raw, "ses_prune")
    await worker.pass()

    expect(prompts).toHaveLength(1)
    expect(prompts[0]).toContain(user.text)
    expect(prompts[0]).toContain("I checked the archive configuration before answering.")
    expect(prompts[0]).toContain("Decision confirmed: the archive uses SQLite WAL.")
    expect(prompts[0]).toContain('\\"tool\\":\\"read\\",\\"status\\":\\"completed\\"')
    expect(prompts[0]).not.toContain("PRIVATE_TOOL_ARGUMENT")
    expect(prompts[0]).not.toContain("PRIVATE_TOOL_OUTPUT")
    expect(prompts[0]).not.toContain("PRIVATE_TOOL_METADATA")

    const passage = archive.search("alpha", "Decision confirmed").find(entry => entry.kind === "assistant")!
    const pointer: unknown = JSON.parse(archive.evidence(passage.id)!.payload)
    if (!pointer || typeof pointer !== "object" || !("original" in pointer) || typeof pointer.original !== "string") throw new Error("Missing original reference")
    expect(archive.evidence(pointer.original)?.payload).toBe(JSON.stringify(assistant))
    expect(importTranscript(archive, "alpha", raw, "ses_prune")).toBe(0)
  } finally { await worker.stop(); archive.close() }
})

test("chunked tool output is omitted without losing the final assistant decision or its citation", async () => {
  const archive = new Archive(":memory:")
  const prompts: string[] = []
  const large = {...assistant, content: [
    { type: "tool", name: "shell", state: {status:"error",input:{command:"PRIVATE_COMMAND"},
      error:{message:"PRIVATE_ERROR_DETAIL"}, content:[{type:"text",text:"PRIVATE_TOOL_DUMP ".repeat(4000)}]} },
    { type: "text", text: "Decision confirmed: the archive uses SQLite WAL." },
  ]}
  const worker = new Historian(archive, {log:()=>{},generate:async prompt=>{
    prompts.push(prompt)
    const source = archive.search("alpha","Decision confirmed").find(entry=>entry.kind==="assistant")!
    return JSON.stringify({memories:[{text:"The archive uses SQLite WAL.",status:"confirmed",source:source.id,quote:"the archive uses SQLite WAL"}]})
  }})
  try {
    importTranscript(archive,"alpha",JSON.stringify({info:{id:"ses_prune"},messages:[user,large]}),"ses_prune")
    await worker.pass()
    await worker.pass()

    expect(prompts).toHaveLength(1)
    expect(prompts[0]).not.toContain("PRIVATE_TOOL_DUMP")
    expect(prompts[0]).not.toContain("PRIVATE_COMMAND")
    expect(prompts[0]).not.toContain("PRIVATE_ERROR_DETAIL")
    expect(prompts[0]).toContain('\\"tool\\":\\"shell\\",\\"status\\":\\"error\\"')
    const memory=archive.recall("alpha","SQLite WAL")[0]!
    expect(memory.text).toBe("The archive uses SQLite WAL.")
    expect(memory.sources.every(id=>archive.evidence(id)!==null)).toBe(true)
  } finally {await worker.stop();archive.close()}
})

test("queued selections from the previous release are pruned before the next extraction", async () => {
  const archive=new Archive(":memory:")
  const prompts:string[]=[]
  const worker=new Historian(archive,{log:()=>{},generate:async prompt=>{prompts.push(prompt);return JSON.stringify({memories:[]})}})
  try {
    importTranscript(archive,"alpha",raw,"ses_prune")
    const source=archive.search("alpha","Decision confirmed").find(entry=>entry.kind==="assistant")!
    // Persisted-state fixture from the previous release: the selected text
    // contains the full tool body. Observe only the outbound model call.
    archive.db.query("UPDATE jobs SET state='done' WHERE phase='select'").run()
    archive.db.query("INSERT INTO selections VALUES(?,?,?)").run(source.id,1,source.text)
    archive.enqueue(source.id,"extract")
    await worker.pass()

    expect(prompts).toHaveLength(1)
    expect(prompts[0]).toContain("Decision confirmed: the archive uses SQLite WAL.")
    expect(prompts[0]).not.toContain("PRIVATE_TOOL_ARGUMENT")
    expect(prompts[0]).not.toContain("PRIVATE_TOOL_OUTPUT")
  } finally {await worker.stop();archive.close()}
})

test("on-demand recall also prunes archived tool input and output from its model request and returned evidence", async () => {
  const root=mkdtempSync(join(tmpdir(),"optmem-pruning-"))
  const archive=new Archive(join(root,"archive.sqlite"))
  const alpha=archive.project(join(root,"alpha"))
  importTranscript(archive,alpha,raw,"ses_prune")
  const source=archive.search(alpha,"Decision confirmed").find(entry=>entry.kind==="assistant")!
  archive.close()
  const host=await startHost({root,generate:async prompt=>JSON.stringify(prompt.startsWith("You are a memory historian answering")
    ? {answer:"The archive uses SQLite WAL.",citations:[source.id]} : {memories:[]})})
  try {
    const result=await host.tools.get("memory")!.execute({question:"SQLite archive decision"},{sessionID:"ses_work",signal:new AbortController().signal})
    expect(result.content).toContain("SQLite WAL")
    for(const output of [...host.prompts,result.content]) {
      expect(output).not.toContain("PRIVATE_TOOL_ARGUMENT")
      expect(output).not.toContain("PRIVATE_TOOL_OUTPUT")
    }
  } finally {host.dispose();await Bun.sleep(20);removeRoot(root)}
})

test("tool-shaped examples written by the user or assistant remain ordinary conversation text", async () => {
  const archive=new Archive(":memory:")
  const prompts:string[]=[]
  const example='Example: {"tool":"shell","input":{"command":"keep this literal"}}'
  const transcript=JSON.stringify({info:{id:"ses_example"},messages:[
    {...user,text:`Please preserve this example exactly. ${example}`},
    {...assistant,content:[{type:"text",text:`Decision confirmed: this literal example belongs in the documentation. ${example}`}]},
  ]})
  const worker=new Historian(archive,{log:()=>{},generate:async prompt=>{prompts.push(prompt);return JSON.stringify({memories:[]})}})
  try {
    importTranscript(archive,"alpha",transcript,"ses_example")
    await worker.pass()
    expect(prompts).toHaveLength(1)
    expect(prompts[0]).toContain("Please preserve this example exactly.")
    expect(prompts[0]).toContain("keep this literal")
  } finally {await worker.stop();archive.close()}
})
