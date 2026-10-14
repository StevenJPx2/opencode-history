// The compression loop: read what memo wants next, ask the configured model
// chain for one line, hand it back. Serialized, because memo builds blocks in
// order and only the next one is answerable.

import { bytes, cutTask, line, parsePending, task } from "./compact.ts"

export interface Model {
  readonly providerID: string
  readonly id: string
  readonly variant?: string
}

/** The shape `ctx.model.list()` reports for one model. */
interface Listed {
  readonly providerID: string
  readonly modelID: string
  readonly variants?: readonly { readonly id: string }[]
}

/** Whether OpenCode can actually run this model. */
export function runnable(listed: readonly Listed[], model: Model): boolean {
  return listed.some((entry) =>
    entry.providerID === model.providerID &&
    entry.modelID === model.id &&
    (model.variant === undefined || entry.variants?.some((variant) => variant.id === model.variant) === true),
  )
}

export interface CompressorDeps {
  /** Runs `memo` and returns its output. */
  readonly call: (args: string[]) => Promise<string>
  /** One model call, text in and out. */
  readonly ask: (prompt: string, model: Model) => Promise<string>
  readonly log: (message: string) => void
  readonly models: readonly Model[]
  /** Blocks per pass, so one tick cannot run away. */
  readonly perPass: number
  /** Attempts per block before leaving it for the agent. */
  readonly attempts: number
  /** Delay before continuing after a full batch. Defaults to two seconds. */
  readonly continueAfterMs?: number
}

export class Compressor {
  private running = false
  private stopped = false
  private queued = false
  private rerun = false
  private timer: ReturnType<typeof setTimeout> | undefined

  constructor(private readonly deps: CompressorDeps) {}

  /** Stop starting passes; one in flight finishes first. */
  stop(): void {
    this.stopped = true
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
    this.queued = false
  }

  /** Run a pass soon, collapsing repeated requests into one. */
  schedule(delayMs = 2_000): void {
    if (this.stopped) return
    if (this.running) {
      this.rerun = true
      return
    }
    if (this.queued) return

    this.queued = true
    this.timer = setTimeout(() => {
      this.queued = false
      this.timer = undefined
      if (this.running) {
        this.rerun = true
        return
      }
      void this.pass()
    }, delayMs).unref?.()
  }

  /** Compress up to `perPass` blocks. Never throws. */
  async pass(): Promise<number> {
    if (this.running || this.stopped) return 0

    this.running = true
    let done = 0

    try {
      let last: string | undefined

      for (let index = 0; index < this.deps.perPass; index++) {
        if (this.stopped) break

        const block = await this.one()

        // The same block twice means memo is not moving on, so stop rather
        // than pay for the model again.
        if (block === undefined || block === last) break

        last = block
        done++
      }

      return done
    } catch (error) {
      this.deps.log(`background compression stopped: ${error}`)
      return 0
    } finally {
      this.running = false
      const again = this.rerun || done === this.deps.perPass
      this.rerun = false
      if (again) this.schedule(this.deps.continueAfterMs ?? 2_000)
    }
  }

  /** One block, named, or `undefined` to stop the pass. */
  private async one(): Promise<string | undefined> {
    const pending = parsePending(await this.deps.call(["nap"]))
    if (pending === undefined) return undefined

    const id = `${pending.lo}-${pending.hi}`
    const input = (await this.deps.call(["zoom", id])).trim()
    if (input === "") {
      this.deps.log(`block #${id} has nothing to read; left for the agent`)
      return undefined
    }

    const summary = await this.summarise(pending, input)
    if (summary === undefined) {
      this.deps.log(`block #${id} could not produce a usable line in ${this.deps.attempts} attempts; left for the agent`)
      return undefined
    }

    const written = await this.deps.call(["nap", id, summary])

    // The agent may have answered this block while we were asking.
    if (/already settled|forgotten meanwhile/.test(written)) return id

    if (/Too long|wrong block/i.test(written)) {
      this.deps.log(`memo refused #${id}: ${written.split("\n")[0]}`)
      return undefined
    }

    return id
  }

  /** A line for one block, retried by cutting, or `undefined` to leave it. */
  private async summarise(pending: Parameters<typeof task>[0], input: string): Promise<string | undefined> {
    for (let index = 0; index < this.deps.models.length; index++) {
      const model = this.deps.models[index]!
      const summary = await this.summariseWith(pending, input, model)
      if (summary !== undefined) return summary

      if (index + 1 < this.deps.models.length) {
        this.deps.log(`${this.name(model)} failed to summarize; trying ${this.name(this.deps.models[index + 1]!)}`)
      }
    }

    return undefined
  }

  /** Bounded attempts for one model, or undefined to move to its fallback. */
  private async summariseWith(pending: Parameters<typeof task>[0], input: string, model: Model): Promise<string | undefined> {
    let previous: string | undefined

    for (let attempt = 0; attempt < this.deps.attempts; attempt++) {
      const prompt = previous === undefined ? task(pending, input) : cutTask(pending, input, previous, bytes(previous))
      let reply: string

      try {
        reply = line(await this.deps.ask(prompt, model))
      } catch (error) {
        this.deps.log(`${this.name(model)} failed: ${error}`)
        return undefined
      }

      if (reply === "") continue
      if (bytes(reply) <= pending.limit) return reply

      previous = reply
    }

    this.deps.log(`${this.name(model)} exceeded the ${pending.limit}-byte limit ${this.deps.attempts} times`)
    return undefined
  }

  private name(model: Model): string {
    return `${model.providerID}/${model.id}${model.variant ? `#${model.variant}` : ""}`
  }
}
