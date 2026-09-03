# Job application agent (TypeScript)

An autonomous job-application pipeline that ties Solari's cloud browser and sandbox together: a recorded browser reads a real job posting, researches the employer, tailors an application from a configurable persona, and submits it to a safe application form the pipeline hosts itself inside a sandbox.

This is a *use case*, not a tutorial: it shows one believable end-to-end agent job — read a live page, exercise judgment, fill a real form, and end with an observable submission and a watchable replay — rather than a single API call.

## What it does

1. Boots a sandbox that serves a generic ATS-shaped application form on a public preview URL.
2. Launches a **recorded** cloud browser and reads the target posting. The default target is Pinetree Research's live careers page (Machine Learning Researcher role); point `JOB_URL` at any other posting to reuse the pipeline.
3. Visits the employer's homepage and captures short company context.
4. Tailors a cover letter and form answers. **Deterministic mode** (the default, no LLM key) renders copy from your persona, the job, and the company context. **LLM mode** (optional) sends the same inputs to Anthropic or any OpenAI-compatible endpoint for higher-quality copy; any provider failure falls back to the deterministic draft with a logged warning.
5. Fills the hosted form with the same browser session, uploads the persona's resume, and submits.
6. Prints a submission receipt, downloads the rrweb session replay to `run-output/replay.ndjson`, and logs every stage to `run-output/run.log`.

## Run

Requires Node 20+ and a Solari account.

```bash
cd examples/job-application-agent-ts
npm install
export SOLARI_API_KEY=slr_live_...   # https://console.getsolari.com
npm start
```

The run takes a few minutes and costs well under $0.05 at Starter rates (a short browser session at $0.10/hour plus a small sandbox at ~$0.057/hour).

### Configuration

All settings are environment variables (or a local `.env` file — see `.env.example`):

| Variable | Default | Purpose |
| --- | --- | --- |
| `SOLARI_API_KEY` | — | Required. One key drives both the browser and the sandbox. |
| `SOLARI_BASE_URL` | `https://api.getsolari.com` | Gateway override (staging/self-hosted). |
| `JOB_URL` | Pinetree careers page | The job posting to read. |
| `PERSONA_PATH` | `./persona.sample.json` | The persona to apply as. The `resumeFile` path resolves relative to the persona file. |
| `ANTHROPIC_API_KEY` / `ANTHROPIC_MODEL` | — / `claude-sonnet-4-5` | Enables the Anthropic LLM path. |
| `OPENAI_API_KEY` / `OPENAI_BASE_URL` / `OPENAI_MODEL` | — | Enables the OpenAI-compatible LLM path (key *and* base URL required). |

The sample persona is a fictional software engineer. To apply as yourself, copy `persona.sample.json` to your own file, fill it in, point `PERSONA_PATH` at it, and set `resumeFile` to your resume.

### Privacy

- **The replay is a recording of everything typed into the page.** The rrweb NDJSON contains the persona's name, email, cover letter, and form answers in cleartext (input values are captured by default). It is kept server-side for your plan tier's retention window and written to `run-output/replay.ndjson` on this machine. Use the sample persona for any replay you share, and delete `run-output/replay.ndjson` after a demo if it holds real data.
- **LLM mode sends personal data to a third party.** When `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` is set, the persona fields plus the job and company context are transmitted to that provider (Anthropic Messages API or your OpenAI-compatible endpoint) over HTTPS. Deterministic mode sends no persona data to any third party.
- **This example never submits to a real employer.** The only submit target is the sandbox-hosted form this pipeline serves (R11). The posting is read only; nothing is sent to the company that posted it.

## How the pieces fit

- `index.ts` — orchestration and staged teardown
- `config.ts`, `types.ts`, `runlog.ts` — config, shared types, structured logging
- `posting.ts` — read + normalize the posting, research the employer
- `tailor.ts`, `llm.ts` — deterministic + optional LLM tailoring with fallback
- `sandbox-host.ts`, `form/` — the safe application form (HTML + Python stdlib server) inside the sandbox
- `submit.ts` — browser fill, resume upload, submit, confirm
- `replay.ts` — async replay download

## Gotchas this example encodes

- **Staged teardown order matters.** `index.ts` closes the browser session first (releasing it starts the async replay upload), then downloads the replay and reads the sandbox submission receipt *while the browser client and sandbox are still alive*, and only then kills the sandbox and closes the client. Reversing that order silently loses the replay and the receipt.
- **Replay upload is async after release.** The first `downloadReplay` polls usually 404 on a perfectly good recording; `replay.ts` retries for ~30s before falling back to printing the session id and a console link.
- **`browser.close()` is enough to exit (as of `@solarisdk/browser` 0.1.3).** The client unrefs its retry listener, so `browser.close()` alone lets the process exit; `solari.close()` is still called to release the client's pool promptly.
- **`kill()`, not `close()`, ends a sandbox.** `close()` drops the local control channel; the VM keeps running until its idle timeout. `disposeHostedForm` calls `sandbox.kill()`.
- **Sandbox commands are not shell-interpreted.** The form server is started via an explicit `sh -c` with `nohup … &` so it runs backgrounded.

## Troubleshooting

- **No replay after the run** — the upload can lag; the run prints the session id so you can open it in the Solari console (retention follows your plan tier). 
- **The posting changed or is unreachable** — the run prints a diagnostic naming the URL and the `JOB_URL` override, then exits non-zero. Point `JOB_URL` at a current posting.
- **Preview URL not ready** — `sandbox-host.ts` polls until the form answers HTTP 200; if it never does, check the sandbox console for the server log.

Source: [`index.ts`](index.ts)
