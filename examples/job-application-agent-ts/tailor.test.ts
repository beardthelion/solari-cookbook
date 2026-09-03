/**
 * Offline tests for the tailoring unit (U3).
 *
 * Covers the pure deterministic renderer (R6), the provider dispatch and
 * fallback behavior of the orchestrator (R7, R8 / KTD4), and the Anthropic /
 * OpenAI-compatible request builders. Every provider path is exercised against
 * a stubbed `fetch` — no network, no API key, no writes outside the OS temp
 * directory.
 *
 * Review finding encoded here: the fallback must trigger on HTTP 200 responses
 * whose body is empty or malformed, not only on transport errors and non-2xx
 * statuses (R8 "never fails the run on its own").
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { TestContext } from "node:test"

import { renderDeterministicDraft, tailorApplication } from "./tailor.ts"
import {
  buildAnthropicRequest,
  buildOpenAIRequest,
  DEFAULT_ANTHROPIC_MODEL,
  DEFAULT_OPENAI_MODEL,
} from "./llm.ts"
import { RunLogger } from "./runlog.ts"
import type {
  ApplicationDraft,
  CompanyContext,
  JobPosting,
  LlmConfig,
  Persona,
  RunConfig,
} from "./types.ts"

const POSTING_URL = "https://pinetree-research.com/careers"

const PERSONA: Persona = {
  name: "Avery Chen",
  email: "avery.chen@example.com",
  headline: "Software engineer with a focus on ML systems and data pipelines",
  location: "San Francisco, CA (remote-friendly)",
  work_history: [
    {
      role: "Software Engineer",
      company: "Northwind Data",
      years: "2021-present",
      highlights: [
        "Built and operated the feature-store service powering real-time model inference",
        "Cut training-data pipeline cost roughly 40% with incremental materialization",
      ],
    },
    {
      role: "Backend Engineer",
      company: "Brightpath Labs",
      years: "2018-2021",
      highlights: [
        "Shipped a gRPC recommendation service serving 2M requests/day",
        "Designed the A/B evaluation harness the ML team uses for model rollouts",
      ],
    },
  ],
  skills: [
    "TypeScript",
    "Python",
    "Node.js",
    "PostgreSQL",
    "Kubernetes",
    "ML pipelines",
    "Feature engineering",
    "Playwright",
    "REST & gRPC APIs",
    "Observability",
  ],
  resumeFile: "/unused/resume.txt", // never read by the tailor
}

const JOB: JobPosting = {
  employer: "Pinetree Research",
  role: "Machine Learning Researcher",
  location: "Remote / USA",
  keyRequirements: [
    "You have 4+ years building production ML systems",
    "Experience deploying LLM-based agents to real users",
    "You have strong fundamentals in PyTorch or JAX",
  ],
  sourceUrl: POSTING_URL,
}

const COMPANY_WITH_TAGLINE: CompanyContext = {
  name: "Pinetree Research",
  tagline: "We build production-grade systems for autonomous AI agents",
  url: "https://pinetree-research.com",
}

/** The three answer keys the ATS form (U4) fills from the draft. */
const ANSWER_KEYS = ["whyThisRole", "whyThisCompany", "relevantExperience"]

function anthropicLlm(): LlmConfig {
  return {
    enabled: true,
    provider: "anthropic",
    anthropic: { apiKey: "sk-ant-test-key", model: null },
    openai: { apiKey: null, baseUrl: null, model: null },
  }
}

function openaiLlm(baseUrl = "https://api.example.com/v1"): LlmConfig {
  return {
    enabled: true,
    provider: "openai",
    anthropic: { apiKey: null, model: null },
    openai: { apiKey: "sk-openai-test-key", baseUrl, model: null },
  }
}

function makeRunConfig(llm: LlmConfig): RunConfig {
  return {
    solariApiKey: "slr_test_key",
    solariBaseUrl: "https://api.getsolari.com",
    jobUrl: POSTING_URL,
    personaPath: "/unused/persona.json",
    persona: PERSONA,
    llm,
  }
}

/** Fresh scratch dir under the OS temp dir; removed when the test ends. */
async function withTemp(t: TestContext): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "jaa-tailor-"))
  t.after(async () => {
    await rm(dir, { recursive: true, force: true })
  })
  return dir
}

