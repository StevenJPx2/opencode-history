import type { Embeddings } from "./historian.ts"

function local(url: string): URL {
  const parsed = new URL(url)
  if (parsed.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname) || parsed.username || parsed.password) throw new Error("Memory services must use loopback HTTP")

  return parsed
}

export function orchestrator(url = "http://127.0.0.1:18790", token?: string) {
  const endpoint = new URL("/rpc", local(url))
  // Orchestrator's daemon requires a numeric request id.
  let next = 0
  async function rpc(method: string, params: unknown, signal: AbortSignal): Promise<Record<string, unknown>> {
    const response = await fetch(endpoint, {method:"POST",signal,
      headers:{"content-type":"application/json",...(token ? {authorization:`Bearer ${token}`} : {})},
      body:JSON.stringify({id:++next,method,params})})
    if (!response.ok) throw new Error("Memory judge unavailable")

    const body = await response.json() as {result?: Record<string,unknown>; error?: unknown}
    if (!body.result || body.error) throw new Error("Memory judge failed")

    return body.result
  }
  return {
    async select(text: string, kind: string, signal: AbortSignal) {
      const result = await rpc("memory.select", {text,kind}, signal)
      if (typeof result.selected !== "boolean" || typeof result.text !== "string") throw new Error("Invalid selection response")

      return {selected:result.selected,text:result.text}
    },
    async redact(text: string, signal: AbortSignal) {
      const result = await rpc("memory.redact", {text}, signal)
      if (typeof result.text !== "string") throw new Error("Invalid redaction response")

      return result.text
    },
  }
}

export const EMBEDDING_MODEL = "google/embeddinggemma-2@914f7f89142e33e77833254d9c9b90c3cef7303b:256"
export function embeddingService(url: string, model = EMBEDDING_MODEL): Embeddings {
  const endpoint = new URL("/embed", local(url))
  return {model,async encode(texts,kind,signal) {
    if (!texts.length) return []

    const response = await fetch(endpoint,{method:"POST",signal,headers:{"content-type":"application/json"},body:JSON.stringify({texts,kind,model})})
    if (!response.ok) throw new Error("Local embeddings unavailable")

    const body = await response.json() as {model?: unknown; vectors?: unknown}
    if (body.model !== model || !Array.isArray(body.vectors) || body.vectors.length !== texts.length ||
      body.vectors.some(vector => !Array.isArray(vector) || vector.length < 1 || vector.length > 4096 || vector.some(value => typeof value !== "number" || !Number.isFinite(value)))) throw new Error("Invalid embedding response")

    return body.vectors as number[][]
  }}
}
