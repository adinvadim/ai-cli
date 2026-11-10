import { execFile } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

import { createXai } from "@ai-sdk/xai";

import {
  catalogFromEntries,
  type GatewayModels,
  type ModelEntry,
} from "../models.js";
import type { ModelProvider } from "./index.js";

/** The grok.com subscription proxy; it serves xAI's /v1 routes for `grok login` sessions. */
export const GROK_PROXY_URL = "https://cli-chat-proxy.grok.com/v1";
const XAI_API_URL = "https://api.x.ai/v1";
const FALLBACK_CLIENT_VERSION = "1.0.77";
const REFRESH_SKEW_MS = 120_000;
const CATALOG_TIMEOUT_MS = 5_000;

const IMAGE_MODELS = ["grok-imagine-image", "grok-imagine-image-pro"];
const VIDEO_MODELS = ["grok-imagine-video"];

export interface GrokSession {
  token: string;
  expiresAt?: number;
}

export function grokHome(): string {
  return process.env.GROK_HOME || join(homedir(), ".grok");
}

/** Pick the freshest session token saved by `grok login`. */
export function readGrokSession(home = grokHome()): GrokSession | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(join(home, "auth.json"), "utf8"));
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object") return undefined;
  let best: GrokSession | undefined;
  for (const value of Object.values(parsed)) {
    if (!value || typeof value !== "object") continue;
    const { key, expires_at: expiresAt } = value as Record<string, unknown>;
    if (typeof key !== "string" || !key) continue;
    const expiry =
      typeof expiresAt === "string" ? Date.parse(expiresAt) : undefined;
    const session = {
      token: key,
      expiresAt: Number.isFinite(expiry) ? expiry : undefined,
    };
    if (!best || (session.expiresAt ?? Infinity) > (best.expiresAt ?? Infinity))
      best = session;
  }
  return best;
}

function isFresh(session: GrokSession | undefined, now = Date.now()) {
  return (
    session !== undefined &&
    (session.expiresAt === undefined ||
      session.expiresAt - now > REFRESH_SKEW_MS)
  );
}

function grokBinary(home = grokHome()): string {
  return process.env.GROK_BIN || join(home, "bin", "grok");
}

/** The proxy rejects chat requests without a supported client version. */
export function grokClientVersion(home = grokHome()): string {
  if (process.env.GROK_CLIENT_VERSION) return process.env.GROK_CLIENT_VERSION;
  try {
    const match = /grok-(\d+\.\d+\.\d+)/.exec(
      basename(realpathSync(grokBinary(home)))
    );
    if (match) return match[1]!;
  } catch {}
  return FALLBACK_CLIENT_VERSION;
}

/**
 * Let the Grok CLI rotate its own refresh token. Refreshing here would spend
 * the single-use refresh token and sign the Grok CLI out.
 */
function refreshGrokSession(): Promise<void> {
  return new Promise((resolve) => {
    execFile(
      grokBinary(),
      ["models"],
      { timeout: 30_000, env: { ...process.env, NO_COLOR: "1" } },
      () => resolve()
    );
  });
}

