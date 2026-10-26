import { afterAll, expect, test } from "bun:test"
import { readFileSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { AUDIT_BYTES, AuditLog, type AuditEvent } from "../src/audit.ts"
import { fixture, removeFixtures } from "./fixture.ts"

afterAll(removeFixtures)

const event: AuditEvent = { session: "ses_now", mode: "search", status: "ok", duration_ms: 1, results: 0 }

test("audit appends private JSONL and rotates at the size bound, retaining one previous file", () => {
  const f = fixture()
  const path = join(f.root, "audit.jsonl")
  const warnings: string[] = []
  const audit = new AuditLog(path, message => warnings.push(message))
  audit.record(event)
  audit.record(event)
  expect(readFileSync(path, "utf8").trim().split("\n")).toHaveLength(2)
  expect(statSync(path).mode & 0o777).toBe(0o600)

  writeFileSync(path, "a".repeat(AUDIT_BYTES))
  audit.record(event)
  expect(statSync(`${path}.1`).size).toBe(AUDIT_BYTES)
  expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject(event)
  expect(statSync(path).size).toBeLessThanOrEqual(AUDIT_BYTES)

  writeFileSync(path, "b".repeat(AUDIT_BYTES))
  audit.record(event)
  expect(readFileSync(`${path}.1`, "utf8")).toBe("b".repeat(AUDIT_BYTES))
  expect(warnings).toEqual([])
})

test("audit failure warns once without exposing the path or throwing", () => {
  const f = fixture()
  const warnings: string[] = []
  const audit = new AuditLog(join(f.path, "audit.jsonl"), message => warnings.push(message))
  audit.record(event)
  audit.record(event)
  expect(warnings).toEqual(["history_search audit unavailable; tool calls still work"])
})
