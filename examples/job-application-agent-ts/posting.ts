/**
 * Posting read, normalization, and employer research (U2).
 *
 * Split into a pure parse half (offline-testable) and a live browser half
 * that operates on a minimal `PageLike` structural interface, so this module
 * never imports the Solari browser SDK. The caller (U6 orchestration) obtains
 * a real Playwright `Page` from `@solarisdk/browser` and passes it in.
 *
 * The default target is Pinetree's careers page (a JS-rendered Framer site),
 * which is why the reader is a real cloud browser rather than a plain fetch:
 * the role heading and requirement bullets only exist after script execution.
 */
import type { CompanyContext, JobPosting } from "./types.ts"

/** The env var a runner uses to point the pipeline at a different posting. */
export const JOB_URL_OVERRIDE_VAR = "JOB_URL"

/**
 * Typed error raised when the target page yields no recognizable posting.
 * Carries the URL and the override-variable name so the orchestrator can
 * print the R3 diagnostic (actionable, names both, exits non-zero).
 */
export class PostingUnavailableError extends Error {
  readonly url: string
  readonly overrideVar: string

  constructor(url: string) {
    super(
      `no job posting found at ${url}. ` +
        `The page may have changed or be unreachable. ` +
        `Set ${JOB_URL_OVERRIDE_VAR} to point at another posting.`,
    )
    this.name = "PostingUnavailableError"
    this.url = url
    this.overrideVar = JOB_URL_OVERRIDE_VAR
  }
}

/**
 * The subset of the Playwright Page API this module calls. Kept structural so
 * posting.ts typechecks and offline-tests without a `playwright` dependency;
 * the SDK's launched Page satisfies it at runtime.
 */
export interface PageLike {
  goto(url: string, options?: { waitUntil?: string; timeout?: number }): Promise<unknown>
  evaluate<R>(fn: () => R | Promise<R>): Promise<R>
  locator(selector: string): { innerText(): Promise<string> }
  waitForSelector(selector: string, options?: { timeout?: number }): Promise<unknown>
}

/**
 * A narrower Page surface sufficient for company research: navigation plus a
 * meta-tag read. og:meta tags live in the static HTML head and need no JS
 * render, so research needs no locator or waitForSelector.
 */
export interface ResearchPageLike {
  goto(url: string, options?: { waitUntil?: string; timeout?: number }): Promise<unknown>
  evaluate<R>(fn: () => R | Promise<R>): Promise<R>
}

// A role heading candidate: a line ending in a known role suffix. Rejected
// later if it reads as a sentence rather than a title-case heading.
const ROLE_HEADING_RE =
  /(?:^|\n)([A-Z][A-Za-z0-9 ,+&/-]{2,80}?(?:Researcher|Engineer|Scientist|Developer|Intern|Manager|Designer|Analyst|Architect))\s*(?:\n|$)/

