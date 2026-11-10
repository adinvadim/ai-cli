export type Modality =
  | "text"
  | "image"
  | "video"
  | "speech"
  | "transcription"
  | "evaluation";

const BUILTIN_DEFAULTS: Record<Modality, string> = {
  text: "openai/gpt-5.5",
  image: "openai/gpt-image-2",
  video: "bytedance/seedance-2.0",
  speech: "openai/tts-1",
  transcription: "openai/whisper-1",
  evaluation: "typesafe-ai/jev",
};

const DEFAULT_ENV: Record<Modality, string> = {
  text: "AI_CLI_TEXT_MODEL",
  image: "AI_CLI_IMAGE_MODEL",
  video: "AI_CLI_VIDEO_MODEL",
  speech: "AI_CLI_SPEECH_MODEL",
  transcription: "AI_CLI_TRANSCRIPTION_MODEL",
  evaluation: "AI_CLI_EVALUATION_MODEL",
};

/** Default models from AI_CLI_*_MODEL; they describe the default provider. */
export function envModelDefaults(): Partial<Record<Modality, string>> {
  const defaults: Partial<Record<Modality, string>> = {};
  for (const [modality, name] of Object.entries(DEFAULT_ENV))
    if (process.env[name]) defaults[modality as Modality] = process.env[name];
  return defaults;
}

/** The provider's default for a modality, else the AI Gateway default. */
export function defaultModel(
  modality: Modality,
  defaults: Partial<Record<Modality, string>> = envModelDefaults()
): string {
  return defaults[modality] || BUILTIN_DEFAULTS[modality];
}

const GATEWAY_MODELS_URL = "https://ai-gateway.vercel.sh/v1/models";
const GATEWAY_TIMEOUT_MS = 5_000;

export interface ModelEndpoint {
  provider_name?: string;
  context_length?: number;
  max_completion_tokens?: number;
  pricing?: {
    prompt?: string;
    completion?: string;
    input_cache_read?: string;
    input_cache_write?: string;
    web_search?: string;
    [key: string]: unknown;
  };
  tags?: string[];
  uptime_last_1d?: number;
  latency_last_1h?: { p50?: number; p95?: number };
  throughput_last_1h?: { p50?: number; p95?: number };
}

export interface ModelEndpointsInfo {
  id: string;
  name?: string;
  description?: string;
  released?: number;
  endpoints: ModelEndpoint[];
}

export interface ModelPricing {
  input?: string;
  output?: string;
  image?: string;
  [key: string]: unknown;
}

export interface ModelEntry {
  [key: string]: unknown;
  id: string;
  name?: string;
  description?: string;
  creator: string;
  capabilities: Modality[];
  pricing?: ModelPricing;
  contextWindow?: number;
  maxTokens?: number;
  released?: number;
  tags?: string[];
}

export interface GatewayModels {
  available: boolean;
  text: ModelEntry[];
  image: ModelEntry[];
  video: ModelEntry[];
  speech: ModelEntry[];
  transcription: ModelEntry[];
  evaluation: ModelEntry[];
  /** Models with a modality supported by the CLI. */
  all: ModelEntry[];
  /** Every gateway model, including types the CLI cannot generate with
   * (embedding, realtime, reranking, ...). */
  lookup: ModelEntry[];
  languageImageModelIds: Set<string>;
}

interface RawGatewayModel {
  [key: string]: unknown;
  id: string;
  name?: string;
  description?: string;
  owned_by?: string;
  type?: string;
  tags?: string[];
  context_window?: number;
  max_tokens?: number;
  released?: number;
  pricing?: {
    [key: string]: unknown;
  };
}

let cached: Promise<GatewayModels> | null = null;

function emptyGatewayModels(): GatewayModels {
  return {
    available: false,
    text: [],
    image: [],
    video: [],
    speech: [],
    transcription: [],
    evaluation: [],
    all: [],
    lookup: [],
    languageImageModelIds: new Set(),
  };
}

function isRawGatewayModel(value: unknown): value is RawGatewayModel {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return false;
  const model = value as Record<string, unknown>;
  return (
    typeof model.id === "string" &&
    model.id.length > 0 &&
    typeof model.type === "string" &&
    (model.owned_by == null || typeof model.owned_by === "string") &&
    (model.tags == null ||
      (Array.isArray(model.tags) &&
        model.tags.every((tag) => typeof tag === "string")))
  );
}

export function fetchGatewayModels(options?: {
  baseURL?: string;
  headers?: Record<string, string>;
}): Promise<GatewayModels> {
  if (options) return doFetch(options);
  if (!cached) {
    cached = doFetch().catch((err) => {
      cached = null;
      throw err;
    });
  }
  return cached;
}

export function resetGatewayCache(): void {
  cached = null;
}

