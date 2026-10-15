import { expect, test } from "bun:test"
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { exportTranscript } from "../src/capture.ts"

/** A stand-in for the CLI: writes a payload far larger than any pipe buffer. */
function fakeExport(lines: number, exit = 0): { executable: string; directory: string; spool: string } {
  const directory = mkdtempSync(join(tmpdir(), "optmem-export-"))
  const spool = join(directory, "spool")
  mkdirSync(spool)
  const executable = join(directory, "fake-export.sh")
  writeFileSync(executable, [
    "#!/bin/sh",
    // The real CLI loses output unless stdout is a real file, so refuse anything else.
    "if [ ! -f /dev/stdout ]; then echo 'transcript needs a real file, not a pipe' >&2; exit 9; fi",
    "awk 'BEGIN { for (i = 0; i < " + lines + "; i++) print \"{\\\"id\\\":\\\"msg_\" i \"\\\",\\\"type\\\":\\\"assistant\\\"}\" }'",
    "exit " + exit,
    "",
  ].join("\n"))
  chmodSync(executable, 0o755)
  return { executable, directory, spool }
}

const signal = () => AbortSignal.timeout(60_000)

test("a large export arrives complete instead of being truncated by the pipe", async () => {
  const { executable, directory, spool } = fakeExport(120_000)
  try {
    const raw = await exportTranscript(executable, "ses_big", directory, signal(), undefined, spool)
    // 120k lines of JSON: several megabytes, well past any pipe buffer.
    expect(raw.length).toBeGreaterThan(4_000_000)
    const parsed = JSON.parse(`[${raw.trim().split("\n").join(",")}]`) as Array<{ id: string; type: string }>
    expect(parsed.length).toBe(120_000)
    expect(parsed[0]!.id).toBe("msg_0")
    // The spooled export is removed: transcripts must not accumulate on disk.
    expect(readdirSync(spool)).toEqual([])
  } finally { Bun.spawnSync(["rm", "-rf", directory]) }
})

test("a failed export rejects and leaves nothing behind", async () => {
  const { executable, directory, spool } = fakeExport(10, 3)
  try {
    await expect(exportTranscript(executable, "ses_fail", directory, signal(), undefined, spool)).rejects.toThrow("Full transcript export failed")
    expect(readdirSync(spool)).toEqual([])
  } finally { Bun.spawnSync(["rm", "-rf", directory]) }
})

test("an aborted export rejects instead of hanging", async () => {
  const directory = mkdtempSync(join(tmpdir(), "optmem-export-"))
  const spool = join(directory, "spool")
  mkdirSync(spool)
  const executable = join(directory, "slow-export.sh")
  writeFileSync(executable, "#!/bin/sh\nsleep 30\n")
  chmodSync(executable, 0o755)
  try {
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 200).unref?.()
    await expect(exportTranscript(executable, "ses_slow", directory, controller.signal, undefined, spool)).rejects.toThrow("Full transcript export failed")
    expect(readdirSync(spool)).toEqual([])
  } finally { Bun.spawnSync(["rm", "-rf", directory]) }
})