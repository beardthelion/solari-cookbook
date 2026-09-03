/**
 * Sandbox-hosted safe application form (U4, R9/R11, KTD2).
 *
 * Stands up the ATS-shaped application form inside a Solari sandbox and
 * exposes it on the sandbox's public preview URL. The pipeline (U6) boots
 * this module BEFORE the cloud browser, then points the browser at the
 * returned `url` to fill and submit (U5). Submitting anywhere else never
 * happens: this module's returned URL is the only automatic submit target.
 *
 * The form itself (`form/index.html`) and the ~40-line stdlib server
 * (`form/server.py`) are local files in this example directory, written into
 * the guest working dir `/opt/form` via `files.write`. The server runs
 * backgrounded (`sh -c` + nohup, per the sandbox commands gotcha: `commands.run`
 * waits for the process to exit, so a foreground server would block until the
 * idle timeout) and listens on a fixed high port the preview gateway maps.
 *
 * This module is SDK I/O — per KTD5 it carries no offline unit test; the live
 * U6 end-to-end run verifies it. Teardown is owned by U6 via
 * `hosted.sandbox.kill()` (R14), which this module also exposes as `dispose`.
 */
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { SandboxClient, type Sandbox } from "@solarisdk/sdk"
import type { RunLogger } from "./runlog.ts"
import type { RunConfig } from "./types.ts"

const STAGE = "sandbox-host"

/** In-guest working directory that receives the form, server, and submissions. */
export const GUEST_FORM_DIR = "/opt/form"
/** In-guest path where the server stores raw POST bodies. */
export const GUEST_SUBMISSIONS_DIR = join(GUEST_FORM_DIR, "submissions")
/** Fixed high port for the form server; unlikely to collide inside the sandbox. */
export const FORM_PORT = 8787
/** Idle timeout passed to sandbox create: the form lives ~10 minutes max. */
const SANDBOX_TIMEOUT_MS = 10 * 60_000
/** Poll cadence when waiting for the preview URL to serve HTTP 200. */
const READY_POLL_MS = 1000

/** Resolve a local form asset path relative to this module (examples/.../form). */
export function formAssetPath(fileName: "index.html" | "server.py"): string {
  return join(dirname(fileURLToPath(import.meta.url)), "form", fileName)
}

/** The handle U6 uses to submit (U5) and later release (R14). */
export interface HostedForm {
  /** The live sandbox session; U6 calls `hosted.sandbox.kill()` in `finally`. */
  sandbox: Sandbox
  /** Public preview URL the browser submits to (R11: the only submit target). */
  url: string
  /** Signed preview access token, when the gateway issues one. */
  token?: string
  /** In-guest port the form server listens on (the `:port` of the preview). */
  port: number
  /** In-guest directory where POST bodies are stored as files. */
  submissionsPath: string
}

/**
 * Wait until the hosted form answers HTTP 200, bounded by `attempts`.
 *
 * The sandbox preview answers `425 Too Early` until the in-guest server is
 * actually listening, so readiness is a poll, not a connect (the port-preview
 * pattern). Exported so U5/U6 can re-poll late in a run if needed. Resolves
 * true when a 200 arrives; false when every attempt is a non-200 (incl. 425).
 */
export async function waitForFormReady(
  url: string,
  attempts = 15,
  logger?: RunLogger,
): Promise<boolean> {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const res = await fetch(url)
      if (res.ok) {
        logger?.info(STAGE, `form ready: ${url} answered HTTP ${res.status}`)
        return true
      }
      logger?.info(
        STAGE,
        `form not ready yet (attempt ${attempt}/${attempts}): HTTP ${res.status}`,
      )
    } catch (cause) {
      logger?.info(
        STAGE,
        `form not reachable yet (attempt ${attempt}/${attempts}): ${String(cause)}`,
      )
    }
    if (attempt < attempts) {
      await new Promise((resolve) => setTimeout(resolve, READY_POLL_MS))
    }
  }
  logger?.warn(STAGE, `form did not answer HTTP 200 after ${attempts} attempts: ${url}`)
  return false
}

