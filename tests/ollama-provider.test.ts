import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { createModels, getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import {
	ollamaMaxTokens,
	ollamaNativeBaseUrl,
	ollamaOpenAIBaseUrl,
	ollamaProvider,
	ollamaStatus,
} from "../src/agent/ollama-provider.ts";

const originalFetch = globalThis.fetch;
const originalBaseUrl = process.env.OLLAMA_BASE_URL;
const originalMaxTokens = process.env.OLLAMA_MAX_TOKENS;

afterEach(() => {
	globalThis.fetch = originalFetch;
	if (originalBaseUrl === undefined) delete process.env.OLLAMA_BASE_URL;
	else process.env.OLLAMA_BASE_URL = originalBaseUrl;
	if (originalMaxTokens === undefined) delete process.env.OLLAMA_MAX_TOKENS;
	else process.env.OLLAMA_MAX_TOKENS = originalMaxTokens;
});

describe("Ollama provider configuration", () => {
	it("normalizes the native and OpenAI endpoints and applies the conservative output cap", () => {
		assert.equal(ollamaNativeBaseUrl({}), "http://127.0.0.1:11434");
		assert.equal(ollamaNativeBaseUrl({ OLLAMA_BASE_URL: "http://box:2244/v1/" }), "http://box:2244");
		assert.equal(ollamaOpenAIBaseUrl({ OLLAMA_BASE_URL: "http://box:2244/" }), "http://box:2244/v1");
		assert.equal(ollamaMaxTokens({}), 8_192);
		assert.equal(ollamaMaxTokens({ OLLAMA_MAX_TOKENS: "4096" }), 4_096);
		assert.equal(ollamaMaxTokens({ OLLAMA_MAX_TOKENS: "invalid" }), 8_192);
	});

	it("discovers only tool-capable models and projects vision, thinking, context, cost, and compatibility", async () => {
		delete process.env.OLLAMA_BASE_URL;
		delete process.env.OLLAMA_MAX_TOKENS;
		globalThis.fetch = async (input, init) => {
			const request = new Request(input, init);
			if (request.url.endsWith("/api/tags")) {
				return Response.json({ models: [{ model: "qwen-tool:8b" }, { name: "text-only:3b" }] });
			}
			assert.equal(request.method, "POST");
			const { model } = JSON.parse(await request.text()) as { model: string };
			return model === "qwen-tool:8b"
				? Response.json({
					capabilities: ["completion", "tools", "vision", "thinking"],
					model_info: { "qwen.context_length": 32_768 },
					thinking: { values: ["low", "high"], default: "high" },
				})
				: Response.json({ capabilities: ["completion"], model_info: { "llama.context_length": 8_192 } });
		};

		const models = createModels();
		models.setProvider(ollamaProvider());
		const refreshed = await models.refresh({ providers: ["ollama"], allowNetwork: true, force: true });
		assert.equal(refreshed.errors.size, 0);
		const discovered = models.getModels("ollama");
		assert.equal(discovered.length, 1);
		assert.deepEqual(getSupportedThinkingLevels(discovered[0]!), ["low", "high"]);
		assert.deepEqual(discovered[0], {
			id: "qwen-tool:8b",
			name: "qwen-tool:8b",
			api: "openai-completions",
			provider: "ollama",
			baseUrl: "http://127.0.0.1:11434/v1",
			reasoning: true,
			thinkingLevelMap: { off: null, minimal: null, low: "low", medium: null, high: "high", xhigh: null, max: null },
			input: ["text", "image"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 32_768,
			maxTokens: 8_192,
			compat: {
				maxTokensField: "max_tokens",
				supportsStore: false,
				supportsDeveloperRole: false,
				supportsStrictMode: false,
				supportsOpenAIGrammarTools: false,
			},
		});
		assert.equal(ollamaStatus().state, "ready");
	});

	it("reports an actionable unavailable state without publishing stale availability", async () => {
		delete process.env.OLLAMA_BASE_URL;
		delete process.env.OLLAMA_MAX_TOKENS;
		globalThis.fetch = async () => { throw new Error("synthetic connection refusal"); };
		const models = createModels();
		models.setProvider(ollamaProvider());
		const refreshed = await models.refresh({ providers: ["ollama"], allowNetwork: true, force: true });
		assert.ok(refreshed.errors.has("ollama"));
		assert.deepEqual(models.getModels("ollama"), []);
		assert.equal(ollamaStatus().state, "unreachable");
		assert.match(ollamaStatus().message, /Start Ollama or set OLLAMA_BASE_URL/);
	});
});
