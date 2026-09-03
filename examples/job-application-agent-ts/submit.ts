/**
 * Browser fill, resume upload, submit, and verify (U5).
 *
 * Drives the sandbox-hosted application form (U4) with the tailored draft
 * using the SAME cloud-browser Page the read stage used (R10): navigate to the
 * hosted form, fill every control by its stable `name` attribute, attach the
 * persona's resume, click submit, and confirm the success page appeared.
 * Returns a receipt (`SubmitResult`) describing exactly what was submitted.
 *
 * Boundary (R11): this module never accepts a submit target other than
 * `opts.formUrl` — the sandbox-hosted URL the pipeline itself serves. There is
 * no code path that navigates to any external ATS; `submitApplication` issues
 * exactly one `goto`, to `formUrl`.
 *
 * The Page is typed structurally as `SubmitPageLike` (mirroring posting.ts) so
 * this module typechecks without a `playwright`/`patchright-core` dependency;
 * the real Playwright-compatible Page that `@solarisdk/browser` launches
 * satisfies it at runtime. Selectors target the form's own `name` attributes,
 * which are stable by construction (the form is ours).
 *
 * Resume upload note (KTD3 deviation): KTD3 says to hand the local file path
 * to `setInputFiles`. Because the browser runs in Solari's cloud, a bare local
 * path would have to be resolved on the remote browser host — the uncertainty
 * the doc review flagged. This module instead reads the resume into a Buffer
 * locally and passes the in-memory payload form `{ name, mimeType, buffer }`,
 * the standard Playwright way to upload local bytes to a (possibly remote)
 * browser. It satisfies the same R10 requirement with no path-resolution
 * risk. Mime type is derived from the file extension.
 */
import { readFileSync } from "node:fs"
import type { Buffer } from "node:buffer"
import { basename, extname } from "node:path"
import type { RunLogger } from "./runlog.ts"
import type { ApplicationDraft, JobPosting, Persona } from "./types.ts"

const STAGE = "submit"
const NAV_TIMEOUT_MS = 45_000
const WAIT_TIMEOUT_MS = 15_000

/** The success page the sandbox server returns after a stored POST. */
const SUCCESS_SELECTOR = "text=Application received"

/**
 * The subset of the Playwright Page API this module calls. Kept structural so
 * submit.ts typechecks without a `playwright` dependency; the SDK's launched
 * (patchright-core / Playwright-compatible) Page satisfies it at runtime.
 */
export interface SubmitPageLike {
  goto(url: string, options?: { waitUntil?: string; timeout?: number }): Promise<unknown>
  waitForSelector(selector: string, options?: { timeout?: number }): Promise<unknown>
  locator(selector: string): SubmitLocatorLike
}

/** The subset of the Playwright Locator API this module calls. */
export interface SubmitLocatorLike {
  fill(value: string): Promise<void>
  setInputFiles(files: string | SubmitFilePayload): Promise<void>
  click(): Promise<void>
}

/**
 * In-memory file payload for `setInputFiles` — the Playwright way to push
 * local bytes at a (possibly remote) browser without resolving a local path on
 * the browser host. Mirrors Playwright's `{ name, mimeType, buffer }` shape.
 */
export interface SubmitFilePayload {
  name: string
  mimeType: string
  buffer: Buffer
}

/** What was submitted, returned once the success page appeared. */
export interface SubmitResult {
  /** The hosted form URL the submission went to (R11: always opts.formUrl). */
  submittedTo: string
  /** Identity fields actually filled, keyed by form field name. */
  fields: { fullName: string; email: string; role: string }
  /** The resume file name attached to the upload control. */
  resumeFileName: string
  /** True when the "Application received" success page appeared. */
  confirmed: boolean
  /** ISO 8601 UTC timestamp of the confirmed submission. */
  submittedAt: string
}

/** Text-ish controls, each keyed by its stable form `name` attribute. */
const FIELD_FILLS = [
  ["fullName", "persona.name"],
  ["email", "persona.email"],
  ["role", "job.role"],
  ["coverLetter", "draft.coverLetter"],
  ["whyThisRole", "draft.answers.whyThisRole"],
  ["whyThisCompany", "draft.answers.whyThisCompany"],
  ["relevantExperience", "draft.answers.relevantExperience"],
] as const

