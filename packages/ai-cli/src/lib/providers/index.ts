import type { createGateway } from "@ai-sdk/gateway";
import type {
  experimental_generateVideo as generateVideo,
  ImageModel,
  LanguageModel,
} from "ai";

import type { GatewayModels, Modality } from "../models.js";
import { createCodexProvider } from "./codex.js";
import { createGrokProvider } from "./grok.js";
import { createOpenRouterProvider } from "./openrouter.js";

export const PROVIDER_NAMES = [
  "gateway",
  "openrouter",
  "codex",
  "grok",
] as const;
export type ProviderName = (typeof PROVIDER_NAMES)[number];

export type VideoModel = Parameters<typeof generateVideo>[0]["model"];

/** Model factory and catalog for one backend. Commands only talk to this. */
export interface ModelProvider {
  readonly name: ProviderName;
  /** Human-readable backend name for errors, e.g. "AI Gateway". */
  readonly label: string;
  languageModel(modelId: string): LanguageModel;
  imageModel(modelId: string): ImageModel;
  videoModel(modelId: string): VideoModel;
  catalog(): Promise<GatewayModels>;
  /** Default model per modality when -m and AI_CLI_*_MODEL are unset. */
  readonly defaults: Partial<Record<Modality, string>>;
  /** True when every image model returns images through generateImage. */
  readonly imageApiOnly?: boolean;
}

export function resolveProviderName(input?: string): ProviderName {
  const raw = (
    input ??
    (process.env.AI_CLI_PROVIDER || undefined) ??
    inferProviderFromKeys()
  )
    .trim()
    .toLowerCase();
  if ((PROVIDER_NAMES as readonly string[]).includes(raw))
    return raw as ProviderName;
  throw new Error(
    `--provider must be one of: ${PROVIDER_NAMES.join(", ")} (got "${input ?? process.env.AI_CLI_PROVIDER}")`
  );
}

/** OpenRouter wins only when it is the sole configured key, so existing Gateway setups keep working. */
function inferProviderFromKeys(): ProviderName {
  if (process.env.OPENROUTER_API_KEY && !process.env.AI_GATEWAY_API_KEY)
    return "openrouter";
  return "gateway";
}

export interface ProviderContext {
  gateway: ReturnType<typeof createGateway>;
  catalogOptions: { baseURL?: string; headers?: Record<string, string> };
  headers: Record<string, string>;
}

export function createModelProvider(
  name: ProviderName,
  context: ProviderContext,
  fetchGatewayModels: (
    options: ProviderContext["catalogOptions"]
  ) => Promise<GatewayModels>
): ModelProvider {
  switch (name) {
    case "gateway":
      return {
        name,
        label: "AI Gateway",
        languageModel: (id) => context.gateway(id),
        imageModel: (id) => context.gateway.image(id),
        videoModel: (id) => context.gateway.video(id),
        catalog: () => fetchGatewayModels(context.catalogOptions),
        defaults: {},
      };
    case "openrouter":
      return createOpenRouterProvider(context.headers);
    case "codex":
      return createCodexProvider();
    case "grok":
      return createGrokProvider();
  }
}

/** Reject options that only make sense for AI Gateway before they are silently ignored. */
export function assertGatewayOnlyOptions(
  provider: ProviderName,
  options: { baseUrl?: string; scope?: string; teamIdOrSlug?: string }
): void {
  if (provider === "gateway") return;
  const flag = options.baseUrl
    ? "--base-url"
    : options.scope
      ? "--scope"
      : options.teamIdOrSlug
        ? "--team-id-or-slug"
        : undefined;
  if (flag)
    throw new Error(
      `${flag} applies to AI Gateway only (got --provider ${provider})`
    );
}
