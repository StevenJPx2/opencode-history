import { expect, test } from "bun:test"
import { Archive } from "../src/archive.ts"
import { importTranscript } from "../src/capture.ts"
import { Historian } from "../src/historian.ts"
import { removeRoot, startHost } from "./host.ts"

const SECRET = "sk-proj-outboundtest1234567890abcd"

function transcript(assistant: string): string {
  return JSON.stringify({ info: { id: "ses_out" }, messages: [
    { id: "u", type: "user", text: "What is the release plan?", time: { created: 10 } },
    { id: "a", type: "assistant", content: [{ type: "text", text: assistant }], time: { created: 11, completed: 12 } },
  ] })
}

test("the historian never sends a credential stored in an earlier memory to the model", async () => {
  const archive = new Archive(":memory:")
  const prompts: string[] = []
  try {
    archive.capture({ id: "old", project: "alpha", session: "s", message: "m", kind: "legacy_note", at: 1, text: "", payload: "{}" }, false)
    archive.remember({ id: "old", text: `The release deploy key is ${SECRET}`, at: 1, status: "legacy", scopes: ["alpha"], sources: ["old"] })
    importTranscript(archive, "alpha", transcript("The release plan is approved for Friday, decision confirmed."), "ses_out")
    const historian = new Historian(archive, { log: () => {}, generate: async prompt => { prompts.push(prompt); return JSON.stringify({ memories: [] }) } })
    await historian.pass()

    expect(prompts).toHaveLength(1)
    expect(prompts[0]).toContain("The release deploy key is [REDACTED]")
    expect(prompts[0]).not.toContain(SECRET)
  } finally { archive.close() }
})

test("automatic context injection never sends a stored credential to the model", async () => {
  const host = await startHost({})
  const archive = new Archive(host.archivePath)
  try {
    archive.capture({ id: "old", project: "alpha", session: "s", message: "m", kind: "legacy_note", at: 1, text: "", payload: "{}" }, false)
    archive.remember({ id: "old", text: `The release deploy key is ${SECRET}`, at: 1, status: "legacy", scopes: [archive.project(`${host.root}/alpha`)], sources: ["old"] })
    const event = await host.context("ses_work", "what is the release deploy key?")
    const injected = event.system.map(part => part.text).join("\n")

    expect(injected).toContain("The release deploy key is [REDACTED]")
    expect(injected).not.toContain(SECRET)
  } finally { host.dispose(); await Bun.sleep(20); archive.close(); removeRoot(host.root) }
})
