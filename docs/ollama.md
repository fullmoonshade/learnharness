# Ollama provider

LearnHarness can discover and run locally installed Ollama models through Pi AI's OpenAI Chat Completions adapter. Ollama is a keyless local provider: it does not add a fake credential to `auth.json` and it does not change the exact built-in API-key registry.

## User setup

1. Install and start [Ollama](https://ollama.com/).
2. Pull at least one model that advertises tool calling. LearnHarness excludes models without tool support because every teaching and background-agent workflow depends on structured tools.
3. Pull a model that advertises both vision and tool support for the required Vision slot.
4. Start LearnHarness and open model setup. The installed compatible models appear under the `ollama` provider.

The default endpoint is:

```text
http://127.0.0.1:11434
```

Optional machine configuration:

| Variable | Default | Purpose |
|---|---:|---|
| `OLLAMA_BASE_URL` | `http://127.0.0.1:11434` | Native Ollama server URL. A trailing `/v1` is accepted and normalized. |
| `OLLAMA_MAX_TOKENS` | `8192` | Conservative output-token metadata for discovered models. Invalid and non-positive values use the default. The value is capped at the model's context window. |

Restart LearnHarness after changing either variable because the provider captures its endpoint when the process builds the Pi model collection.

## Runtime design

`src/agent/ollama-provider.ts` owns the integration:

- `GET /api/tags` lists locally installed models.
- `POST /api/show` reads capabilities, thinking controls, and the architecture-specific `*.context_length` value.
- Only models with `tools` and a positive context window enter the LearnHarness catalog.
- `vision` adds image input.
- `thinking` enables Pi reasoning levels. Named Ollama levels that match Pi levels are projected exactly; boolean thinking support uses Pi's standard OpenAI-compatible aliases.
- Cost is zero because the local server does not bill tokens.
- Requests use Pi's `openai-completions` adapter against `<base>/v1` with an internal dummy key. Ollama requires a client key value but ignores it locally.

`src/agent/models.ts` registers this provider in the same process-wide Pi collection as the built-in providers. `src/server/model-catalog.ts` refreshes Ollama before returning `/api/models` and projects its state into `CatalogProvider.local`:

- `ready`: at least one compatible model is selectable.
- `unreachable`: the server could not be reached within the discovery timeout.
- `no-compatible-models`: Ollama responded, but no installed model met the tool/context requirements.

The setup dialog renders that message directly. An unreachable server leaves the existing API-key setup available; a reachable server with no compatible models opens the model stage so the local remediation remains visible.

## Deliberate boundaries

- LearnHarness does not install, start, sign in to, or update Ollama.
- It does not pull models automatically.
- Endpoint configuration is environment-only; there is no persisted Providers UI field yet.
- Discovery is live and not persisted. A stopped server does not expose stale Ollama models in the picker.
- The provider does not infer an output limit from context length. `OLLAMA_MAX_TOKENS` owns that separate policy.
- Ollama's OpenAI endpoint does not currently support `tool_choice`; this integration does not force it.
- Models are capability-filtered, not quality-certified. A model may advertise tools but still be too weak to follow LearnHarness's schemas reliably.
- All three model slots remain required. An Ollama-only setup therefore needs a tool-capable vision model.

## Maintainer handoff

This integration was prepared without a local Ollama installation and without executing the repository test suite. Before merging:

```bash
npm install
npm run typecheck
npm run lint
npm test
```

Then perform a real runtime smoke:

1. Start Ollama on its default endpoint.
2. Install one tool-capable text model and one tool-capable vision model.
3. Open model setup and verify model IDs, image capability, context window, thinking levels, and zero cost.
4. Assign Strong, Cheap, and Vision slots.
5. Start a lesson and complete a prober question so both tool-call emission and tool-result replay are exercised.
6. Run one background job and one vision-backed job.
7. Abort an active generation and confirm Ollama stops producing output.
8. Stop Ollama, reopen setup, and verify the actionable unavailable message.
9. Restart Ollama and verify the catalog recovers without restarting LearnHarness.
10. Repeat with custom `OLLAMA_BASE_URL` and `OLLAMA_MAX_TOKENS` values.

The focused deterministic coverage is in `tests/ollama-provider.test.ts`, `tests/byok-refusal.test.ts`, and `tests/setup-dialog-interaction.test.tsx`. If the Pi dependency changes, re-check `createProvider`, dynamic `fetchModels`, keyless auth resolution, and the `openai-completions` compatibility fields against the exact locked package.