/** Lowercase filler words that mark a sentence rather than a role heading. */
const FILLER_WORD_RE =
  /\b(for|our|the|and|next|looking|join|we'?re|you|your|a|an|to|with|who|will|can)\b/i

/** A candidate heading is a role title only if it stays title-case. */
function isLikelyRoleHeading(candidate: string): boolean {
  if (candidate.length > 60) return false
  return !FILLER_WORD_RE.test(candidate)
}
/** A line like "Remote / USA" or "Remote (US)" or "Palo Alto, CA". */
const LOCATION_RE = /(Remote(?:\s*\/\s*[A-Za-z ,/-]+)?|(?:[A-Z][A-Za-z .]+,\s*(?:CA|NY|TX|WA|MA|IL|CO|USA|US|UK|GB)))/i

/** Lines that read like requirement bullets once we are inside a listing. */
const REQUIREMENT_MARKER_RE =
  /(?:^|\n)(Requirements|You have|What you('|’)ll do|Qualifications|We('|’)re looking for)\s*(?:\n|$)/
const APPLY_NOTE_RE =
  /(?:^|\n)(How to apply|To apply)(?:\s*:)?\s*(?:\n|$)((?:.|\n){10,300}?)(?=\n[A-Z][a-z]|\n*$)/

/** Title-case the meaningful labels of a posting URL's hostname. */
export function employerFromHostname(sourceUrl: string): string {
  const host = new URL(sourceUrl).hostname.replace(/^www\./, "")
  const labels = host.split(".").filter(Boolean)
  // Drop the TLD (and common second-level TLDs like .co.uk) before picking the
  // two meaningful labels, so "pinetree-research.com" reads "Pinetree Research".
  const TLD_RE = /^(com|org|net|io|ai|dev|co|uk|us|ca|jobs|careers)$/i
  const meaningful: string[] = []
  for (const label of labels) {
    if (TLD_RE.test(label) && meaningful.length > 0) break
    meaningful.push(label)
  }
  const core = meaningful.length >= 2 ? meaningful.slice(-2) : meaningful
  // Split hyphenated labels so "pinetree-research" reads "Pinetree Research".
  return core
    .flatMap((part) => part.split("-"))
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ")
}

/** Collapse a posting URL (possibly a subpath) to its employer origin. */
export function deriveEmployerOrigin(sourceUrl: string): string {
  const url = new URL(sourceUrl)
  return url.origin
}

function firstLineAt(lines: string[], index: number): string {
  return lines[index]?.trim() ?? ""
}

function linesAfterMarker(text: string, marker: RegExp): string[] {
  const lines = text.split("\n").map((l) => l.trim())
  const markerIndex = lines.findIndex((line) => marker.test(line))
  if (markerIndex === -1) return []
  const out: string[] = []
  for (let i = markerIndex + 1; i < lines.length; i++) {
    const line = lines[i]
    if (line === "") continue
    // Stop at the next section-ish heading (short, Title Case, no period).
    if (/^[A-Z][A-Za-z ]{2,40}$/.test(line) && !line.endsWith(".")) break
    out.push(line)
  }
  return out
}

/**
 * Normalize raw page text into a structured JobPosting. PURE and offline.
 *
 * Heuristics are deliberately tolerant: the Pinetree Framer page yields plain
 * innerText with a title-cased role heading, a "Remote / USA" location line,
 * and requirement bullets after markers like "Requirements" / "You have".
 * Throws `PostingUnavailableError` when no role marker is recognizable.
 */
export function parsePostingText(text: string, sourceUrl: string): JobPosting {
  const employer = employerFromHostname(sourceUrl)
  const lines = text.split("\n").map((l) => l.trim())
  const joined = lines.join("\n")

  // Role: prefer a title-cased heading line that names a role. Candidate
  // headings that read as sentences (contain filler words) are rejected so the
  // fallback can extract just the role title from them.
  let role: string | null = null
  const headingMatch = joined.match(ROLE_HEADING_RE)
  if (headingMatch && isLikelyRoleHeading(headingMatch[1].trim())) {
    role = headingMatch[1].trim()
  }
  if (!role) {
    // Fall back to a "looking for our next X" / known-marker line, extracting
    // just the role title rather than the whole sentence.
    const known = lines.find((line) =>
      /(?:Machine Learning Researcher|ML Researcher|Research Engineer)/i.test(line),
    )
    if (known) {
      const match = known.match(
        /(?:Machine Learning Researcher|ML Researcher|Research Engineer)/i,
      )
      role = (match?.[0] ?? known).trim()
    }
  }
  if (!role) {
    throw new PostingUnavailableError(sourceUrl)
  }

  // Location: the first line that looks like a location, near the role.
  const locationLine = lines.find((line) => LOCATION_RE.test(line) && line.length < 60)
  const location = locationLine?.trim() || "Remote"

  // Key requirements: bullets following a requirement marker; else generic
  // sentence lines under the role when a marker is absent.
  let keyRequirements = linesAfterMarker(joined, REQUIREMENT_MARKER_RE).filter(
    (line) => line.length > 12 && !/^(Apply|Email|Don't see)/i.test(line),
  )
  if (keyRequirements.length === 0) {
    const roleIndex = lines.findIndex((l) => l === role)
    keyRequirements = lines
      .slice(roleIndex + 1, roleIndex + 12)
      .filter((line) => line.length > 20 && line.endsWith("."))
      .slice(0, 5)
  }

  // Application notes: copy after a "How to apply" / "To apply" marker.
  let applicationNotes: string | undefined
  const noteMatch = joined.match(APPLY_NOTE_RE)
  if (noteMatch) {
    const note = noteMatch[2].trim()
    if (note) applicationNotes = note
  }

  return {
    employer,
    role,
    location,
    keyRequirements,
    ...(applicationNotes ? { applicationNotes } : {}),
    sourceUrl,
  }
}

/** Read the target posting with a cloud-browser Page and normalize it. */
export async function readPosting(page: PageLike, url: string): Promise<JobPosting> {
  await page.goto(url, { waitUntil: "networkidle", timeout: 45_000 })
  // The Framer site renders its content client-side; wait for real text.
  await page.waitForSelector("body", { timeout: 15_000 })
  await page.evaluate(() => new Promise((r) => setTimeout(r, 1500)))

  // Try resilient locators first (cheap), then fall back to whole-page text.
  let text = ""
  try {
    const heading = await page.locator("h1, h2").innerText()
    if (heading && heading.length > 0) {
      const body = await page.locator("body").innerText()
      text = `${heading}\n${body}`
    }
  } catch {
    /* locator miss — fall through to whole-page text */
  }
  if (!text || text.length === 0) {
    text = await page.locator("body").innerText()
  }
  return parsePostingText(text, url)
}

/** Read the employer homepage and capture a short CompanyContext. */
export async function researchCompany(
  page: ResearchPageLike,
  sourceUrl: string,
): Promise<CompanyContext> {
  const url = deriveEmployerOrigin(sourceUrl)
  const name = employerFromHostname(sourceUrl)
  try {
    await page.goto(url, { waitUntil: "networkidle", timeout: 45_000 })
    const meta = await page.evaluate(() => {
      const pick = (sel: string): string | null =>
        document.querySelector(sel)?.getAttribute("content") ?? null
      return {
        ogTitle: pick('meta[property="og:title"]'),
        ogSiteName: pick('meta[property="og:site_name"]'),
        ogDescription: pick('meta[property="og:description"]'),
      }
    })
    const context: CompanyContext = {
      name: meta.ogSiteName || name,
      url,
    }
    if (meta.ogTitle && meta.ogTitle !== meta.ogSiteName) context.tagline = meta.ogTitle
    if (meta.ogDescription) context.description = meta.ogDescription
    return context
  } catch {
    // Fail soft: tailoring handles an absent company context.
    return { name, url }
  }
}
