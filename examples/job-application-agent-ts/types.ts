/**
 * Shared data shapes for the job-application-agent example.
 *
 * These types are imported by the config loader, the run logger, and the
 * later pipeline units (posting, tailoring, submission). Keep them free of
 * Node and Solari imports so they stay pure data contracts.
 */

/** One employer entry in the persona's work history. */
export interface WorkHistoryEntry {
  role: string
  company: string
  /** Human-readable span, e.g. "2021-present". */
  years: string
  /** Plain-text achievement bullets. */
  highlights: string[]
}

/**
 * The run persona: who the agent is applying as.
 *
 * Mirrors `persona.sample.json`. When config.ts loads a persona, `resumeFile`
 * is resolved to an absolute path relative to the persona file's directory.
 */
export interface Persona {
  name: string
  email: string
  headline: string
  location: string
  work_history: WorkHistoryEntry[]
  skills: string[]
  /** Path to the resume file to upload (absolute once loaded). */
  resumeFile: string
}

/** A normalized job posting read from the live careers page. */
export interface JobPosting {
  employer: string
  role: string
  location: string
  keyRequirements: string[]
  applicationNotes?: string
  sourceUrl: string
}

/** Employer research gathered by the read stage. */
export interface CompanyContext {
  name: string
  tagline?: string
  description?: string
  url: string
}

/** The tailored application copy produced by the tailor stage. */
export interface ApplicationDraft {
  coverLetter: string
  answers: Record<string, string>
}

/** One structured step record written by the RunLogger (console + run log). */
export interface StepRecord {
  /** ISO 8601 UTC timestamp, e.g. 2026-09-02T22:11:00.000Z. */
  timestamp: string
  stage: string
  level: "info" | "warn" | "error"
  message: string
}

export type LlmProvider = "anthropic" | "openai"

/** LLM tailoring configuration; active only when credentials are present. */
export interface LlmConfig {
  enabled: boolean
  provider: LlmProvider | null
  anthropic: { apiKey: string | null; model: string | null }
  openai: { apiKey: string | null; baseUrl: string | null; model: string | null }
}

/** Fully resolved runtime configuration produced by config.ts. */
export interface RunConfig {
  solariApiKey: string
  solariBaseUrl: string
  jobUrl: string
  /** Absolute path to the persona file that was loaded. */
  personaPath: string
  /** Loaded and validated persona; resumeFile is an absolute path. */
  persona: Persona
  llm: LlmConfig
}
