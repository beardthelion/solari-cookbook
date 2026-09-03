/**
 * Configuration loader for the job-application-agent example.
 *
 * Loads, in order of precedence (highest first):
 *   1. values already present in `process.env` (or an injected env override),
 *   2. a local `.env` file at the example directory root,
 *   3. built-in defaults.
 *
 * The `.env` parsing is intentionally small and dependency-free: `KEY=value`
 * lines with `#` comments and blank lines ignored, and surrounding single or
 * double quotes trimmed. No dotenv dependency.
 *
 * The loader is synchronous so a missing key or persona fails fast at startup
 * with an Error that names the offending variable or path.
 */
import { accessSync, readFileSync } from "node:fs"
import { dirname, isAbsolute, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import type { LlmConfig, Persona, RunConfig } from "./types.ts"

const DEFAULT_SOLARI_BASE_URL = "https://api.getsolari.com"
const DEFAULT_JOB_URL = "https://pinetree-research.com/careers"
const DEFAULT_PERSONA_PATH = "./persona.sample.json"
/** The example directory itself; .env and the default persona live here. */
const EXAMPLE_DIR = dirname(fileURLToPath(import.meta.url))

/** A mutable env map (injected for tests, otherwise process.env). */
type EnvMap = Record<string, string | undefined>

export interface LoadConfigOptions {
  /** Env map override. Defaults to process.env. */
  env?: EnvMap
  /**
   * Working directory used to resolve relative PERSONA_PATH values.
   * Defaults to the example directory. Pass a value for tests only; the
   * shipped default persona lives next to this module.
   */
  cwd?: string
}

/** Parse dotenv-style text into a key/value map. Never throws on bad lines. */
export function parseDotEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line === "" || line.startsWith("#")) continue
    const eq = line.indexOf("=")
    if (eq <= 0) continue
    const key = line.slice(0, eq).trim()
    if (key === "") continue
    let value = line.slice(eq + 1).trim()
    // Trim a matching pair of surrounding quotes; otherwise drop a trailing
    // inline comment (preceded by whitespace).
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1)
    } else {
      const hash = value.search(/\s+#/)
      if (hash !== -1) value = value.slice(0, hash).trimEnd()
    }
    out[key] = value
  }
  return out
}

/** Read and parse the given directory's `.env`, if present. Never throws. */
function readDotEnv(dir: string): Record<string, string> {
  const dotEnvPath = join(dir, ".env")
  try {
    accessSync(dotEnvPath)
  } catch {
    return {}
  }
  try {
    return parseDotEnv(readFileSync(dotEnvPath, "utf8"))
  } catch {
    return {}
  }
}

/** Merge .env under the env map: env (process.env) always wins. */
function pick(
  key: string,
  env: EnvMap,
  dotEnv: Record<string, string>,
  fallback: string | null,
): string | null {
  const fromEnv = env[key]
  if (fromEnv !== undefined && fromEnv !== "") return fromEnv
  if (dotEnv[key] !== undefined) return dotEnv[key]
  return fallback
}

/** Resolve an env key, treating empty strings as unset. */
function cred(env: EnvMap, dotEnv: Record<string, string>, key: string): string | null {
  const value = pick(key, env, dotEnv, null)
  return value && value.trim() !== "" ? value.trim() : null
}

/** Load the persona JSON and validate its resume file. Throws with paths. */
function loadPersona(personaPath: string): Persona {
  let raw: string
  try {
    raw = readFileSync(personaPath, "utf8")
  } catch (cause) {
    throw new Error(`persona file not found or unreadable: ${personaPath}`, { cause })
  }
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>
  } catch (cause) {
    throw new Error(`persona file is not valid JSON: ${personaPath}`, { cause })
  }
  if (typeof parsed.name !== "string" || parsed.resumeFile === undefined) {
    throw new Error(`persona file is missing required fields: ${personaPath}`)
  }
  const persona = parsed as unknown as Persona
  // The resume path is relative to the persona file's directory.
  persona.resumeFile = resolve(dirname(personaPath), persona.resumeFile)
  try {
    accessSync(persona.resumeFile)
  } catch (cause) {
    throw new Error(
      `persona resume file not found: ${persona.resumeFile} (from persona ${personaPath})`,
      { cause },
    )
  }
  return persona
}

function buildLlmConfig(env: EnvMap, dotEnv: Record<string, string>): LlmConfig {
  const anthropicKey = cred(env, dotEnv, "ANTHROPIC_API_KEY")
  const openaiKey = cred(env, dotEnv, "OPENAI_API_KEY")
  const openaiBaseUrl = cred(env, dotEnv, "OPENAI_BASE_URL")
  const openaiEnabled = openaiKey !== null && openaiBaseUrl !== null
  const provider = anthropicKey !== null ? "anthropic" : openaiEnabled ? "openai" : null
  return {
    enabled: provider !== null,
    provider,
    anthropic: {
      apiKey: anthropicKey,
      model: cred(env, dotEnv, "ANTHROPIC_MODEL"),
    },
    openai: {
      apiKey: openaiKey,
      baseUrl: openaiBaseUrl,
      model: cred(env, dotEnv, "OPENAI_MODEL"),
    },
  }
}

/**
 * Load and validate the full run configuration.
 *
 * Throws an Error naming SOLARI_API_KEY when it is missing. Loads the persona
 * from PERSONA_PATH (default `./persona.sample.json` resolved against the
 * example directory, or against `cwd` when one is injected for tests).
 */
export function loadConfig(options: LoadConfigOptions = {}): RunConfig {
  const env = options.env ?? process.env
  const cwd = options.cwd ?? EXAMPLE_DIR
  const dotEnv = readDotEnv(cwd)

  const apiKey = cred(env, dotEnv, "SOLARI_API_KEY")
  if (apiKey === null) {
    throw new Error(
      "SOLARI_API_KEY is required. Set it in the environment or in " +
        `${join(cwd, ".env")} (see .env.example).`,
    )
  }

  const personaRaw = pick("PERSONA_PATH", env, dotEnv, DEFAULT_PERSONA_PATH)!
  const personaPath = isAbsolute(personaRaw) ? personaRaw : resolve(cwd, personaRaw)
  const persona = loadPersona(personaPath)

  return {
    solariApiKey: apiKey,
    solariBaseUrl:
      pick("SOLARI_BASE_URL", env, dotEnv, DEFAULT_SOLARI_BASE_URL) ??
      DEFAULT_SOLARI_BASE_URL,
    jobUrl: pick("JOB_URL", env, dotEnv, DEFAULT_JOB_URL) ?? DEFAULT_JOB_URL,
    personaPath,
    persona,
    llm: buildLlmConfig(env, dotEnv),
  }
}
