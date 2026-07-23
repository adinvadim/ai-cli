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
    // openrouter/auto is chat-only; use a real video model from /videos/models
    video: "bytedance/seedance-2.0",
  },
};

const GATEWAY_MODELS_URL = "https://ai-gateway.vercel.sh/v1/models";
const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";
const OPENROUTER_IMAGE_MODELS_URL = "https://openrouter.ai/api/v1/images/models";
const OPENROUTER_VIDEO_MODELS_URL = "https://openrouter.ai/api/v1/videos/models";
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
    // OpenRouter image models use the dedicated imageModel API (/images), not
    // generateText language-image routing (modalities differ from Gateway).
    languageImageModelIds: new Set(),
  };

  const entryMap = new Map<string, ModelEntry>();

  try {
    const settled = await Promise.allSettled([
      fetchOpenRouterCatalog(OPENROUTER_MODELS_URL),
      fetchOpenRouterCatalog(OPENROUTER_IMAGE_MODELS_URL),
      fetchOpenRouterCatalog(OPENROUTER_VIDEO_MODELS_URL),
    ]);

    const [general, images, videos] = settled.map((item) =>
      item.status === "fulfilled" ? item.value : null
    );

    if (!general && !images && !videos) {
      throw new Error("all OpenRouter model catalogs failed");
    }

    if (general) {
      for (const m of general) {
        const outputs = m.architecture?.output_modalities ?? [];
        const capabilities: Modality[] = [];
        if (outputs.includes("text")) capabilities.push("text");
        if (outputs.includes("image")) capabilities.push("image");
        if (outputs.includes("video")) capabilities.push("video");
        if (capabilities.length === 0) continue;
        upsertOpenRouterEntry(entryMap, m, capabilities);
      }
    }

    if (images) {
      for (const m of images) {
        upsertOpenRouterEntry(entryMap, m, ["image"]);
      }
    }

    if (videos) {
      for (const m of videos) {
        upsertOpenRouterEntry(entryMap, m, ["video"]);
      }
    }

    for (const entry of entryMap.values()) {
      result.all.push(entry);
      if (entry.capabilities.includes("text")) result.text.push(entry);
      if (entry.capabilities.includes("image")) result.image.push(entry);
      if (entry.capabilities.includes("video")) result.video.push(entry);
    }
  } catch {
    cached.delete("openrouter");
    process.stderr.write("Warning: could not fetch models from OpenRouter\n");
  }

  return result;
}

async function fetchOpenRouterCatalog(
  url: string
): Promise<RawOpenRouterModel[]> {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(GATEWAY_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const json = (await res.json()) as { data?: RawOpenRouterModel[] };
  return json.data ?? [];
}

function upsertOpenRouterEntry(
  entryMap: Map<string, ModelEntry>,
  raw: RawOpenRouterModel,
  addCapabilities: Modality[]
): void {
  const existing = entryMap.get(raw.id);
  const creator =
    raw.id.slice(0, Math.max(0, raw.id.indexOf("/"))) || "other";
  const pricing: ModelPricing | undefined =
    raw.pricing?.prompt || raw.pricing?.completion || raw.pricing?.image
      ? {
          ...(raw.pricing.prompt ? { input: raw.pricing.prompt } : {}),
          ...(raw.pricing.completion ? { output: raw.pricing.completion } : {}),
          ...(raw.pricing.image ? { image: raw.pricing.image } : {}),
        }
      : undefined;

  if (!existing) {
    entryMap.set(raw.id, {
      id: raw.id,
      name: raw.name,
      description: raw.description,
      creator,
      capabilities: [...new Set(addCapabilities)],
      pricing,
    });
    return;
  }

  const caps = new Set(existing.capabilities);
  for (const c of addCapabilities) caps.add(c);
  existing.capabilities = [...caps];
  if (!existing.name && raw.name) existing.name = raw.name;
  if (!existing.description && raw.description) {
    existing.description = raw.description;
  }
  if (!existing.pricing && pricing) existing.pricing = pricing;
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
