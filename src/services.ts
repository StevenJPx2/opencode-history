import type { Embeddings } from "./historian.ts"

function local(url: string): URL {
  const parsed = new URL(url)
  if (parsed.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname) || parsed.username || parsed.password) throw new Error("Memory services must use loopback HTTP")

  return parsed
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
