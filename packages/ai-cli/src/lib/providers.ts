import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import {
  type experimental_generateVideo as generateVideo,
  gateway,
  type ImageModel,
  type LanguageModel,
} from "ai";

export type ProviderName = "gateway" | "openrouter";
type VideoModel = Parameters<typeof generateVideo>[0]["model"];

const PROVIDERS = ["gateway", "openrouter"] as const;

let cachedOpenRouter: ReturnType<typeof createOpenRouter> | undefined;

export function resolveProvider(input?: string): ProviderName {
  const raw = (input ?? process.env.AI_CLI_PROVIDER ?? inferProviderFromKeys())
    .trim()
    .toLowerCase();
  if (PROVIDERS.includes(raw as ProviderName)) return raw as ProviderName;
  throw new Error(
    `provider must be one of: ${PROVIDERS.join(", ")} (got "${input ?? process.env.AI_CLI_PROVIDER}")`
  );
}

export function textModel(
  provider: ProviderName,
  modelId: string
): LanguageModel {
  if (provider === "openrouter") return getOpenRouter().chat(modelId);
  return gateway(modelId);
}

export function imageModel(
  provider: ProviderName,
  modelId: string
): ImageModel {
  if (provider === "openrouter") return getOpenRouter().imageModel(modelId);
  return gateway.image(modelId);
}

export function videoModel(
  provider: ProviderName,
  modelId: string
): VideoModel {
  if (provider === "openrouter") return getOpenRouter().videoModel(modelId);
  return gateway.video(modelId);
}

function getOpenRouter() {
  cachedOpenRouter ??= createOpenRouter({
    apiKey: process.env.OPENROUTER_API_KEY,
    appName: "ai-cli",
    appUrl: "https://github.com/vercel-labs/ai-cli",
    compatibility: "strict",
  });
  return cachedOpenRouter;
}

function inferProviderFromKeys(): ProviderName {
  if (process.env.OPENROUTER_API_KEY && !process.env.AI_GATEWAY_API_KEY) {
    return "openrouter";
  }
  return "gateway";
}
