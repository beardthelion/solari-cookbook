/**
 * Tailoring stage (U3): deterministic templated copy plus provider
 * orchestration with a guaranteed fallback (KTD4, R6-R8).
 *
 * `renderDeterministicDraft` is a PURE function — same persona, job, and
 * company context always render the same `ApplicationDraft`, so the run is
 * credential-free and reproducible by default. `tailorApplication` selects
 * the LLM path only when config.llm.enabled is true; any LLM failure is
 * logged as a warning and degrades to the deterministic draft (R8: an LLM
 * failure never fails the run on its own).
 */
import { draftWithLlm, LlmDraftError } from "./llm.ts"
import type { RunLogger } from "./runlog.ts"
import type {
  ApplicationDraft,
  CompanyContext,
  JobPosting,
  Persona,
  RunConfig,
} from "./types.ts"

const STAGE = "tailor"

/** Content words: tokenize, drop fillers, keep 2+ char terms ("ML" survives). */
const SKILL_STOP_WORDS = new Set([
  "the", "and", "for", "with", "have", "you", "your", "experience", "years",
  "strong", "building", "build", "production", "systems", "fundamentals",
  "deploying", "real", "users", "etc", "etc.", "and/or", "plus",
])
function tokensOf(text: string): string[] {
  const words = text.toLowerCase().split(/[^a-z0-9.+#-]+/).filter(Boolean)
  const seen = new Set<string>()
  const out: string[] = []
  for (const word of words) {
    const clean = word.replace(/\.$/, "")
    if (clean.length < 2) continue
    if (SKILL_STOP_WORDS.has(clean)) continue
    if (seen.has(clean)) continue
    seen.add(clean)
    out.push(clean)
  }
  return out
}

/** Pick the persona skill that best addresses a requirement; null if none. */
function skillForRequirement(requirement: string, skills: string[]): string | null {
  const requirementLower = requirement.toLowerCase()
  const requirementTokens = new Set(tokensOf(requirement))
  let best: string | null = null
  let bestScore = 0
  for (const skill of skills) {
    const skillLower = skill.toLowerCase()
    let score = 0
    if (requirementLower.includes(skillLower)) {
      score += 6 // the requirement names the skill verbatim
    }
    const skillTokens = tokensOf(skill)
    for (const skillToken of skillTokens) {
      if (requirementLower.includes(skillToken)) score += 3 // token substring
      if (requirementTokens.has(skillToken)) score += 2 // token equality
    }
    for (const reqToken of requirementTokens) {
      if (skillLower.includes(reqToken)) score += 1 // reverse substring
    }
    if (score > bestScore) {
      bestScore = score
      best = skill
    }
  }
  return bestScore > 0 ? best : null
}

function sentenceOf(text: string): string {
  const trimmed = text.trim().replace(/\s+/g, " ")
  return trimmed ? trimmed.charAt(0).toUpperCase() + trimmed.slice(1) : trimmed
}

/** List one work-history highlight per role in reverse-chronological order. */
function bodyFromWorkHistory(persona: Persona): string {
  const lines: string[] = []
  for (const entry of [...persona.work_history].reverse()) {
    const intro = entry.highlights.length > 0
      ? `As a ${entry.role} at ${entry.company} (${entry.years}), `
      : `At ${entry.company} (${entry.years}) as a ${entry.role}, `
    const body = entry.highlights
      .map((highlight) => sentenceOf(highlight))
      .join(" ")
    lines.push(`${intro}${body}.`)
  }
  return lines.join(" ")
}

/** A skill matched against a requirement — or the closest available skill. */
function paragraphForRequirement(
  requirement: string,
  persona: Persona,
  isLast: boolean,
): string {
  const skill = skillForRequirement(requirement, persona.skills)
  const requirementSentence = sentenceOf(requirement).replace(/\.$/, "")
  const mapSentence = skill
    ? `That maps directly to my experience with ${skill}.`
    : `My closest match there is ${persona.skills[0] ?? "my strongest skill"}.`
  const anchor = workAnchor(persona)
  const paragraph =
    `One requirement for the role is "${requirementSentence}". ` +
    `${mapSentence} ${anchor}`
  return paragraph + (isLast ? "" : " ")
}

/** A concrete "I applied this in production" sentence from the persona's own
 * work history, so the deterministic letter never names a company the persona
 * did not actually work at. */
function workAnchor(persona: Persona): string {
  const [first, second] = persona.work_history
  if (first) {
    const at = `at ${first.company}`
    const role = first.role ? ` as a ${first.role}` : ""
    const highlight = first.highlights[0]
      ? ` — ${sentenceOf(first.highlights[0]).replace(/\.$/, "")}`
      : ""
    const tail =
      second && second.highlights[0]
        ? ` Earlier, ${sentenceOf(second.highlights[0]).toLowerCase()} at ${second.company}.`
        : "."
    return `I have applied it hands-on in production${role} ${at}${highlight}${tail}`
  }
  return `I have applied these skills hands-on in production throughout my career.`
}

/**
 * Render the deterministic, template-based draft (R6). PURE: no I/O, no
 * randomness — the same inputs always produce the same output.
 */
export function renderDeterministicDraft(
  persona: Persona,
  job: JobPosting,
  company: CompanyContext | null,
): ApplicationDraft {
  const role = job.role
  const employer = job.employer

  const requirementBodies = job.keyRequirements.map((requirement, index) =>
    paragraphForRequirement(requirement, persona, index === job.keyRequirements.length - 1),
  )
  const bodyText =
    requirementBodies.length > 0 ? requirementBodies.join("") : bodyFromWorkHistory(persona)

  const companyLine = company
    ? (company.tagline ?? company.description ?? "")
        .trim()
        .replace(/\.$/, "")
    : ""
  const whyCompany = companyLine
    ? `${companyLine}. That mission is exactly the kind of work I want to do.`
    : `${employer}'s team is exactly the kind of place where my background fits.`

  const whyRole =
    `I am drawn to the ${role} role because it sits where my strongest work has ` +
    `happened: ` +
    `${job.keyRequirements.length > 0 ? sentenceOf(job.keyRequirements[0]) : "building and shipping real ML systems"} ` +
    `combined with my hands-on production experience building and operating ` +
    `data and ML infrastructure.`

  const relevantExperience = (() => {
    const entries = [...persona.work_history].reverse()
    const parts = entries.map((entry, index) => {
      const lead =
        index === 0
          ? "I have shipped and operated production systems end to end"
          : `Earlier`
      const at = `${lead}, at ${entry.company} (${entry.years}) as a ${entry.role},`
      const highlights = entry.highlights.map((h) => sentenceOf(h).replace(/\.$/, "")).join("; ")
      return `${at} I ${highlights.length > 0 ? highlights.charAt(0).toLowerCase() + highlights.slice(1) : "contributed across the stack"}.`
    })
    if (persona.skills.length > 0) {
      parts.push(`Across both roles I have worked with ${persona.skills.join(", ")}.`)
    }
    return parts.join(" ")
  })()

  const coverLetter = [
    `I'm ${persona.name}, ${persona.headline}. I'm excited to apply for the ` +
      `${role} role at ${employer}.`,
    "",
    bodyText,
    "",
    whyCompany,
    "",
    relevantExperience,
    "",
    `I would welcome the chance to discuss how I could contribute to the work ` +
      `${employer} is doing in ${role}.`,
    "",
    `Best regards,`,
    `${persona.name} — ${persona.email}`,
  ].join("\n")

  return {
    coverLetter,
    answers: {
      whyThisRole: whyRole,
      whyThisCompany: whyCompany,
      relevantExperience,
    },
  }
}

/**
 * Orchestrate tailoring: prefer the configured LLM, always fall back to the
 * deterministic render (R7, R8 / KTD4). `fetchFn` is injectable for tests.
 * Never rejects — the deterministic draft is the guaranteed outcome.
 */
export async function tailorApplication(
  config: RunConfig,
  persona: Persona,
  job: JobPosting,
  company: CompanyContext | null,
  logger: RunLogger,
  fetchFn: Parameters<typeof draftWithLlm>[4] = fetch,
): Promise<ApplicationDraft> {
  const deterministic = renderDeterministicDraft(persona, job, company)
  if (!config.llm.enabled) {
    logger.info(STAGE, "LLM not configured; using the deterministic draft")
    return deterministic
  }
  try {
    return await draftWithLlm(config.llm, persona, job, company, fetchFn)
  } catch (cause) {
    const detail =
      cause instanceof LlmDraftError || cause instanceof Error
        ? cause.message
        : String(cause)
    logger.warn(
      STAGE,
      `LLM tailoring failed (${detail}); falling back to the deterministic draft`,
    )
    return deterministic
  }
}
