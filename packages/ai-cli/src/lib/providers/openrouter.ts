import { createOpenRouter } from "@openrouter/ai-sdk-provider";

import {
  catalogFromEntries,
  type GatewayModels,
  type Modality,
  type ModelEntry,
  type ModelPricing,
} from "../models.js";
import type { ModelProvider } from "./index.js";

const BASE_URL = "https://openrouter.ai/api/v1";
const CATALOG_TIMEOUT_MS = 5_000;

interface RawOpenRouterModel {
  id: string;
  name?: string;
  description?: string;
  context_length?: number;
  architecture?: { output_modalities?: string[] };
  pricing?: Record<string, unknown>;
}

let cachedCatalog: Promise<GatewayModels> | undefined;

export function resetOpenRouterCatalog(): void {
  cachedCatalog = undefined;
}

export function createOpenRouterProvider(
  headers: Record<string, string>
): ModelProvider {
  const openrouter = createOpenRouter({
    apiKey: process.env.OPENROUTER_API_KEY,
    baseURL: process.env.OPENROUTER_BASE_URL || BASE_URL,
    appName: "ai-cli",
    appUrl: "https://github.com/vercel-labs/ai-cli",
    compatibility: "strict",
    headers,
  });
  return {
    name: "openrouter",
    label: "OpenRouter",
    languageModel: (id) => openrouter.chat(id),
    imageModel: (id) => openrouter.imageModel(id),
    videoModel: (id) => openrouter.videoModel(id),
    catalog: () => (cachedCatalog ??= fetchOpenRouterCatalog()),
    defaults: {
      text: "openai/gpt-5-mini",
      image: "openai/gpt-5-image-mini",
      video: "bytedance/seedance-2.0",
    },
    // OpenRouter serves image models through /images; generateText image
    // routing is a Gateway catalog concept.
    imageApiOnly: true,
  };
}

async function fetchOpenRouterCatalog(): Promise<GatewayModels> {
  const base = process.env.OPENROUTER_BASE_URL || BASE_URL;
  const [general, images, videos] = await Promise.all(
    ["/models", "/images/models", "/videos/models"].map((path) =>
      fetchList(base + path).catch(() => undefined)
    )
  );
  if (!general && !images && !videos) {
    cachedCatalog = undefined;
    process.stderr.write("Warning: could not fetch models from OpenRouter\n");
    return catalogFromEntries([], false);
  }
  const entries = new Map<string, ModelEntry>();
  for (const raw of general ?? []) {
    const outputs = raw.architecture?.output_modalities ?? [];
    const capabilities = (["text", "image", "video"] as const).filter((m) =>
      outputs.includes(m)
    );
    if (capabilities.length) upsert(entries, raw, capabilities);
  }
  for (const raw of images ?? []) upsert(entries, raw, ["image"]);
  for (const raw of videos ?? []) upsert(entries, raw, ["video"]);
  return catalogFromEntries([...entries.values()], true);
}

async function fetchList(url: string): Promise<RawOpenRouterModel[]> {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(CATALOG_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const json = (await res.json()) as { data?: unknown };
  if (!Array.isArray(json.data)) throw new Error(`Invalid catalog at ${url}`);
  return json.data.filter(
    (m): m is RawOpenRouterModel =>
      m !== null && typeof m === "object" && typeof m.id === "string"
  );
}

function upsert(
  entries: Map<string, ModelEntry>,
  raw: RawOpenRouterModel,
  capabilities: Modality[]
): void {
  const existing = entries.get(raw.id);
  if (existing) {
    existing.capabilities = [
      ...new Set([...existing.capabilities, ...capabilities]),
    ];
    existing.name ??= raw.name;
    existing.description ??= raw.description;
    existing.pricing ??= pricing(raw.pricing);
    return;
  }
  entries.set(raw.id, {
    id: raw.id,
    name: raw.name,
    description: raw.description,
    creator: raw.id.slice(0, Math.max(0, raw.id.indexOf("/"))) || "other",
    capabilities: [...new Set(capabilities)],
    pricing: pricing(raw.pricing),
    contextWindow: raw.context_length,
  });
}

function pricing(raw?: Record<string, unknown>): ModelPricing | undefined {
  if (!raw) return undefined;
  const { prompt, completion, image } = raw;
  const result: ModelPricing = {
    ...(typeof prompt === "string" && prompt ? { input: prompt } : {}),
    ...(typeof completion === "string" && completion
      ? { output: completion }
      : {}),
    ...(typeof image === "string" && image ? { image } : {}),
  };
  return Object.keys(result).length ? result : undefined;
}
