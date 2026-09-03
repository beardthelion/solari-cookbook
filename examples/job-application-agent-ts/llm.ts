/**
 * Minimal, dependency-free LLM tailoring client (U3 / R7-R8, KTD4).
 *
 * Implements two fetch-based providers behind one tiny seam, selected from
 * config.llm.provider:
 *   - Anthropic Messages API (POST {base}/v1/messages)
 *   - any OpenAI-compatible /chat/completions endpoint
 * There are no SDK or client-library dependencies — only the global `fetch`,
 * injectable so tests can stub it.
 *
 * Every failure mode — network error, non-2xx status, an empty body, a body
 * that is malformed or unparseable JSON, or a draft missing required fields —
 * surfaces as a typed `LlmDraftError` so the orchestrator (`tailorApplication`)
 * can log a warning and fall back to the deterministic draft (R8: an LLM
 * failure never fails the run on its own).
 */
import type {
  ApplicationDraft,
  CompanyContext,
  JobPosting,
  LlmConfig,
  Persona,
} from "./types.ts"

export const DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-4-5"
export const DEFAULT_OPENAI_MODEL = "gpt-4o-mini"

const ANTHROPIC_BASE_URL = "https://api.anthropic.com"
const ANTHROPIC_VERSION = "2023-06-01"
const ANTHROPIC_SYSTEM =
  "You are an expert job-application writer. You write specific, honest, " +
  "well-structured application copy, and you reply with a single JSON object only."
const MAX_TOKENS = 2048
const REQUEST_TIMEOUT_MS = 30_000

/** Typed error for every LLM failure mode; drives the tailor fallback. */
export class LlmDraftError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = "LlmDraftError"
  }
}

/** The injectable fetch surface the providers call. */
export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>