async function doFetch(options?: {
  baseURL?: string;
  headers?: Record<string, string>;
}): Promise<GatewayModels> {
  const result = emptyGatewayModels();

  try {
    const res = await fetch(
      options?.baseURL
        ? new URL("/v1/models", options.baseURL)
        : GATEWAY_MODELS_URL,
      {
        headers: options?.headers,
        signal: AbortSignal.timeout(GATEWAY_TIMEOUT_MS),
      }
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json: unknown = await res.json();
    if (
      json === null ||
      typeof json !== "object" ||
      !("data" in json) ||
      !Array.isArray(json.data) ||
      !json.data.every(isRawGatewayModel)
    )
      throw new Error("Invalid AI Gateway model catalog");
    const models: RawGatewayModel[] = json.data;

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
        case "speech":
          capabilities.push("speech");
          break;
        case "transcription":
          capabilities.push("transcription");
          break;
        case "evaluation":
          capabilities.push("evaluation");
          break;
        default:
          break;
      }

      const creator =
        m.owned_by ??
        (m.id.slice(0, Math.max(0, m.id.indexOf("/"))) || "other");

      const pricing = normalizePricing(m.pricing);

      const entry: ModelEntry = {
        ...m,
        id: m.id,
        name: m.name,
        description: m.description,
        creator,
        capabilities,
        pricing,
        contextWindow: m.context_window,
        maxTokens: m.max_tokens,
        released: m.released,
        tags: tags.length > 0 ? tags : undefined,
      };

      entryMap.set(m.id, entry);

      if (capabilities.includes("text")) result.text.push(entry);
      if (capabilities.includes("image")) result.image.push(entry);
      if (capabilities.includes("video")) result.video.push(entry);
      if (capabilities.includes("speech")) result.speech.push(entry);
      if (capabilities.includes("transcription"))
        result.transcription.push(entry);
      if (capabilities.includes("evaluation")) result.evaluation.push(entry);

      if (m.type === "language" && isImageGen) {
        result.languageImageModelIds.add(m.id);
      }
    }

    result.lookup = [...entryMap.values()];
    result.all = result.lookup.filter((e) => e.capabilities.length > 0);
    result.available = true;
  } catch {
    cached = null;
    process.stderr.write("Warning: could not fetch models from AI Gateway\n");
    return emptyGatewayModels();
  }

  return result;
}

export async function fetchModelEndpoints(
  modelId: string,
  options?: { baseURL?: string; headers?: Record<string, string> }
): Promise<ModelEndpointsInfo | null> {
  try {
    const modelsUrl = options?.baseURL
      ? new URL("/v1/models", options.baseURL).href
      : GATEWAY_MODELS_URL;
    const res = await fetch(`${modelsUrl}/${modelId}/endpoints`, {
      headers: options?.headers,
      signal: AbortSignal.timeout(GATEWAY_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = (await res.json()) as { data?: ModelEndpointsInfo };
    if (!json.data) return null;
    return { ...json.data, endpoints: json.data.endpoints ?? [] };
  } catch {
    process.stderr.write(
      "Warning: could not fetch provider endpoints from AI Gateway\n"
    );
    return null;
  }
}

function normalizePricing(
  pricing?: Record<string, unknown>
): ModelPricing | undefined {
  if (!pricing) return undefined;

  const entries = Object.entries(pricing).filter(
    ([, value]) => value != null && value !== ""
  );
  if (entries.length === 0) return undefined;

  return Object.fromEntries(entries) as ModelPricing;
}

export function resolveModels(
  modality: Modality,
  userModel?: string,
  knownModels?: Pick<ModelEntry, "id">[],
  defaults?: Partial<Record<Modality, string>>
): string[] {
  const fallback = () => [validateModelId(defaultModel(modality, defaults))];
  if (!userModel) return fallback();
  const models = userModel
    .split(",")
    .map((m) => m.trim())
    .filter(Boolean)
    .map((m) => validateModelId(expandModelId(m, knownModels)));
  return models.length > 0 ? models : fallback();
}

/** Build a catalog from entries for providers without a Gateway-shaped model list. */
export function catalogFromEntries(
  entries: ModelEntry[],
  available: boolean,
  languageImageModelIds: Iterable<string> = []
): GatewayModels {
  const result = emptyGatewayModels();
  result.available = available;
  result.lookup = entries;
  result.all = entries.filter((entry) => entry.capabilities.length > 0);
  for (const entry of result.all)
    for (const capability of entry.capabilities) result[capability].push(entry);
  result.languageImageModelIds = new Set(languageImageModelIds);
  return result;
}

function validateModelId(modelId: string): string {
  // The Gateway SDK sends model IDs in an HTTP header. Validate before the SDK
  // turns an invalid header value into a retried GatewayResponseError.
  if (!/^[\x21-\x7e]+$/.test(modelId)) {
    throw new Error(
      `model ID must use printable ASCII characters without spaces (got ${JSON.stringify(modelId)})`
    );
  }
  return modelId;
}

export function expandModelId(
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
