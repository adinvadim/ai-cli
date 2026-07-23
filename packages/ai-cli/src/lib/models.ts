import type { ProviderName } from "./providers.js";

export type Modality = "text" | "image" | "video";

const PROVIDER_DEFAULTS: Record<ProviderName, Record<Modality, string>> = {
  gateway: {
    text: "openai/gpt-5.5",
    image: "openai/gpt-image-2",
    video: "bytedance/seedance-2.0",
  },
  openrouter: {
    text: "openai/gpt-5-mini",
    image: "openai/gpt-5-image-mini",
    video: "openrouter/auto",
  },
};

const GATEWAY_MODELS_URL = "https://ai-gateway.vercel.sh/v1/models";
const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";
const GATEWAY_TIMEOUT_MS = 5_000;

export interface ModelPricing {
  input?: string;
  output?: string;
  image?: string;
}

export interface ModelEntry {
  id: string;
  name?: string;
  description?: string;
  creator: string;
  capabilities: Modality[];
  pricing?: ModelPricing;
}

export interface GatewayModels {
  text: ModelEntry[];
  image: ModelEntry[];
  video: ModelEntry[];
  all: ModelEntry[];
  languageImageModelIds: Set<string>;
}

interface RawGatewayModel {
  id: string;
  name?: string;
  description?: string;
  owned_by?: string;
  type?: string;
  tags?: string[];
  pricing?: {
    input?: string;
    output?: string;
    image?: string;
  };
}

interface RawOpenRouterModel {
  id: string;
  name?: string;
  description?: string;
  architecture?: {
    output_modalities?: string[];
  };
  pricing?: {
    prompt?: string;
    completion?: string;
    image?: string;
  };
}

const cached = new Map<ProviderName, Promise<GatewayModels>>();

export function fetchGatewayModels(): Promise<GatewayModels> {
  return fetchModels("gateway");
}

export function fetchModels(provider: ProviderName): Promise<GatewayModels> {
  const existing = cached.get(provider);
  if (existing) return existing;

  const next = doFetch(provider).catch((err) => {
    cached.delete(provider);
    throw err;
  });
  cached.set(provider, next);
  return next;
}

export function resetGatewayCache(): void {
  cached.delete("gateway");
}

export function resetModelsCache(): void {
  cached.clear();
}

async function doFetch(provider: ProviderName): Promise<GatewayModels> {
  return provider === "openrouter"
    ? fetchOpenRouterModels()
    : fetchAiGatewayModels();
}

