/**
 * Replay surfacing (U6, R13).
 *
 * The browser session is created with `recording: true`; after the session is
 * released (via `browser.close()`), Solari uploads the rrweb recording
 * asynchronously. This module polls `downloadReplay` for a bounded window to
 * ride out that async upload (the same retry shape as the Python recording
 * example, ported to the TS surface), writes the NDJSON payload to
 * `run-output/replay.ndjson`, and prints the shareable `getReplayUrl` link
 * plus a retention note.
 *
 * The poll runs while the browser `Solari` client is still open: the replay
 * endpoints ride the client's connection pool, so the client must NOT be
 * closed before the download settles (the staged-teardown order U6 uses).
 *
 * The download is not on the run's critical path: if it never becomes
 * available within the retry window, the run logs a warning and falls back to
 * printing the session id and the replay link, per R13.
 */
import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, isAbsolute, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import type { RunLogger } from "./runlog.ts"

const STAGE = "replay"
const EXAMPLE_DIR = dirname(fileURLToPath(import.meta.url))
/**
 * Retry budget for the async replay upload. The upload is async after the
 * session is released and has been observed (live 2026-09-03) to take up to
 * ~30s on healthy recordings; the poll covers that window plus margin.
 */
const POLL_ATTEMPTS = 15
const POLL_DELAY_MS = 3_000

/** The subset of the browser Solari client this module calls. */
export interface ReplayClientLike {
  sessions: {
    downloadReplay(id: string): Promise<Uint8Array>
    getReplayUrl(id: string): Promise<{ url: string; expiresInSeconds: number }>
  }
}

/** What the run reports about the replay, whether or not it downloaded. */
export interface ReplayResult {
  sessionId: string
  downloaded: boolean
  /** Absolute path of the written NDJSON when downloaded. */
  replayPath?: string
  /** Shareable replay link when the gateway provides one. */
  replayUrl?: string
}

/** Resolve the local replay output path (default run-output/replay.ndjson). */
export function replayFilePath(): string {
  return resolve(EXAMPLE_DIR, "run-output", "replay.ndjson")
}

/**
 * Poll the session replay until it downloads or the retry budget is spent.
 * Never throws: the run proceeds (and surfaces the session id / link) even
 * when the replay never becomes available, per R13's fallback.
 */
export async function fetchSessionReplay(
  client: ReplayClientLike,
  sessionId: string,
  logger: RunLogger,
): Promise<ReplayResult> {
  const base: ReplayResult = { sessionId, downloaded: false }
  for (let attempt = 1; attempt <= POLL_ATTEMPTS; attempt++) {
    // The upload happens asynchronously AFTER the session is released, so the
    // first polls usually 404 even on a healthy recording. Sleep first, then
    // try — matching the Python example's rhythm.
    await new Promise((resolvePromise) => setTimeout(resolvePromise, POLL_DELAY_MS))
    try {
      const bytes = await client.sessions.downloadReplay(sessionId)
      if (bytes.length === 0) {
        logger.warn(STAGE, `attempt ${attempt}/${POLL_ATTEMPTS}: replay is empty; retrying`)
        continue
      }
      const outPath = replayFilePath()
      mkdirSync(dirname(outPath), { recursive: true })
      writeFileSync(outPath, bytes)
      let replayUrl: string | undefined
      try {
        const { url } = await client.sessions.getReplayUrl(sessionId)
        replayUrl = url
      } catch {
        // The link is a nice-to-have; the local file is the primary artifact.
      }
      logger.info(
        STAGE,
        `replay downloaded: ${bytes.length} bytes → ${outPath}` +
          (replayUrl ? ` (share: ${replayUrl})` : ""),
      )
      return { sessionId, downloaded: true, replayPath: outPath, replayUrl }
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause)
      logger.info(
        STAGE,
        `attempt ${attempt}/${POLL_ATTEMPTS}: replay not uploaded yet (${detail})`,
      )
    }
  }
  // Give up: surface the session id and any shareable link, plus the retention
  // note, so a reviewer can still watch the run in the console.
  let replayUrl: string | undefined
  try {
    const { url } = await client.sessions.getReplayUrl(sessionId)
    replayUrl = url
  } catch {
    // no link yet either
  }
  logger.warn(
    STAGE,
    `replay not available after ~${Math.round((POLL_ATTEMPTS * POLL_DELAY_MS) / 1000)}s. ` +
      `Session ${sessionId} was recorded — watch it in the Solari console ` +
      (replayUrl ? `or open ${replayUrl}. ` : "") +
      `(replays are retained for the plan tier's window, then expire).`,
  )
  return { ...base, replayUrl }
}
