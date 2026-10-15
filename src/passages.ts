import type { Archive, Evidence } from "./archive.ts"
import { MemoryError } from "./errors.ts"
import { redact } from "./redact.ts"

interface Segment { raw: string; view: string; tool: boolean }
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
const textSegment = (text: string): Segment => ({ raw: text, view: text, tool: false })

function segments(message: Record<string, unknown>): Segment[] {
  const result = [textSegment(typeof message.text === "string" ? message.text : "")]
  for (const value of Array.isArray(message.content) ? message.content : []) {
    const part = record(value)
    if (part.type === "text" && typeof part.text === "string") result.push(textSegment(part.text))
    if (part.type !== "tool") continue

    const state = record(part.state)
    const status = typeof state.status === "string" && ["streaming", "running", "completed", "error"].includes(state.status)
      ? state.status : "unknown"
    result.push({
      raw: JSON.stringify({tool:part.name,status:state.status,input:state.input,error:state.error}),
      view: typeof part.name === "string" ? JSON.stringify({tool:part.name,status}) : "", tool: true,
    })
    for (const output of Array.isArray(state.content) ? state.content : []) {
      const content = record(output)
      if (typeof content.text === "string") result.push({raw:content.text,view:"",tool:false})
    }
  }
  return result.filter(segment => segment.raw.length > 0)
}

/** Stable archival representation: persisted passage offsets refer to this text. */
export function transcriptText(message: Record<string, unknown>): string {
  return segments(message).map(segment => segment.raw).join("\n")
}

function passageView(archive: Pick<Archive,"evidence">, entry: Evidence): string {
  if (!entry.id.startsWith("passage:")) return entry.text

  const pointer = record(JSON.parse(entry.payload))
  const {original, start, end} = pointer
  if (typeof original !== "string" || typeof start !== "number" || typeof end !== "number" ||
      !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start) throw new MemoryError("Invalid passage reference")

  const source = archive.evidence(original)
  if (!source || source.kind !== "original" || source.project !== entry.project ||
      source.session !== entry.session || source.message !== entry.message) throw new MemoryError("Missing passage original")

  const parts = segments(record(JSON.parse(source.payload)))
  if (parts.map(part=>part.raw).join("\n").slice(start,end) !== entry.text) throw new MemoryError("Passage does not match original")

  const output: string[] = []
  let offset = 0
  for (const segment of parts) {
    if (segment.tool) {
      if (offset >= start && offset < end && segment.view) output.push(segment.view)
    } else if (segment.view && offset < end && offset + segment.raw.length > start) {
      output.push(segment.view.slice(Math.max(0,start-offset),Math.max(0,end-offset)))
    }
    offset += segment.raw.length + 1
  }
  return output.join("\n").slice(0,8000)
}

/** Project before truncating or redacting: tool bodies can span several chunks. */
export function modelEvidence(archive: Pick<Archive,"evidence">, entry: Evidence): {id:string;kind:string;at:number;text:string} {
  return {id:entry.id,kind:entry.kind,at:entry.at,text:redact(passageView(archive,entry))}
}
