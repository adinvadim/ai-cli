import { randomUUID } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  APICallError,
  type ImageModelV4,
  type ImageModelV4CallOptions,
  type ImageModelV4File,
  type SharedV4Warning,
} from "@ai-sdk/provider";

import { catalogFromEntries } from "../models.js";
import type { ModelProvider } from "./index.js";

export const CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex";
const REFRESH_URL = "https://auth.openai.com/oauth/token";
/** Public OAuth client of the Codex CLI. */
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
/** Codex refreshes when the access token is this close to expiry. */
const REFRESH_SKEW_MS = 5 * 60_000;
const MAX_REFERENCE_IMAGES = 5;
const REFRESH_TIMEOUT_MS = 30_000;
/** How long to wait for another process's refresh to land in auth.json. */
const ROTATION_WAIT_MS = 3_000;

interface CodexAuthFile {
  tokens?: {
    access_token?: string;
    refresh_token?: string;
    id_token?: string;
    account_id?: string;
  };
  last_refresh?: string;
  [key: string]: unknown;
}

export interface CodexCredentials {
  accessToken: string;
  accountId?: string;
}

export function codexHome(): string {
  return process.env.CODEX_HOME || join(homedir(), ".codex");
}

function jwtExpiry(token: string): number | undefined {
  try {
    const payload = JSON.parse(
      Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")
    ) as { exp?: unknown };
    return typeof payload.exp === "number" ? payload.exp * 1000 : undefined;
  } catch {
    return undefined;
  }
}

function isFresh(token: string | undefined, now = Date.now()): boolean {
  if (!token) return false;
  const expiry = jwtExpiry(token);
  return expiry === undefined || expiry - now > REFRESH_SKEW_MS;
}

/**
 * Reads the ChatGPT login saved by `codex login` and refreshes it the way
 * Codex does: reload from disk first, refresh only if still stale, then write
 * back atomically so running Codex sessions pick up the new tokens instead of
 * reusing the spent refresh token.
 */