/** A fully built HTTP request, pure and testable without a network. */
export interface ProviderHttpRequest {
  url: string
  headers: Record<string, string>
  body: string
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

/** AbortSignal.timeout is Node 17.3+; guard for older runtimes. */
function timeoutSignal(): AbortSignal | undefined {
  if (typeof AbortSignal === "undefined" || typeof AbortSignal.timeout !== "function") {
    return undefined
  }
  return AbortSignal.timeout(REQUEST_TIMEOUT_MS)
}

/** The single prompt shared by both providers. */
export function buildTailorPrompt(
  persona: Persona,
  job: JobPosting,
  company: CompanyContext | null,
): string {
  const out: string[] = [
    "Write a tailored job application for the persona below applying to the job below.",
    "",
    `Role: ${job.role}`,
    `Employer: ${job.employer}`,
    `Location: ${job.location}`,
    "Key requirements:",
    ...job.keyRequirements.map((requirement) => `- ${requirement}`),
    "",
  ]
  if (company) {
    out.push(`Company: ${company.name || job.employer}`)
    if (company.tagline) out.push(`Company tagline: ${company.tagline}`)
    if (company.description) out.push(`Company description: ${company.description}`)
    out.push("")
  }
  out.push(
    "Persona:",
    `Name: ${persona.name}`,
    `Headline: ${persona.headline}`,
    `Location: ${persona.location}`,
    `Skills: ${persona.skills.join(", ")}`,
  )
  if (persona.work_history.length > 0) {
    out.push("Work history:")
    for (const entry of persona.work_history) {
      out.push(`- ${entry.role} at ${entry.company} (${entry.years})`)
      for (const highlight of entry.highlights) out.push(`  * ${highlight}`)
    }
  }
  out.push(
    "",
    "Respond with ONLY one JSON object — no markdown fences, no commentary — " +
      'shaped exactly like: {"coverLetter": string, "answers": ' +
      '{"whyThisRole": string, "whyThisCompany": string, "relevantExperience": string}}.',
    "The cover letter should reference the role, the employer, and the persona's " +
      "relevant experience and skills. Each answer is plain prose (no markdown) " +
      "suitable for a form text field.",
  )
  return out.join("\n")
}

/** Build the Anthropic Messages API request (pure, testable). */
export function buildAnthropicRequest(config: LlmConfig, prompt: string): ProviderHttpRequest {
  const apiKey = config.anthropic.apiKey
  if (!apiKey) throw new LlmDraftError("anthropic provider requires an API key")
  const body = {
    model: config.anthropic.model ?? DEFAULT_ANTHROPIC_MODEL,
    max_tokens: MAX_TOKENS,
    system: ANTHROPIC_SYSTEM,
    messages: [{ role: "user", content: prompt }],
  }
  return {
    url: `${ANTHROPIC_BASE_URL}/v1/messages`,
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": ANTHROPIC_VERSION,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  }
}

/** Build the OpenAI-compatible /chat/completions request (pure, testable). */
export function buildOpenAIRequest(config: LlmConfig, prompt: string): ProviderHttpRequest {
  const apiKey = config.openai.apiKey
  const baseUrl = config.openai.baseUrl
  if (!apiKey) throw new LlmDraftError("openai provider requires an API key")
  if (!baseUrl) throw new LlmDraftError("openai provider requires a base URL")
  const body = {
    model: config.openai.model ?? DEFAULT_OPENAI_MODEL,
    messages: [{ role: "user", content: prompt }],
  }
  return {
    // Normalize a trailing slash so base "https://…/v1/" yields one path join.
    url: `${baseUrl.replace(/\/+$/, "")}/chat/completions`,
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  }
}

/** Anthropic Messages envelope -> its concatenated text content. */
function anthropicText(envelope: unknown): string {
  const content = (envelope as { content?: unknown })?.content
  if (!Array.isArray(content)) {
    throw new LlmDraftError("Anthropic response has no content array")
  }
  const text = content
    .map((block) => {
      const b = block as { type?: string; text?: unknown }
      return b?.type === "text" && typeof b.text === "string" ? b.text : ""
    })
    .join("")
    .trim()
  if (!text) throw new LlmDraftError("Anthropic response contained no text content")
  return text
}

/** OpenAI chat-completions envelope -> the first choice's message content. */
function openaiText(envelope: unknown): string {
  const choices = (envelope as { choices?: unknown })?.choices
  if (!Array.isArray(choices) || choices.length === 0) {
    throw new LlmDraftError("OpenAI response has no choices")
  }
  const content = (choices[0] as { message?: { content?: unknown } })?.message?.content
  if (typeof content !== "string" || content.trim() === "") {
    throw new LlmDraftError("OpenAI response contained no message content")
  }
  return content
}

/** Strip a markdown code fence in case a provider wrapped its JSON. */
function stripFences(text: string): string {
  const trimmed = text.trim()
  if (!trimmed.startsWith("```")) return trimmed
  return trimmed.replace(/^```[a-zA-Z]*\s*\n?/, "").replace(/```\s*$/, "").trim()
}

/** Parse a provider's content string into a validated ApplicationDraft. */
function parseDraftJson(text: string): ApplicationDraft {
  let parsed: unknown
  try {
    parsed = JSON.parse(stripFences(text))
  } catch (cause) {
    throw new LlmDraftError("LLM response is not valid JSON", { cause })
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new LlmDraftError("LLM response JSON is not an object")
  }
  const value = parsed as Record<string, unknown>
  if (typeof value.coverLetter !== "string" || value.coverLetter.trim() === "") {
    throw new LlmDraftError("LLM JSON is missing a coverLetter string")
  }
  if (typeof value.answers !== "object" || value.answers === null) {
    throw new LlmDraftError("LLM JSON is missing an answers object")
  }
  const answers: Record<string, string> = {}
  for (const [key, answer] of Object.entries(value.answers as Record<string, unknown>)) {
    if (typeof answer !== "string") {
      throw new LlmDraftError(`LLM answer "${key}" is not a string`)
    }
    answers[key] = answer
  }
  return { coverLetter: value.coverLetter, answers }
}

/** POST one built request, then turn the provider envelope into a draft. */
async function postAndReadText(
  request: ProviderHttpRequest,
  fetchFn: FetchLike,
  readText: (envelope: unknown) => string,
): Promise<ApplicationDraft> {
  let response: Response
  try {
    const signal = timeoutSignal()
    response = await fetchFn(request.url, {
      method: "POST",
      headers: request.headers,
      body: request.body,
      ...(signal ? { signal } : {}),
    })
  } catch (cause) {
    throw new LlmDraftError(
      `LLM request to ${request.url} failed: ${errorMessage(cause)}`,
      { cause },
    )
  }
  if (!response.ok) {
    throw new LlmDraftError(
      `LLM provider returned HTTP ${response.status} ${response.statusText}`.trim(),
    )
  }
  let bodyText: string
  try {
    bodyText = await response.text()
  } catch (cause) {
    throw new LlmDraftError("could not read the LLM response body", { cause })
  }
  if (bodyText.trim() === "") {
    throw new LlmDraftError("LLM provider returned an empty response body")
  }
  let envelope: unknown
  try {
    envelope = JSON.parse(bodyText)
  } catch (cause) {
    throw new LlmDraftError("LLM response body is not valid JSON", { cause })
  }
  return parseDraftJson(readText(envelope))
}

/**
 * Draft the application through the configured provider. Dispatches on
 * config.llm.provider; throws `LlmDraftError` on any failure so the caller
 * can fall back. Only reached when config.llm.enabled is true.
 */
export async function draftWithLlm(
  config: LlmConfig,
  persona: Persona,
  job: JobPosting,
  company: CompanyContext | null,
  fetchFn: FetchLike = fetch,
): Promise<ApplicationDraft> {
  const provider = config.provider
  if (!config.enabled || provider === null) {
    throw new LlmDraftError("LLM tailoring is not configured")
  }
  const prompt = buildTailorPrompt(persona, job, company)
  if (provider === "anthropic") {
    return postAndReadText(buildAnthropicRequest(config, prompt), fetchFn, anthropicText)
  }
  if (provider === "openai") {
    return postAndReadText(buildOpenAIRequest(config, prompt), fetchFn, openaiText)
  }
  throw new LlmDraftError(`unknown LLM provider: ${String(provider)}`)
}
