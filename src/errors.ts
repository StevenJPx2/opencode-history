// Every message here is fixed text: it is stored with queued jobs and logged,
// so it must never carry passage, prompt or provider text.

export class MemoryError extends Error {}

/** Every configured model is cooling down after failures. Retry at `until`. */
export class GenerationUnavailable extends MemoryError {
  constructor(readonly until: number) {
    super(`All historian models are cooling down until ${new Date(until).toISOString()}`)
  }
}

/** OpenCode interrupted the call, for example while reloading. Not an outage. */
export class GenerationInterrupted extends MemoryError {
  constructor() { super("Historian call was interrupted by OpenCode") }
}

/** The plugin itself cancelled the call while shutting down. */
export class GenerationCancelled extends MemoryError {
  constructor() { super("Historian call was cancelled") }
}

/** No ordinary session exists to parent a hidden historian child yet. */
export class GenerationDeferred extends MemoryError {
  readonly until = Date.now() + 30_000
  constructor() { super("Historian is waiting for a parent session") }
}
