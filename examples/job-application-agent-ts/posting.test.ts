/**
 * Offline tests for the posting read / normalization unit (U2).
 *
 * Covers the pure parsing half of `posting.ts`: normalizing raw page text
 * into a structured `JobPosting` (R1), the typed "posting unavailable" error
 * that powers the R3 diagnostic (Covers AE2 / R3), and employer-origin
 * derivation from the posting URL (R4's first step). The live browser half
 * (`readPosting`, `researchCompany`) is structural — it operates on a minimal
 * PageLike interface and is exercised against a stub here only for the
 * meta-tag path; full live behavior is verified in the U6 e2e run.
 *
 * No network, no Solari API key. The fixture is modeled on the text of the
 * Pinetree careers page (https://pinetree-research.com/careers, fetched
 * 2026-09-02): a title-cased role heading with "Remote / USA / Apply" nearby
 * and a requirement-marker paragraph, the shape a JS-rendered Framer site
 * yields as plain innerText.
 */
import { test } from "node:test"
import assert from "node:assert/strict"

import {
  PostingUnavailableError,
  deriveEmployerOrigin,
  parsePostingText,
  researchCompany,
} from "./posting.ts"
import type { CompanyContext, JobPosting } from "./types.ts"

const POSTING_URL = "https://pinetree-research.com/careers"

/** Representative listing text modeled on the Pinetree careers page. */
const LISTING_TEXT = [
  "Careers",
  "Careers at Pinetree",
  "Our Belief",
  "AI is changing how software is built, how businesses operate, and how people work. At Pinetree, we're building the infrastructure that makes that future possible.",
  "Headquartered in Palo Alto, our team is small, highly technical, and focused on shipping quickly.",
  "Our Values",
  "Think from first principles",
  "Build what lasts",
  "Open Roles",
  "Machine Learning Researcher",
  "Remote / USA",
  "Apply",
  "Requirements",
  "You have 4+ years building production ML systems",
  "Experience deploying LLM-based agents to real users",
  "You have strong fundamentals in PyTorch or JAX",
  "What you'll do",
  "Design and ship new autonomous-agent capabilities",
  "Don't see a role that fits?",
  "Email your resume and a short note to hello@pinetree-research.com",
].join("\n")

test("parsePostingText extracts employer, role, location, and key requirements", () => {
  const posting: JobPosting = parsePostingText(LISTING_TEXT, POSTING_URL)

  assert.equal(posting.sourceUrl, POSTING_URL)
  assert.equal(
    posting.employer,
    "Pinetree Research",
    "employer is derived from the posting URL hostname",
  )
  assert.equal(
    posting.role,
    "Machine Learning Researcher",
    "role comes from the title-case heading line",
  )
  assert.equal(posting.location, "Remote / USA")
  assert.ok(posting.keyRequirements.length >= 3, "requirement lines are captured")
  assert.ok(
    posting.keyRequirements.some((r) => /4\+ years/.test(r)),
    "a requirement-marker bullet line is captured verbatim",
  )
  assert.ok(
    posting.keyRequirements.some((r) => /PyTorch or JAX/.test(r)),
    "a 'You have' bullet line is captured verbatim",
  )
})

test("parsePostingText falls back to a known role marker when no heading matches", () => {
  // A text without the exact heading line but with the marker still resolves.
  const withoutHeading = [
    "Careers at Pinetree",
    "Looking for our next Machine Learning Researcher",
    "Remote / USA",
    "Apply",
    "Requirements",
    "You have 4+ years building production ML systems",
  ].join("\n")

  const posting: JobPosting = parsePostingText(withoutHeading, POSTING_URL)
  assert.equal(posting.role, "Machine Learning Researcher")
  assert.equal(posting.employer, "Pinetree Research")
})

test("parsePostingText returns optional application notes when apply copy is present", () => {
  const withNotes = [
    "Careers at Pinetree",
    "Machine Learning Researcher",
    "Remote / USA",
    "Apply",
    "How to apply",
    "Email your resume and a short note to hello@pinetree-research.com",
  ].join("\n")

  const posting: JobPosting = parsePostingText(withNotes, POSTING_URL)
  assert.equal(posting.applicationNotes, "Email your resume and a short note to hello@pinetree-research.com")
})

test("parsePostingText with no role markers throws PostingUnavailableError naming url and JOB_URL", () => {
  const noRole = [
    "Careers at Pinetree",
    "We are not hiring right now",
    "Thanks for your interest",
  ].join("\n")

  assert.throws(
    () => parsePostingText(noRole, POSTING_URL),
    (err: unknown) => {
      assert.ok(err instanceof PostingUnavailableError, "error is the typed class")
      assert.ok(err instanceof Error, "typed error is a real Error")
      const typed = err as PostingUnavailableError
      assert.equal(typed.url, POSTING_URL, "error carries the target URL (R3 diagnostic)")
      assert.equal(
        typed.overrideVar,
        "JOB_URL",
        "error names the override variable (R3 diagnostic)",
      )
      assert.match(
        err.message,
        /pinetree-research\.com/,
        "message names the URL so an uncaught error is still actionable",
      )
      return true
    },
    "parsePostingText must throw when no role markers are found",
  )
})

test("deriveEmployerOrigin returns the employer homepage for posting subpaths", () => {
  assert.equal(
    deriveEmployerOrigin("https://pinetree-research.com/careers"),
    "https://pinetree-research.com",
    "a single subpath collapses to the origin",
  )
  assert.equal(
    deriveEmployerOrigin("https://pinetree-research.com/careers/"),
    "https://pinetree-research.com",
    "a trailing slash is stripped",
  )
  assert.equal(
    deriveEmployerOrigin("https://www.pinetree-research.com/jobs/machine-learning-researcher"),
    "https://www.pinetree-research.com",
    "a deep path collapses to the origin",
  )
  assert.equal(
    deriveEmployerOrigin("https://careers.acme.com/"),
    "https://careers.acme.com",
    "an origin with no path stays unchanged",
  )
})

test("researchCompany reads og meta tags from the derived homepage via a stubbed PageLike", async () => {
  const page = {
    goto: async (url: string) => {
      assert.equal(url, "https://pinetree-research.com", "researches the derived origin")
    },
    evaluate: async <R,>() =>
      ({
        ogTitle: "Pinetree",
        ogSiteName: "Pinetree Research",
        ogDescription:
          "We build production-grade systems for autonomous AI agents, enabling them to navigate the web and complete real work reliably at scale.",
      }) as R,
  }
  const context: CompanyContext = await researchCompany(page, POSTING_URL)
  assert.equal(context.name, "Pinetree Research")
  assert.equal(context.tagline, "Pinetree")
  assert.ok(
    context.description && /autonomous AI agents/.test(context.description),
    "description comes from the og:description meta tag",
  )
  assert.equal(context.url, "https://pinetree-research.com")
})
