/**
 * Offline foundation tests for the job-application-agent example (U1).
 *
 * Covers the configuration loader (defaults, required key, .env parsing and
 * precedence, persona loading, resume path resolution) and the structured
 * run logger. No network, no Solari API key, and no writes outside the OS
 * temp directory (each temp dir is removed when its test finishes).
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import type { TestContext } from "node:test"

import { loadConfig, parseDotEnv } from "./config.ts"
import { RunLogger } from "./runlog.ts"

const EXAMPLE_DIR = dirname(fileURLToPath(import.meta.url))
const SAMPLE_PERSONA = join(EXAMPLE_DIR, "persona.sample.json")

/** Fresh scratch dir under the OS temp dir, removed when the test ends. */
async function withTemp(t: TestContext): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "jaa-foundation-"))
  t.after(async () => {
    await rm(dir, { recursive: true, force: true })
  })
  return dir
}

const VALID_PERSONA = {
  name: "Test Applicant",
  email: "applicant@example.com",
  headline: "A test persona",
  location: "Testville",
  work_history: [
    {
      role: "Engineer",
      company: "Acme",
      years: "2020-present",
      highlights: ["Built things"],
    },
  ],
  skills: ["TypeScript"],
}

test("config with only SOLARI_API_KEY applies defaults and disables LLM mode", () => {
  const cfg = loadConfig({ env: { SOLARI_API_KEY: "slr_test_key" } })

  assert.equal(cfg.solariBaseUrl, "https://api.getsolari.com")
  assert.equal(cfg.jobUrl, "https://pinetree-research.com/careers")
  // Default persona path resolves against the example dir and loads the sample.
  assert.equal(cfg.personaPath, SAMPLE_PERSONA)
  assert.equal(cfg.persona.name, "Avery Chen")
  assert.equal(
    cfg.persona.resumeFile,
    join(EXAMPLE_DIR, "resume-sample.txt"),
    "sample resumeFile should resolve to an absolute path next to the persona",
  )
  assert.equal(cfg.llm.enabled, false)
  assert.equal(cfg.llm.provider, null)
  assert.equal(cfg.llm.anthropic.apiKey, null)
  assert.equal(cfg.llm.openai.apiKey, null)
})

test("config with no SOLARI_API_KEY throws an error naming the variable", () => {
  assert.throws(
    () => loadConfig({ env: { JOB_URL: "https://example.com/jobs" } }),
    /SOLARI_API_KEY/,
    "error should name the missing variable",
  )
})

test("PERSONA_PATH loads a custom persona; a missing file errors with its path", async (t) => {
  const dir = await withTemp(t)
  const resumePath = join(dir, "custom-resume.txt")
  await writeFile(resumePath, "custom resume body\n")
  const personaPath = join(dir, "custom-persona.json")
  await writeFile(
    personaPath,
    JSON.stringify({ ...VALID_PERSONA, resumeFile: resumePath }, null, 2),
  )

  const cfg = loadConfig({
    env: { SOLARI_API_KEY: "slr_test_key", PERSONA_PATH: personaPath },
    cwd: dir,
  })
  assert.equal(cfg.personaPath, personaPath)
  assert.equal(cfg.persona.name, "Test Applicant")
  assert.equal(cfg.persona.resumeFile, resumePath)

  const missing = join(dir, "does-not-exist.json")
  assert.throws(
    () =>
      loadConfig({
        env: { SOLARI_API_KEY: "slr_test_key", PERSONA_PATH: missing },
        cwd: dir,
      }),
    /does-not-exist\.json/,
    "error should contain the missing persona path",
  )
})

test("persona resumeFile resolves relative to the persona file; a missing resume errors", async (t) => {
  const dir = await withTemp(t)
  const sub = join(dir, "personas")
  await mkdir(sub)
  await writeFile(join(sub, "resume.txt"), "resume body\n")

  await writeFile(
    join(sub, "good.json"),
    JSON.stringify({ ...VALID_PERSONA, resumeFile: "./resume.txt" }, null, 2),
  )
  const cfg = loadConfig({
    env: { SOLARI_API_KEY: "slr_test_key", PERSONA_PATH: join(sub, "good.json") },
    cwd: dir,
  })
  assert.equal(
    cfg.persona.resumeFile,
    join(sub, "resume.txt"),
    "relative resumeFile resolves against the persona file's directory",
  )

  await writeFile(
    join(sub, "bad.json"),
    JSON.stringify({ ...VALID_PERSONA, resumeFile: "./gone.txt" }, null, 2),
  )
  assert.throws(
    () =>
      loadConfig({
        env: { SOLARI_API_KEY: "slr_test_key", PERSONA_PATH: join(sub, "bad.json") },
        cwd: dir,
      }),
    /gone\.txt/,
    "a missing resume file should error during config load with the path",
  )
})

test("a local .env is parsed and honored, with process.env taking precedence", async (t) => {
  const dir = await withTemp(t)
  await writeFile(
    join(dir, ".env"),
    [
      "# comment line is ignored",
      "",
      "SOLARI_API_KEY=dotenv-key",
      'SOLARI_BASE_URL="https://dotenv.example"',
      "JOB_URL=dotenv-job-url",
      "OPENAI_MODEL='gpt-4o-mini'",
      "",
    ].join("\n"),
  )

  // Stand-in for the real process.env: values here must win over .env values.
  const env = {
    SOLARI_API_KEY: "env-key",
    JOB_URL: "env-job-url",
    PERSONA_PATH: SAMPLE_PERSONA,
  }
  const cfg = loadConfig({ env, cwd: dir })

  assert.equal(cfg.solariApiKey, "env-key", "process.env wins over .env")
  assert.equal(cfg.jobUrl, "env-job-url", "process.env wins over .env")
  assert.equal(
    cfg.solariBaseUrl,
    "https://dotenv.example",
    ".env value is honored when process.env leaves it unset (quotes stripped)",
  )
  assert.equal(
    cfg.llm.openai.model,
    "gpt-4o-mini",
    ".env single-quoted value is honored",
  )
  assert.equal(cfg.personaPath, SAMPLE_PERSONA)

  // Parser-level check of comments, blanks, and quote trimming.
  assert.deepEqual(
    parseDotEnv("# c\n\nA=1\nB=\"two\"\nC='three'\n"),
    { A: "1", B: "two", C: "three" },
  )
})

test("RunLogger writes identical JSON-line records to its sink and the run log", async (t) => {
  const dir = await withTemp(t)
  const logPath = join(dir, "run-output", "run.log")

  const seen: string[] = []
  const logger = new RunLogger({ logFilePath: logPath, sink: (line) => seen.push(line) })

  logger.info("config", "configuration loaded")
  logger.warn("tailor", "LLM call failed; falling back to deterministic draft")
  logger.error("submit", "submission was not confirmed")

  assert.equal(seen.length, 3)
  for (const line of seen) {
    const record = JSON.parse(line) as Record<string, string>
    assert.equal(typeof record.timestamp, "string")
    assert.ok(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(record.timestamp),
      `timestamp should be ISO 8601: ${record.timestamp}`,
    )
  }
  assert.equal((JSON.parse(seen[0]) as { stage: string }).stage, "config")
  assert.equal((JSON.parse(seen[1]) as { level: string }).level, "warn")
  assert.equal((JSON.parse(seen[2]) as { level: string }).level, "error")

  const fileText = await readFile(logPath, "utf8")
  const fileLines = fileText.trimEnd().split("\n")
  assert.deepEqual(fileLines, seen, "run log should contain the same records")
})
