/**
 * Structured run logger for the job-application-agent example.
 *
 * Every step record (R12) is a single JSON object with an ISO 8601 UTC
 * timestamp, stage, level, and message. Each record is written to an injected
 * sink (defaults to stdout) AND appended to the run log file at
 * `run-output/run.log` (directory created on first write). Both paths stay
 * swappable so the offline tests can capture output without touching the
 * example directory.
 *
 * File writes are synchronous so a record is guaranteed on disk the moment
 * info()/warn()/error() returns — important for a CLI whose process may exit
 * right after logging.
 */
import { appendFileSync, mkdirSync } from "node:fs"
import { dirname, isAbsolute, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import type { StepRecord } from "./types.ts"

const EXAMPLE_DIR = dirname(fileURLToPath(import.meta.url))

/** Sink for console-style output; a function writing one full line. */
export type OutputSink = (line: string) => void

export interface RunLoggerOptions {
  /**
   * Run log file path. Relative paths resolve against the example directory,
   * so the default lands at `examples/job-application-agent-ts/run-output/run.log`.
   */
  logFilePath?: string
  /** Console sink. Defaults to process.stdout.write (one line per record). */
  sink?: OutputSink
}

export class RunLogger {
  private readonly logFilePath: string
  private readonly sink: OutputSink

  constructor(options: RunLoggerOptions = {}) {
    this.logFilePath = options.logFilePath ?? "run-output/run.log"
    this.sink = options.sink ?? ((line) => process.stdout.write(line + "\n"))
  }

  info(stage: string, message: string): void {
    this.record("info", stage, message)
  }

  warn(stage: string, message: string): void {
    this.record("warn", stage, message)
  }

  error(stage: string, message: string): void {
    this.record("error", stage, message)
  }

  private record(
    level: StepRecord["level"],
    stage: string,
    message: string,
  ): void {
    const record: StepRecord = {
      timestamp: new Date().toISOString(),
      stage,
      level,
      message,
    }
    const line = JSON.stringify(record)
    this.sink(line)
    this.appendLine(line)
  }

  private appendLine(line: string): void {
    const logFilePath = isAbsolute(this.logFilePath)
      ? this.logFilePath
      : resolve(EXAMPLE_DIR, this.logFilePath)
    mkdirSync(dirname(logFilePath), { recursive: true })
    appendFileSync(logFilePath, line + "\n", "utf8")
  }
}