/**
 * Boot the hosted form end to end: create the sandbox, write the assets,
 * start the server backgrounded, resolve the preview URL, and wait until it
 * serves the form. Throws when any step fails so the U6 orchestrator's
 * `finally` can release whatever was started (R14).
 */
export async function hostApplicationForm(
  config: RunConfig,
  logger: RunLogger,
): Promise<HostedForm> {
  const client = new SandboxClient({
    apiKey: config.solariApiKey,
    baseUrl: config.solariBaseUrl,
  })
  let sandbox: Sandbox | null = null
  try {
    logger.info(STAGE, "creating sandbox (base template)…")
    sandbox = await client.create({ template: "base", timeoutMs: SANDBOX_TIMEOUT_MS })
    logger.info(
      STAGE,
      `sandbox created: id=${sandbox.sandboxId} expires=${sandbox.expiresAt}`,
    )

    logger.info(STAGE, "opening sandbox control channel…")
    await sandbox.connect()

    // Write the local form assets into the guest. `files.write` creates parent
    // directories; the submissions dir is created explicitly so the server's
    // POST path can rely on it (it also mkdirs defensively).
    const indexHtml = readFileSync(formAssetPath("index.html"), "utf8")
    const serverPy = readFileSync(formAssetPath("server.py"), "utf8")
    await sandbox.files.write(join(GUEST_FORM_DIR, "index.html"), indexHtml)
    await sandbox.files.write(join(GUEST_FORM_DIR, "server.py"), serverPy)
    await sandbox.files.mkdir(GUEST_SUBMISSIONS_DIR)
    logger.info(
      STAGE,
      `wrote form assets to ${GUEST_FORM_DIR} (submissions → ${GUEST_SUBMISSIONS_DIR})`,
    )

    // Background the server with a shell: `commands.run` waits for exit, so a
    // foreground `python3 server.py` would block until the idle timeout kills
    // the session. nohup + `&` returns immediately with a low exit code while
    // the server keeps listening (the sandbox-port-preview pattern).
    const start = await sandbox.commands.run("sh", {
      args: [
        "-c",
        `cd ${GUEST_FORM_DIR} && nohup python3 server.py ${FORM_PORT} >server.log 2>&1 &`,
      ],
    })
    if (start.exitCode !== 0) {
      throw new Error(
        `failed to start the form server in the sandbox (exit ${start.exitCode}): ` +
          `${start.stderr || start.stdout}`,
      )
    }
    logger.info(STAGE, `form server started on guest port ${FORM_PORT}`)

    const { url, token } = await sandbox.previewUrl(FORM_PORT)
    logger.info(STAGE, `hosted form preview url: ${url}`)

    const ready = await waitForFormReady(url, 15, logger)
    if (!ready) {
      throw new Error(`hosted form never answered HTTP 200: ${url}`)
    }

    const hosted: HostedForm = {
      sandbox,
      url,
      token,
      port: FORM_PORT,
      submissionsPath: GUEST_SUBMISSIONS_DIR,
    }
    sandbox = null // ownership transferred to the returned handle
    return hosted
  } catch (cause) {
    logger.error(STAGE, `failed to host the application form: ${String(cause)}`)
    // Release anything we started on the failure path (R14); idempotent.
    if (sandbox) await sandbox.kill().catch(() => {})
    throw cause
  }
  // Note: SandboxClient has no close() (its HTTP transport uses global fetch
  // with no persistent socket); the only resource this module holds past
  // return is the sandbox's control WebSocket, owned by the handle and closed
  // by U6's `sandbox.kill()` in its `finally` (R14).
}

/**
 * Release the hosted form's sandbox (R14). U6 owns teardown and calls this
 * (or `hosted.sandbox.kill()` directly) in its `finally`; both are idempotent.
 */
export async function disposeHostedForm(hosted: HostedForm): Promise<void> {
  await hosted.sandbox.kill()
}