export function createCodexAuth() {
  const path = () => join(codexHome(), "auth.json");
  let pending: Promise<CodexCredentials> | undefined;
  let pendingRejected: string | undefined;

  async function read(): Promise<CodexAuthFile> {
    try {
      return JSON.parse(await readFile(path(), "utf8")) as CodexAuthFile;
    } catch {
      throw new Error(
        "Not signed in to Codex. Run `codex login` and sign in with ChatGPT."
      );
    }
  }

  function credentials(auth: CodexAuthFile): CodexCredentials {
    const accessToken = auth.tokens?.access_token;
    if (!accessToken)
      throw new Error(
        "Codex is not signed in with ChatGPT. Run `codex login` (API-key logins cannot generate images through Codex)."
      );
    return { accessToken, accountId: auth.tokens?.account_id };
  }

  /** A token is usable when it is unexpired and is not the one the server just rejected. */
  function usable(auth: CodexAuthFile, rejected?: string): boolean {
    const token = auth.tokens?.access_token;
    return isFresh(token) && token !== rejected;
  }

  async function refresh(rejected?: string): Promise<CodexCredentials> {
    // Guarded reload: another Codex process may have refreshed already.
    const auth = await read();
    if (usable(auth, rejected)) return credentials(auth);
    const refreshToken = auth.tokens?.refresh_token;
    if (!refreshToken)
      throw new Error("Your Codex login has expired. Run `codex login`.");
    const res = await globalThis.fetch(REFRESH_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_id: CLIENT_ID,
        grant_type: "refresh_token",
        refresh_token: refreshToken,
      }),
      signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS),
    });
    if (!res.ok) {
      // Another Codex or ai-cli process may have spent this refresh token
      // first; adopt the tokens it writes instead of failing.
      const rotated = await awaitRotation(refreshToken, rejected);
      if (rotated) return rotated;
      throw new Error(
        `Could not refresh your Codex login (HTTP ${res.status}). Run \`codex login\`.`
      );
    }
    const fresh = (await res.json()) as {
      access_token?: string;
      refresh_token?: string;
      id_token?: string;
    };
    if (!fresh.access_token)
      throw new Error(
        "Codex token refresh returned no access token. Run `codex login`."
      );
    const updated: CodexAuthFile = {
      ...auth,
      tokens: {
        ...auth.tokens,
        access_token: fresh.access_token,
        ...(fresh.refresh_token ? { refresh_token: fresh.refresh_token } : {}),
        ...(fresh.id_token ? { id_token: fresh.id_token } : {}),
      },
      last_refresh: new Date().toISOString(),
    };
    const temporary = `${path()}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(updated, null, 2), {
        mode: 0o600,
        flag: "wx",
      });
      await rename(temporary, path());
    } finally {
      await rm(temporary, { force: true }).catch(() => {});
    }
    return credentials(updated);
  }

  async function awaitRotation(
    spent: string,
    rejected?: string
  ): Promise<CodexCredentials | undefined> {
    const deadline = Date.now() + ROTATION_WAIT_MS;
    do {
      const auth = await read().catch(() => undefined);
      if (
        auth &&
        auth.tokens?.refresh_token !== spent &&
        usable(auth, rejected)
      )
        return credentials(auth);
      await new Promise((resolve) => setTimeout(resolve, 200));
    } while (Date.now() < deadline);
    return undefined;
  }

  async function load(rejected?: string): Promise<CodexCredentials> {
    const auth = await read();
    if (usable(auth, rejected)) return credentials(auth);
    return refresh(rejected);
  }

  return {
    /** Pass the access token the server rejected to force a refresh past it. */
    credentials: (rejected?: string) => {
      // Concurrent 401s for the same token share one refresh, so a
      // single-use refresh token is never sent twice.
      if (rejected !== undefined && rejected !== pendingRejected) {
        pending = undefined;
        pendingRejected = rejected;
      }
      pending ??= load(pendingRejected).catch((error: unknown) => {
        pending = undefined;
        pendingRejected = undefined;
        throw error;
      });
      return pending;
    },
  };
}

type CodexAuth = ReturnType<typeof createCodexAuth>;

export class CodexImageModel implements ImageModelV4 {
  readonly specificationVersion = "v4";
  readonly provider = "codex";
  // The SDK splits --n into one request per image.
  readonly maxImagesPerCall = 1;
  readonly supportsFileInputs = true;
  readonly supportsMaskInputs = false;

  constructor(
    readonly modelId: string,
    private readonly config: {
      auth: CodexAuth;
      baseURL: string;
    }
  ) {}

  async doGenerate(options: ImageModelV4CallOptions) {
    const warnings: SharedV4Warning[] = [];
    if (options.seed !== undefined)
      warnings.push({ type: "unsupported", feature: "seed" });
    if (options.mask)
      throw new Error("The codex provider does not support --mask");
    // The Codex image endpoint picks dimensions from the prompt and ignores
    // size, so ai-cli sends "auto" like Codex itself does.
    for (const [feature, value] of [
      ["size", options.size],
      ["aspectRatio", options.aspectRatio],
    ] as const)
      if (value !== undefined)
        warnings.push({
          type: "unsupported",
          feature,
          details:
            "Codex chooses image dimensions from the prompt; describe the shape there",
        });
    const files = options.files ?? [];
    if (files.length > MAX_REFERENCE_IMAGES)
      throw new Error(
        `The codex provider accepts at most ${MAX_REFERENCE_IMAGES} reference images`
      );
    const body = {
      ...options.providerOptions.codex,
      prompt: options.prompt ?? "",
      model: this.modelId,
      n: options.n,
      size: "auto",
      ...(files.length
        ? { images: files.map((file) => ({ image_url: imageUrl(file) })) }
        : {}),
    };
    const endpoint = files.length ? "/images/edits" : "/images/generations";
    const response = await this.post(endpoint, body, options);
    const json = (await response.json()) as {
      data?: Array<{ b64_json?: string }>;
    };
    const images = (json.data ?? [])
      .map((item) => item.b64_json)
      .filter((data): data is string => typeof data === "string" && !!data);
    if (images.length === 0)
      throw new Error(
        "Codex returned no images (the prompt may have been refused)"
      );
    return {
      images,
      warnings,
      response: {
        timestamp: new Date(),
        modelId: this.modelId,
        headers: Object.fromEntries(response.headers),
      },
    };
  }

  private async post(
    endpoint: string,
    body: unknown,
    options: ImageModelV4CallOptions
  ): Promise<Response> {
    const url = this.config.baseURL + endpoint;
    const send = async (rejected?: string) => {
      const { accessToken, accountId } =
        await this.config.auth.credentials(rejected);
      const headers = new Headers();
      for (const [name, value] of Object.entries(options.headers ?? {}))
        if (value !== undefined) headers.set(name, value);
      headers.set("authorization", `Bearer ${accessToken}`);
      if (accountId) headers.set("chatgpt-account-id", accountId);
      headers.set("originator", "codex_cli_rs");
      headers.set("content-type", "application/json");
      const response = await globalThis.fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: options.abortSignal,
      });
      return { response, accessToken };
    };
    const first = await send();
    const response =
      first.response.status === 401
        ? (await send(first.accessToken)).response
        : first.response;
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      // APICallError lets the SDK retry 408, 409, 429 and 5xx (--max-retries).
      throw new APICallError({
        message: `Codex image request failed (HTTP ${response.status})${text ? `: ${errorText(text)}` : ""}`,
        url,
        // Omit prompt and reference image data from error diagnostics.
        requestBodyValues: { model: this.modelId, endpoint },
        statusCode: response.status,
        responseHeaders: Object.fromEntries(response.headers),
        responseBody: text,
      });
    }
    return response;
  }
}

function errorText(text: string): string {
  try {
    const json = JSON.parse(text) as {
      error?: { message?: unknown } | string;
      detail?: unknown;
    };
    const message =
      typeof json.error === "string"
        ? json.error
        : (json.error?.message ?? json.detail);
    if (typeof message === "string") return message;
  } catch {}
  return text.slice(0, 500);
}

function imageUrl(file: ImageModelV4File): string {
  if (file.type === "url") return file.url;
  const data =
    typeof file.data === "string"
      ? file.data
      : Buffer.from(file.data).toString("base64");
  return `data:${file.mediaType};base64,${data}`;
}

function unsupported(kind: string): never {
  throw new Error(
    `The codex provider generates images only; use another --provider for ${kind}`
  );
}

/** Accept Gateway-style `openai/` IDs so the same -m value works across providers. */
function codexModelId(id: string): string {
  return id.startsWith("openai/") ? id.slice(7) : id;
}

export function createCodexProvider(): ModelProvider {
  const auth = createCodexAuth();
  const baseURL = process.env.CODEX_BASE_URL || CODEX_BASE_URL;
  return {
    name: "codex",
    label: "Codex (ChatGPT login)",
    languageModel: () => unsupported("text"),
    imageModel: (id) =>
      new CodexImageModel(codexModelId(id), { auth, baseURL }),
    videoModel: () => unsupported("video"),
    catalog: async () =>
      catalogFromEntries(
        [{ id: "gpt-image-2", creator: "openai", capabilities: ["image"] }],
        true
      ),
    defaults: { image: "gpt-image-2" },
    imageApiOnly: true,
  };
}