export function createGrokSessionAuth() {
  const read = () => readGrokSession();
  let pending: Promise<string> | undefined;
  let pendingRejected: string | undefined;
  async function load(rejected?: string): Promise<string> {
    let session = read();
    if (!isFresh(session) || session?.token === rejected) {
      await refreshGrokSession();
      session = read();
    }
    if (!session)
      throw new Error(
        "Not signed in to Grok. Run `grok login` (subscription) or set XAI_API_KEY."
      );
    if (!isFresh(session))
      throw new Error("Your Grok session has expired. Run `grok login`.");
    return session.token;
  }
  return {
    available: () => read() !== undefined,
    /** Pass the token the proxy rejected to renew past it; concurrent callers share one renewal. */
    token: (rejected?: string) => {
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

type GrokAuth = ReturnType<typeof createGrokSessionAuth>;

/**
 * Adds subscription proxy headers and retries once with a refreshed session on
 * 401. Only requests to the proxy origin carry the session: the SDK also uses
 * this fetch to download response image URLs, which must stay unauthenticated.
 */
export function grokSessionFetch(
  auth: GrokAuth,
  clientVersion: string,
  baseURL: string
): typeof fetch {
  const origin = new URL(baseURL).origin;
  return async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (new URL(url).origin !== origin) return globalThis.fetch(input, init);
    const send = async (token: string) => {
      const headers = new Headers(init?.headers);
      headers.set("authorization", `Bearer ${token}`);
      headers.set("x-xai-token-auth", "xai-grok-cli");
      headers.set("x-grok-client-version", clientVersion);
      const model = requestModel(init?.body);
      if (model) headers.set("x-grok-model-override", model);
      return globalThis.fetch(input, { ...init, headers });
    };
    const token = await auth.token();
    const response = await send(token);
    if (response.status !== 401) return response;
    return send(await auth.token(token));
  };
}

function requestModel(body: unknown): string | undefined {
  if (typeof body !== "string") return undefined;
  try {
    const model = (JSON.parse(body) as { model?: unknown }).model;
    return typeof model === "string" ? model : undefined;
  } catch {
    return undefined;
  }
}

/** Accept Gateway-style `xai/` IDs so the same -m value works across providers. */
function grokModelId(id: string): string {
  return id.startsWith("xai/") ? id.slice(4) : id;
}

let cachedCatalog: Promise<GatewayModels> | undefined;

export function createGrokProvider(): ModelProvider {
  const auth = createGrokSessionAuth();
  const useSession = auth.available() || !process.env.XAI_API_KEY;
  const baseURL = useSession
    ? process.env.GROK_PROXY_BASE_URL || GROK_PROXY_URL
    : process.env.XAI_BASE_URL || XAI_API_URL;
  const xai = useSession
    ? createXai({
        baseURL,
        // grokSessionFetch replaces Authorization with the live session token
        // per request; the SDK only requires a non-empty key here.
        apiKey: "grok-session",
        fetch: grokSessionFetch(auth, grokClientVersion(), baseURL),
      })
    : createXai({ baseURL, apiKey: process.env.XAI_API_KEY });
  return {
    name: "grok",
    label: useSession ? "Grok (grok.com subscription)" : "xAI API",
    languageModel: (id) => xai.responses(grokModelId(id)),
    imageModel: (id) => xai.image(grokModelId(id)),
    videoModel: (id) => xai.video(grokModelId(id)),
    catalog: () =>
      (cachedCatalog ??= fetchGrokCatalog(baseURL, (input, init) =>
        useSession
          ? grokSessionFetch(auth, grokClientVersion(), baseURL)(input, init)
          : fetch(input, {
              ...init,
              headers: { authorization: `Bearer ${process.env.XAI_API_KEY}` },
            })
      )),
    defaults: {
      text: "grok-4.7",
      image: "grok-imagine-image",
      video: "grok-imagine-video",
    },
    imageApiOnly: true,
  };
}

async function fetchGrokCatalog(
  baseURL: string,
  request: typeof fetch
): Promise<GatewayModels> {
  const entry = (id: string, capability: "text" | "image" | "video") =>
    ({ id, creator: "xai", capabilities: [capability] }) satisfies ModelEntry;
  const media = [
    ...IMAGE_MODELS.map((id) => entry(id, "image")),
    ...VIDEO_MODELS.map((id) => entry(id, "video")),
  ];
  try {
    const res = await request(`${baseURL}/models`, {
      signal: AbortSignal.timeout(CATALOG_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = (await res.json()) as { data?: Array<{ id?: unknown }> };
    const text = (json.data ?? [])
      .map((m) => m.id)
      .filter((id): id is string => typeof id === "string")
      // api.x.ai lists media models here too; keep the static media entries.
      .filter((id) => !id.includes("imagine"))
      .map((id) => entry(id, "text"));
    return catalogFromEntries([...text, ...media], true);
  } catch (error) {
    cachedCatalog = undefined;
    process.stderr.write(
      `Warning: could not fetch Grok models (${error instanceof Error ? error.message : String(error)})\n`
    );
    // Media models are fixed, so image and video still resolve.
    return catalogFromEntries(media, true);
  }
}
