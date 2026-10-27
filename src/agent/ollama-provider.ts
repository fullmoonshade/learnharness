import {
	createProvider,
	type Model,
	type ModelInputModality,
	type ThinkingLevelMap,
} from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { z } from "zod";

const DEFAULT_BASE_URL = "http://127.0.0.1:11434";
const DEFAULT_MAX_TOKENS = 8_192;
const DISCOVERY_TIMEOUT_MS = 3_000;
const PI_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
type OllamaEnv = {
	OLLAMA_BASE_URL?: string;
	OLLAMA_MAX_TOKENS?: string;
};
const OllamaTagsSchema = z.object({
	models: z.array(z.object({
		name: z.string().optional(),
		model: z.string().optional(),
	})).default([]),
});
const OllamaShowSchema = z.object({
	capabilities: z.array(z.string()).default([]),
	model_info: z.record(z.string(), z.unknown()).default({}),
	thinking: z.object({
		values: z.array(z.union([z.boolean(), z.string()])),
		default: z.union([z.boolean(), z.string()]),
	}).optional(),
});

export type OllamaState = "ready" | "unreachable" | "no-compatible-models";

export interface OllamaStatus {
	endpoint: string;
	state: OllamaState;
	message: string;
}

let status: OllamaStatus = {
	endpoint: ollamaNativeBaseUrl(),
	state: "unreachable",
	message: "Ollama has not been checked yet.",
};


/** Native Ollama endpoint. OLLAMA_BASE_URL may include the OpenAI /v1 suffix. */
export function ollamaNativeBaseUrl(env?: OllamaEnv): string {
	const configured = ((env ? env.OLLAMA_BASE_URL : process.env.OLLAMA_BASE_URL) ?? DEFAULT_BASE_URL).trim().replace(/\/+$/, "");
	return configured.endsWith("/v1") ? configured.slice(0, -3) : configured;
}

export function ollamaOpenAIBaseUrl(env?: OllamaEnv): string {
	return `${ollamaNativeBaseUrl(env)}/v1`;
}

export function ollamaMaxTokens(env?: OllamaEnv): number {
	const configured = Number(env ? env.OLLAMA_MAX_TOKENS : process.env.OLLAMA_MAX_TOKENS);
	return Number.isSafeInteger(configured) && configured > 0 ? configured : DEFAULT_MAX_TOKENS;
}

export function ollamaStatus(): OllamaStatus {
	return status;
}



function contextWindow(value: unknown): number | undefined {
	if (!value || typeof value !== "object") return undefined;
	for (const [key, entry] of Object.entries(value)) {
		if (key.endsWith(".context_length") && typeof entry === "number" && Number.isSafeInteger(entry) && entry > 0) return entry;
	}
	return undefined;
}

function thinkingLevelMap(values: (boolean | string)[] | undefined): ThinkingLevelMap | undefined {
	if (!values || values.some((entry) => typeof entry === "boolean")) return undefined;
	const names = new Set(values);
	if (names.size === 0) return undefined;
	const map: ThinkingLevelMap = {};
	for (const level of PI_LEVELS) map[level] = names.has(level) ? level : null;
	if (names.has("none")) map.off = "none";
	return map;
}


async function showModel(nativeBaseUrl: string, id: string, signal: AbortSignal): Promise<z.infer<typeof OllamaShowSchema> | undefined> {
	const response = await fetch(`${nativeBaseUrl}/api/show`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ model: id }),
		signal,
	});
	if (!response.ok) return undefined;
	const parsed = OllamaShowSchema.safeParse(await response.json());
	return parsed.success ? parsed.data : undefined;
}

async function discoverModels(nativeBaseUrl: string, maxTokens: number, signal: AbortSignal): Promise<Model<"openai-completions">[]> {
	const response = await fetch(`${nativeBaseUrl}/api/tags`, { signal });
	if (!response.ok) throw new Error(`Ollama returned HTTP ${response.status}`);
	const payload = OllamaTagsSchema.parse(await response.json());
	const discovered = await Promise.all(payload.models.map(async (tag): Promise<Model<"openai-completions"> | undefined> => {
		const id = tag.model || tag.name;
		if (!id) return undefined;
		const details = await showModel(nativeBaseUrl, id, signal);
		if (!details) return undefined;
		const capabilities = new Set(details.capabilities);
		const window = contextWindow(details.model_info);
		if (!capabilities.has("tools") || !window) return undefined;
		const reasoning = capabilities.has("thinking") && !(
			details.thinking?.values.length === 1 && details.thinking.values[0] === false
		);
		const input: ModelInputModality[] = capabilities.has("vision") ? ["text", "image"] : ["text"];
		return {
			id,
			name: id,
			api: "openai-completions",
			provider: "ollama",
			baseUrl: `${nativeBaseUrl}/v1`,
			reasoning,
			...(reasoning ? { thinkingLevelMap: thinkingLevelMap(details.thinking?.values) } : {}),
			input,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: window,
			maxTokens: Math.min(maxTokens, window),
			compat: {
				maxTokensField: "max_tokens",
				supportsStore: false,
				supportsDeveloperRole: false,
				supportsStrictMode: false,
				supportsOpenAIGrammarTools: false,
			},
		} satisfies Model<"openai-completions">;
	}));
	return discovered.filter((model): model is Model<"openai-completions"> => model !== undefined);
}

export function ollamaProvider() {
	const nativeBaseUrl = ollamaNativeBaseUrl();
	return createProvider<"openai-completions">({
		id: "ollama",
		name: "Ollama",
		baseUrl: `${nativeBaseUrl}/v1`,
		auth: {
			apiKey: {
				name: "Local Ollama",
				check: async () => ({ type: "api_key", source: "local Ollama" }),
				resolve: async () => ({ auth: { apiKey: "ollama" }, source: "local Ollama" }),
			},
		},
		models: [],
		fetchModels: async (context) => {
			if (!context.allowNetwork) return [];
			const signal = AbortSignal.any([context.signal, AbortSignal.timeout(DISCOVERY_TIMEOUT_MS)]);
			try {
				const models = await discoverModels(nativeBaseUrl, ollamaMaxTokens(), signal);
				status = models.length > 0
					? { endpoint: nativeBaseUrl, state: "ready", message: `${models.length} compatible Ollama model${models.length === 1 ? "" : "s"} available.` }
					: { endpoint: nativeBaseUrl, state: "no-compatible-models", message: "Ollama is running, but no installed model advertises tool calling with a usable context window." };
				return models;
			} catch {
				status = {
					endpoint: nativeBaseUrl,
					state: "unreachable",
					message: `Ollama is not reachable at ${nativeBaseUrl}. Start Ollama or set OLLAMA_BASE_URL.`,
				};
				throw new Error(status.message);
			}
		},
		api: openAICompletionsApi(),
	});
}