/** Map a resume file extension to a browser-upload mime type. */
export function mimeTypeForResume(resumeFile: string): string {
  switch (extname(resumeFile).toLowerCase()) {
    case ".txt":
      return "text/plain"
    case ".pdf":
      return "application/pdf"
    case ".md":
      return "text/markdown"
    default:
      return "application/octet-stream"
  }
}

/**
 * Fill the hosted form with the tailored draft, upload the persona's resume,
 * submit, and confirm receipt (R10, R11).
 *
 * `persona.resumeFile` must be an absolute local path (config.ts resolves it
 * that way). Only `formUrl` is ever navigated to. Throws a descriptive Error
 * if the form does not appear or the success page does not show in time, so
 * the U6 orchestrator's `finally` cleanup still runs.
 */
export async function submitApplication(
  page: SubmitPageLike,
  opts: {
    formUrl: string
    persona: Persona
    job: JobPosting
    draft: ApplicationDraft
  },
  logger: RunLogger,
): Promise<SubmitResult> {
  const { formUrl, persona, job, draft } = opts

  // 1. Navigate to the hosted form and wait for it to render.
  logger.info(STAGE, `navigating to the hosted application form: ${formUrl}`)
  await page.goto(formUrl, { waitUntil: "networkidle", timeout: NAV_TIMEOUT_MS })
  try {
    await page.waitForSelector("form", { timeout: WAIT_TIMEOUT_MS })
  } catch (cause) {
    throw new Error(
      `hosted application form did not appear at ${formUrl} within ${WAIT_TIMEOUT_MS}ms`,
      { cause },
    )
  }

  // 2. Fill controls by their stable `name` attributes.
  const fillValues: Record<string, string> = {
    fullName: persona.name,
    email: persona.email,
    role: job.role,
    coverLetter: draft.coverLetter,
    whyThisRole: draft.answers.whyThisRole,
    whyThisCompany: draft.answers.whyThisCompany,
    relevantExperience: draft.answers.relevantExperience,
  }
  for (const [name] of FIELD_FILLS) {
    await page.locator(`[name="${name}"]`).fill(fillValues[name])
  }
  logger.info(
    STAGE,
    "filled form fields: " +
      FIELD_FILLS.map(([name]) => name).join(", "),
  )

  // 3. Resume upload: read the local file into memory and hand the bytes to
  //    setInputFiles (KTD3 buffer-form deviation, see module doc).
  let resumeBytes: Buffer
  try {
    resumeBytes = readFileSync(persona.resumeFile)
  } catch (cause) {
    throw new Error(
      `could not read the persona resume file for upload: ${persona.resumeFile}`,
      { cause },
    )
  }
  const resumeFileName = basename(persona.resumeFile)
  const resumePayload: SubmitFilePayload = {
    name: resumeFileName,
    mimeType: mimeTypeForResume(persona.resumeFile),
    buffer: resumeBytes,
  }
  await page.locator('input[name="resume"]').setInputFiles(resumePayload)
  logger.info(STAGE, `attached resume file: ${resumeFileName} (${resumePayload.mimeType})`)

  // 4. Submit and confirm the success page ("Application received").
  await page.locator('button[type="submit"]').click()
  try {
    await page.waitForSelector(SUCCESS_SELECTOR, { timeout: WAIT_TIMEOUT_MS })
  } catch (cause) {
    throw new Error(
      `application submission to ${formUrl} was not confirmed: the ` +
        `"Application received" success page did not appear within ${WAIT_TIMEOUT_MS}ms`,
      { cause },
    )
  }

  const result: SubmitResult = {
    submittedTo: formUrl,
    fields: {
      fullName: persona.name,
      email: persona.email,
      role: job.role,
    },
    resumeFileName,
    confirmed: true,
    submittedAt: new Date().toISOString(),
  }
  logger.info(
    STAGE,
    `submission confirmed: ${result.fields.role} application from ` +
      `${result.fields.fullName} recorded at ${formUrl}`,
  )
  return result
}