/** A RunLogger whose records are captured in memory (file lands in temp). */
async function captureLogger(t: TestContext): Promise<{ lines: string[]; logger: RunLogger }> {
  const dir = await withTemp(t)
  const lines: string[] = []
  const logger = new RunLogger({
    logFilePath: join(dir, "run.log"),
    sink: (line) => lines.push(line),
  })
  return { lines, logger }
}

function warnMessages(lines: string[]): string[] {
  return lines
    .map((line) => JSON.parse(line) as { level: string; message: string })
    .filter((record) => record.level === "warn")
    .map((record) => record.message)
}

test("the deterministic cover letter names the persona, role, and employer, and is stable", () => {
  const draft = renderDeterministicDraft(PERSONA, JOB, null)

  assert.ok(draft.coverLetter.includes(PERSONA.name), "letter names the persona")
  assert.ok(draft.coverLetter.includes(JOB.role), "letter names the job role")
  assert.ok(draft.coverLetter.includes(JOB.employer), "letter names the employer")
  assert.deepEqual(
    draft,
    renderDeterministicDraft(PERSONA, JOB, null),
    "rendering is a pure function of its inputs",
  )
})

test("the deterministic draft carries the answer keys the form will fill", () => {
  const draft = renderDeterministicDraft(PERSONA, JOB, COMPANY_WITH_TAGLINE)
  for (const key of ANSWER_KEYS) {
    assert.equal(typeof draft.answers[key], "string", `answer ${key} is present`)
    assert.ok((draft.answers[key] ?? "").length > 0, `answer ${key} is non-empty`)
  }
})

test("whyThisCompany references the company tagline when present and stays generic when absent", () => {
  const withCompany = renderDeterministicDraft(PERSONA, JOB, COMPANY_WITH_TAGLINE)
  const withoutCompany = renderDeterministicDraft(PERSONA, JOB, null)

  assert.ok(
    withCompany.answers.whyThisCompany.includes("autonomous AI agents"),
    "answer cites the company tagline when company context has one",
  )
  assert.ok(
    !withoutCompany.answers.whyThisCompany.includes("autonomous AI agents"),
    "answer stays generic (no tagline leak) when company context is absent",
  )
  assert.notEqual(
    withCompany.answers.whyThisCompany,
    withoutCompany.answers.whyThisCompany,
    "the two answers are not identical",
  )
})

test("a rejecting provider logs a warning and returns the deterministic draft (AE3 / R8)", async (t) => {
  const { lines, logger } = await captureLogger(t)
  const fetchFn = async () => {
    throw new Error("network down")
  }

  const draft = await tailorApplication(
    makeRunConfig(openaiLlm()),
    PERSONA,
    JOB,
    COMPANY_WITH_TAGLINE,
    logger,
    fetchFn,
  )

  assert.deepEqual(
    draft,
    renderDeterministicDraft(PERSONA, JOB, COMPANY_WITH_TAGLINE),
    "a transport failure degrades to the deterministic draft",
  )
  const warns = warnMessages(lines)
  assert.equal(warns.length, 1, "exactly one warning is logged")
  assert.match(warns[0], /falling back to the deterministic draft/)
})

