#!/usr/bin/env tsx
/**
 * Job-application agent — orchestration entry point (U6).
 *
 * Runs the F1/F2 pipeline end to end:
 *
 *   1. Boot the sandbox-hosted safe application form (U4).
 *   2. Launch a RECORDED cloud browser (R13) and read the target posting
 *      through it (U2) — the default target is Pinetree's live careers page,
 *      overridable via JOB_URL.
 *   3. Research the employer's homepage (U2) for company context.
 *   4. Tailor the application (U3) — deterministic by default, or through the
 *      configured LLM provider with an automatic deterministic fallback (R8).
 *   5. Fill and submit the hosted form with the same browser session (U5),
 *      which never touches a real employer (R11).
 *   6. Surface the rrweb session replay (R13) and print a submission receipt.
 *
 * Cleanup is a STAGED teardown (the order matters — see `run()`): the browser
 * session is closed first (which releases it and starts the async replay
 * upload), the replay poll and the sandbox submission read-back run while the
 * browser client and sandbox are still alive, and only then does the final
 * `finally` kill the sandbox and close the browser client. Closing the client
 * or killing the sandbox before the replay/receipt reads would break both.
 *
 * Exit codes: 0 on a successful run, 1 on any failure (including the R3
 * posting-unavailable diagnostic).
 */
import { Solari } from "@solarisdk/browser"
import { loadConfig } from "./config.ts"
import { PostingUnavailableError, readPosting, researchCompany } from "./posting.ts"
import { RunLogger } from "./runlog.ts"
import { fetchSessionReplay } from "./replay.ts"
import {
  GUEST_SUBMISSIONS_DIR,
  disposeHostedForm,
  hostApplicationForm,
  type HostedForm,
} from "./sandbox-host.ts"
import { submitApplication } from "./submit.ts"
import { tailorApplication } from "./tailor.ts"
import type { ApplicationDraft, CompanyContext, JobPosting } from "./types.ts"

const STAGE = "run"
const READ_POSTING_TIMEOUT_MS = 60_000

async function readSandboxReceipt(hosted: HostedForm, logger: RunLogger): Promise<string[]> {
  // The sandbox server stores each POST body as submissions/<stamp>-<len>.txt.
  // Read the newest one back to print a short receipt summary (the read must
  // happen before the sandbox is killed in the staged teardown).
  try {
    const entries = await hosted.sandbox.files.list(GUEST_SUBMISSIONS_DIR)
    const receiptFiles = entries
      .filter((entry) => !entry.dir && entry.name.endsWith(".txt"))
      .sort((a, b) => (a.name < b.name ? 1 : -1))
    if (receiptFiles.length === 0) {
      logger.warn(STAGE, "no submission receipt file found in the sandbox")
      return []
    }
    const newest = receiptFiles[0]
    const body = await hosted.sandbox.files.readText(
      `${GUEST_SUBMISSIONS_DIR}/${newest.name}`,
    )
    logger.info(STAGE, `submission receipt: ${newest.name} (${body.length} bytes)`)
    return body.split("\n").filter((line) => line.length > 0)
  } catch (cause) {
    logger.warn(
      STAGE,
      `could not read the sandbox submission receipt: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    )
    return []
  }
}

/**
 * The F1/F2 pipeline body. Owns the staged teardown: every resource it opens
 * is guaranteed released, and the replay/receipt reads happen at the one point
 * in the sequence where the client and sandbox are still alive.
 */
async function run(config: ReturnType<typeof loadConfig>, logger: RunLogger): Promise<number> {
  let hosted: HostedForm | null = null
  let solari: Solari | null = null
  let browser: Awaited<ReturnType<Solari["launch"]>> | null = null

  try {
    // 1. Boot the safe target form first so it warms up while we read.
    logger.info(STAGE, `target posting: ${config.jobUrl}`)
    hosted = await hostApplicationForm(config, logger)
    logger.info(STAGE, `hosted application form ready: ${hosted.url}`)

    // 2. Launch the RECORDED cloud browser (R13) and read the posting.
    solari = new Solari({
      apiKey: config.solariApiKey,
      ...(config.solariBaseUrl ? { baseUrl: config.solariBaseUrl } : {}),
    })
    browser = await solari.launch({ recording: true })
    const sessionId = browser.id
    logger.info(STAGE, `browser session (recording): ${sessionId}`)

    const page = await browser.newPage()
    let job: JobPosting
    try {
      job = await readPosting(page, config.jobUrl)
    } catch (cause) {
      if (cause instanceof PostingUnavailableError) {
        // R3 diagnostic: name the URL and the override variable, exit non-zero.
        logger.error(
          STAGE,
          `${cause.message} — set ${cause.overrideVar} to point at another posting.`,
        )
        return 1
      }
      throw cause
    }
    logger.info(
      STAGE,
      `posting read: ${job.role} at ${job.employer} (${job.location})`,
    )

    // 3. Research the employer homepage (R4); fail soft to null context.
    let company: CompanyContext | null = null
    try {
      company = await researchCompany(page, config.jobUrl)
      logger.info(STAGE, `company context: ${company.name}`)
    } catch (cause) {
      logger.warn(
        STAGE,
        `company research failed; tailoring without context: ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
      )
    }

    // 4. Tailor (R6/R7/R8): deterministic by default; LLM with fallback.
    const draft: ApplicationDraft = await tailorApplication(
      config,
      config.persona,
      job,
      company,
      logger,
    )
    logger.info(STAGE, "application drafted (cover letter + form answers)")

    // 5. Fill and submit the hosted form with the SAME browser session (R10).
    const result = await submitApplication(
      page,
      {
        formUrl: hosted.url,
        persona: config.persona,
        job,
        draft,
      },
      logger,
    )
    logger.info(
      STAGE,
      `submission confirmed for ${result.fields.role} ` +
        `(resume: ${result.resumeFileName}) at ${result.submittedTo}`,
    )

    // 6a. Close the browser session FIRST: this releases it and starts the
    //     async replay upload. The client stays open for the replay call.
    await browser.close()
    browser = null
    logger.info(STAGE, `browser session ${sessionId} closed (replay upload started)`)

    // 6b. Poll the replay download and read the sandbox receipt WHILE the
    //     browser client and sandbox are still alive (staged teardown).
    const replay = await fetchSessionReplay(solari, sessionId, logger)
    const receiptLines = await readSandboxReceipt(hosted, logger)

    logger.info(STAGE, "run complete")
    if (replay.downloaded) {
      logger.info(STAGE, `replay saved to ${replay.replayPath}`)
    }
    if (receiptLines.length > 0) {
      logger.info(STAGE, `sandbox stored ${receiptLines.length} submission line(s)`)
    }
    return 0
  } finally {
    // 6c. Guaranteed cleanup (R14), in dependency order:
    //     kill the sandbox, then close the browser client. Both idempotent.
    if (browser) {
      await browser.close().catch(() => {})
    }
    if (hosted) {
      await disposeHostedForm(hosted).catch(() => {})
    }
    if (solari) {
      await solari.close().catch(() => {})
    }
  }
}

async function main(): Promise<number> {
  const logger = new RunLogger()
  let config
  try {
    config = loadConfig()
  } catch (cause) {
    logger.error(STAGE, cause instanceof Error ? cause.message : String(cause))
    return 1
  }
  logger.info(STAGE, `job-application-agent run starting (persona: ${config.persona.name})`)
  try {
    return await run(config, logger)
  } catch (cause) {
    logger.error(STAGE, cause instanceof Error ? cause.message : String(cause))
    return 1
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = await main()
}
