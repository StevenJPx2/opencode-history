// Local secret scrubbing before any archived text reaches a model. Patterns
// favour known credential shapes; a long unbroken high-entropy token is masked
// too, since a missed secret costs more than a masked hash.

const PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\b(?:sk|pk|rk)-(?:proj-|ant-)?[A-Za-z0-9_-]{16,}/g,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/g,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
  /\bAIza[A-Za-z0-9_-]{30,}/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{16,}/gi,
  /([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s@/]+(@)/gi,
]

// `password = hunter2`, `"api_key": "…"`, `TOKEN=…`
const ASSIGNMENT = /\b([A-Za-z0-9_.-]*(?:pass(?:word|wd)?|secret|token|api[_-]?key|private[_-]?key|auth|credential)[A-Za-z0-9_.-]*)(["']?\s*[:=]\s*["']?)(?!(?:Bearer|Basic)\b|\[REDACTED\])([^\s"',;]{6,})/gi

const MASK = "[REDACTED]"

function entropic(word: string): boolean {
  if (word.length < 32 || /^[a-z]+$|^[A-Z]+$|^\d+$/.test(word)) return false
  // Paths and URLs keep their shape; tokens inside them are caught above.
  if (word.includes("/") && word.includes("-")) return false

  const classes = [/[a-z]/, /[A-Z]/, /\d/].filter(re => re.test(word)).length
  return classes >= 3 || (/^[0-9a-f]+$/i.test(word) && word.length >= 40)
}

export function redact(text: string): string {
  let out = text
  for (const pattern of PATTERNS) {
    out = out.replace(pattern, (...match) => {
      const groups = match.slice(1, -2).filter((g): g is string => typeof g === "string")
      // Keep a URL's scheme/user and the `@`, or the auth scheme word.
      if (groups.length === 2) return `${groups[0]}${MASK}${groups[1]}`
      if (groups.length === 1) return `${groups[0]} ${MASK}`
      return MASK
    })
  }
  out = out.replace(ASSIGNMENT, (_, key: string, sep: string) => `${key}${sep}${MASK}`)
  return out.replace(/[A-Za-z0-9+/_=-]{32,}/g, word => entropic(word) ? MASK : word)
}

/**
 * Cheap gate before the historian, which makes the real judgment. One call per
 * turn: the assistant's reply, with the turn's user message as context.
 */
export function worthExtracting(text: string, kind: string): boolean {
  if (kind !== "assistant") return false

  const words = text.trim().split(/\s+/).filter(Boolean)
  return words.length >= 6
}