test("a healthy provider's draft is returned unchanged (AE3 / R7)", async (t) => {
  const { lines, logger } = await captureLogger(t)
  const providerDraft: ApplicationDraft = {
    coverLetter:
      "I am applying because Pinetree's autonomous-agent platform is exactly where my ML systems work belongs.",
    answers: {
      whyThisRole: "Provider-authored reasons for the Machine Learning Researcher role.",
      whyThisCompany: "Provider-authored reasons about autonomous agents at Pinetree Research.",
      relevantExperience: "Provider-authored evidence from the feature-store work.",
    },
  }

  const fetchFn = async (url: string | URL | Request, init?: RequestInit) => {
    assert.match(String(url), /\/v1\/chat\/completions$/, "openai dispatch hits chat/completions")
    const sent = JSON.parse(String(init?.body)) as {
      model: string
      messages: Array<{ role: string; content: string }>
    }
    assert.equal(sent.model, DEFAULT_OPENAI_MODEL, "default openai model is requested")
    assert.equal(sent.messages[0].role, "user")
    assert.ok(sent.messages[0].content.includes(JOB.employer), "prompt carries the job context")
    const envelope = {
      choices: [{ message: { content: JSON.stringify(providerDraft) } }],
    }
    return new Response(JSON.stringify(envelope), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  }

  const draft = await tailorApplication(
    makeRunConfig(openaiLlm()),
    PERSONA,
    JOB,
    COMPANY_WITH_TAGLINE,
    logger,
    fetchFn,
  )

  assert.deepEqual(draft, providerDraft, "the provider draft passes through unchanged")
  assert.deepEqual(warnMessages(lines), [], "a healthy provider logs no warning")
})

test("an Anthropic text block parses into the provider draft unchanged", async (t) => {
  const { logger } = await captureLogger(t)
  const providerDraft: ApplicationDraft = {
    coverLetter: "Anthropic-authored letter about Pinetree Research.",
    answers: {
      whyThisRole: "anthropic why role",
      whyThisCompany: "anthropic why company",
      relevantExperience: "anthropic experience",
    },
  }
  const fetchFn = async (url: string | URL | Request) => {
    assert.match(String(url), /anthropic\.com\/v1\/messages$/, "anthropic dispatch hits Messages API")
    const envelope = {
      content: [{ type: "text", text: JSON.stringify(providerDraft) }],
    }
    return new Response(JSON.stringify(envelope), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  }

  const draft = await tailorApplication(
    makeRunConfig(anthropicLlm()),
    PERSONA,
    JOB,
    COMPANY_WITH_TAGLINE,
    logger,
    fetchFn,
  )
  assert.deepEqual(draft, providerDraft)
})

test("a 200 with an empty or malformed body (and non-2xx) triggers the fallback with a warning", async (t) => {
  const cases: Array<{ label: string; llm: LlmConfig; respond: () => Response }> = [
    { label: "openai 200 with an empty body", llm: openaiLlm(), respond: () => new Response("", { status: 200 }) },
    {
      label: "openai 200 with a malformed body",
      llm: openaiLlm(),
      respond: () => new Response("<html>gateway error</html>", { status: 200 }),
    },
    { label: "anthropic 200 with an empty body", llm: anthropicLlm(), respond: () => new Response("", { status: 200 }) },
    {
      label: "openai HTTP 500 with an error body",
      llm: openaiLlm(),
      respond: () => new Response("upstream blew up", { status: 500 }),
    },
  ]

  for (const c of cases) {
    await t.test(c.label, async (tc) => {
      const { lines, logger } = await captureLogger(tc)
      const draft = await tailorApplication(
        makeRunConfig(c.llm),
        PERSONA,
        JOB,
        COMPANY_WITH_TAGLINE,
        logger,
        async () => c.respond(),
      )
      assert.deepEqual(
        draft,
        renderDeterministicDraft(PERSONA, JOB, COMPANY_WITH_TAGLINE),
        "an unusable provider response degrades to the deterministic draft",
      )
      const warns = warnMessages(lines)
      assert.equal(warns.length, 1, "exactly one warning is logged")
      assert.match(warns[0], /falling back to the deterministic draft/)
    })
  }
})

test("buildAnthropicRequest targets the Messages API with key, version, model, and prompt", () => {
  const req = buildAnthropicRequest(anthropicLlm(), "custom anthropic prompt")

  assert.equal(req.url, "https://api.anthropic.com/v1/messages")
  assert.equal(req.headers["x-api-key"], "sk-ant-test-key")
  assert.equal(req.headers["anthropic-version"], "2023-06-01")
  assert.equal(req.headers["content-type"], "application/json")

  const body = JSON.parse(req.body) as {
    model: string
    max_tokens: number
    system: string
    messages: Array<{ role: string; content: string }>
  }
  assert.equal(body.model, DEFAULT_ANTHROPIC_MODEL, "default model applies when config leaves it unset")
  assert.ok(Number.isInteger(body.max_tokens) && body.max_tokens > 0)
  assert.equal(typeof body.system, "string")
  assert.deepEqual(body.messages, [{ role: "user", content: "custom anthropic prompt" }])
})

test("buildOpenAIRequest targets /chat/completions with Bearer auth and the configured base URL", () => {
  const req = buildOpenAIRequest(openaiLlm("https://api.example.com/v1/"), "custom openai prompt")

  assert.equal(
    req.url,
    "https://api.example.com/v1/chat/completions",
    "a trailing slash on the base URL is normalized",
  )
  assert.equal(req.headers.authorization, "Bearer sk-openai-test-key")
  assert.equal(req.headers["content-type"], "application/json")

  const body = JSON.parse(req.body) as {
    model: string
    messages: Array<{ role: string; content: string }>
  }
  assert.equal(body.model, DEFAULT_OPENAI_MODEL, "default model applies when config leaves it unset")
  assert.deepEqual(body.messages, [{ role: "user", content: "custom openai prompt" }])
})