async function fetchAiGatewayModels(): Promise<GatewayModels> {
  const result: GatewayModels = {
    text: [],
    image: [],
    video: [],
    all: [],
    languageImageModelIds: new Set(),
  };

  try {
    const res = await fetch(GATEWAY_MODELS_URL, {
      signal: AbortSignal.timeout(GATEWAY_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = (await res.json()) as { data?: RawGatewayModel[] };
    const models = json.data ?? [];

    const entryMap = new Map<string, ModelEntry>();

    for (const m of models) {
      const tags = m.tags ?? [];
      const isImageGen = tags.includes("image-generation");
      const capabilities: Modality[] = [];

      switch (m.type) {
        case "language":
          capabilities.push("text");
          if (isImageGen) capabilities.push("image");
          break;
        case "image":
          capabilities.push("image");
          break;
        case "video":
          capabilities.push("video");
          break;
        default:
          continue;
      }

      const creator =
        m.owned_by ??
        (m.id.slice(0, Math.max(0, m.id.indexOf("/"))) || "other");

      const pricing: ModelPricing | undefined =
        m.pricing?.input || m.pricing?.output || m.pricing?.image
          ? {
              ...(m.pricing.input ? { input: m.pricing.input } : {}),
              ...(m.pricing.output ? { output: m.pricing.output } : {}),
              ...(m.pricing.image ? { image: m.pricing.image } : {}),
            }
          : undefined;

      const entry: ModelEntry = {
        id: m.id,
        name: m.name,
        description: m.description,
        creator,
        capabilities,
        pricing,
      };

      entryMap.set(m.id, entry);

      if (capabilities.includes("text")) result.text.push(entry);
      if (capabilities.includes("image")) result.image.push(entry);
      if (capabilities.includes("video")) result.video.push(entry);

      if (m.type === "language" && isImageGen) {
        result.languageImageModelIds.add(m.id);
      }
    }

    result.all = [...entryMap.values()];
  } catch {
    cached.delete("gateway");
    process.stderr.write("Warning: could not fetch models from AI Gateway\n");
  }

  return result;
}

async function fetchOpenRouterModels(): Promise<GatewayModels> {
  const result: GatewayModels = {
    text: [],
    image: [],
    video: [],
    all: [],
    languageImageModelIds: new Set(),
  };

  try {
    const res = await fetch(OPENROUTER_MODELS_URL, {
      signal: AbortSignal.timeout(GATEWAY_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = (await res.json()) as { data?: RawOpenRouterModel[] };
    const models = json.data ?? [];

    for (const m of models) {
      const outputs = m.architecture?.output_modalities ?? [];
      const capabilities: Modality[] = [];

      if (outputs.includes("text")) capabilities.push("text");
      if (outputs.includes("image")) capabilities.push("image");
      if (outputs.includes("video")) capabilities.push("video");
      if (capabilities.length === 0) continue;

      const creator = m.id.slice(0, Math.max(0, m.id.indexOf("/"))) || "other";
      const pricing: ModelPricing | undefined =
        m.pricing?.prompt || m.pricing?.completion || m.pricing?.image
          ? {
              ...(m.pricing.prompt ? { input: m.pricing.prompt } : {}),
              ...(m.pricing.completion ? { output: m.pricing.completion } : {}),
              ...(m.pricing.image ? { image: m.pricing.image } : {}),
            }
          : undefined;

      const entry: ModelEntry = {
        id: m.id,
        name: m.name,
        description: m.description,
        creator,
        capabilities,
        pricing,
      };

      result.all.push(entry);
      if (capabilities.includes("text")) result.text.push(entry);
      if (capabilities.includes("image")) result.image.push(entry);
      if (capabilities.includes("video")) result.video.push(entry);

      if (capabilities.includes("text") && capabilities.includes("image")) {
        result.languageImageModelIds.add(m.id);
      }
    }
  } catch {
    cached.delete("openrouter");
    process.stderr.write("Warning: could not fetch models from OpenRouter\n");
  }

  return result;
}

export function resolveModels(
  modality: Modality,
  userModel?: string,
  knownModels?: Pick<ModelEntry, "id">[],
  provider: ProviderName = "gateway"
): string[] {
  if (!userModel) return [defaultModel(modality, provider)];
  const models = userModel
    .split(",")
    .map((m) => m.trim())
    .filter(Boolean)
    .map((m) => expandModelId(m, knownModels));
  return models.length > 0 ? models : [defaultModel(modality, provider)];
}

function defaultModel(modality: Modality, provider: ProviderName): string {
  switch (modality) {
    case "text":
      return process.env.AI_CLI_TEXT_MODEL ?? PROVIDER_DEFAULTS[provider].text;
    case "image":
      return (
        process.env.AI_CLI_IMAGE_MODEL ?? PROVIDER_DEFAULTS[provider].image
      );
    case "video":
      return (
        process.env.AI_CLI_VIDEO_MODEL ?? PROVIDER_DEFAULTS[provider].video
      );
  }
}

function expandModelId(
  input: string,
  knownModels?: Pick<ModelEntry, "id">[]
): string {
  if (input.includes("/")) return input;
  if (!knownModels) return input;

  for (const m of knownModels) {
    const name = m.id.slice(m.id.indexOf("/") + 1);
    if (name === input) return m.id;
  }

  return input;
}
