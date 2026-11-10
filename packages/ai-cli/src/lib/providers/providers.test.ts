import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { APICallError, type ImageModelV4CallOptions } from "@ai-sdk/provider";
import { afterEach, describe, expect, test, vi } from "vitest";

import { defaultModel } from "../models.js";
import { CodexImageModel, createCodexAuth } from "./codex.js";
import {
  createGrokSessionAuth,
  grokSessionFetch,
  readGrokSession,
} from "./grok.js";
import { assertGatewayOnlyOptions, resolveProviderName } from "./index.js";
import {
  createOpenRouterProvider,
  resetOpenRouterCatalog,
} from "./openrouter.js";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function jwt(expiresInMs: number): string {
  const payload = Buffer.from(
    JSON.stringify({ exp: Math.floor((Date.now() + expiresInMs) / 1000) })
  ).toString("base64url");
  return `header.${payload}.signature`;
}

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "ai-cli-provider-"));
}

function stubFetch(
  respond: (url: string, init?: RequestInit) => Response | Promise<Response>
) {
  const calls: Array<{ url: string; init?: RequestInit; headers: Headers }> =
    [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      calls.push({ url, init, headers: new Headers(init?.headers) });
      return respond(url, init);
    })
  );
  return calls;
}

describe("provider selection", () => {
  test("defaults to AI Gateway", () => {
    expect(resolveProviderName()).toBe("gateway");
  });

  test("an explicit provider beats AI_CLI_PROVIDER", () => {
    vi.stubEnv("AI_CLI_PROVIDER", "openrouter");
    expect(resolveProviderName()).toBe("openrouter");
    expect(resolveProviderName("grok")).toBe("grok");
  });

  test("selects OpenRouter only when it is the sole configured key", () => {
    vi.stubEnv("OPENROUTER_API_KEY", "or-test");
    expect(resolveProviderName()).toBe("openrouter");
    vi.stubEnv("AI_GATEWAY_API_KEY", "gw-test");
    expect(resolveProviderName()).toBe("gateway");
  });

  test("rejects unknown providers", () => {
    expect(() => resolveProviderName("nope")).toThrow(
      "--provider must be one of: gateway, openrouter, codex, grok"
    );
  });

  test("rejects Gateway-only connection flags for other providers", () => {
    expect(() =>
      assertGatewayOnlyOptions("grok", { baseUrl: "https://example.com" })
    ).toThrow("--base-url applies to AI Gateway only");
    expect(() =>
      assertGatewayOnlyOptions("gateway", { scope: "team" })
    ).not.toThrow();
  });

  test("AI_CLI_*_MODEL overrides the AI Gateway default", () => {
    expect(defaultModel("image")).toBe("openai/gpt-image-2");
    vi.stubEnv("AI_CLI_IMAGE_MODEL", "openai/gpt-5-image");
    expect(defaultModel("image")).toBe("openai/gpt-5-image");
  });
});

describe("Grok session", () => {
  const PROXY = "https://proxy.test/v1";

  /** A Grok home whose fake `grok` binary renews auth.json like the real CLI. */
  function grokHome(options: { expiresInMs: number; renews: boolean }) {
    const home = tempDir();
    mkdirSync(join(home, "bin"));
    const write = (path: string, token: string, expiresInMs: number) =>
      writeFileSync(
        path,
        JSON.stringify({
          "https://auth.x.ai::client": {
            key: token,
            expires_at: new Date(Date.now() + expiresInMs).toISOString(),
          },
        })
      );
    write(join(home, "auth.json"), "first", options.expiresInMs);
    write(join(home, "renewed.json"), "renewed", 3_600_000);
    const grok = join(home, "bin", "grok");
    writeFileSync(
      grok,
      `#!/bin/sh\necho "$@" >> "${home}/calls"\n${
        options.renews ? `cp "${home}/renewed.json" "${home}/auth.json"\n` : ""
      }`
    );
    chmodSync(grok, 0o755);
    vi.stubEnv("GROK_HOME", home);
    const calls = () => {
      try {
        return readFileSync(join(home, "calls"), "utf8").trim().split("\n");
      } catch {
        return [];
      }
    };
    return { home, calls };
  }

  test("reads the freshest `grok login` session", () => {
    const home = tempDir();
    const later = new Date(Date.now() + 3_600_000).toISOString();
    writeFileSync(
      join(home, "auth.json"),
      JSON.stringify({
        old: { key: "old-token", expires_at: new Date().toISOString() },
        current: { key: "new-token", expires_at: later },
        broken: { auth_mode: "oidc" },
      })
    );
    expect(readGrokSession(home)).toEqual({
      token: "new-token",
      expiresAt: Date.parse(later),
    });
    expect(readGrokSession(tempDir())).toBeUndefined();
  });

  test("lets the Grok CLI renew a stale session instead of spending its refresh token", async () => {
    const { calls } = grokHome({ expiresInMs: 1_000, renews: true });
    const auth = createGrokSessionAuth();
    await expect(auth.token()).resolves.toBe("renewed");
    expect(calls()).toEqual(["models"]);
    // A fresh session is reused without running the Grok CLI again.
    await expect(auth.token()).resolves.toBe("renewed");
    expect(calls()).toEqual(["models"]);
  });

  test("asks for `grok login` when the Grok CLI cannot renew the session", async () => {
    grokHome({ expiresInMs: -1_000, renews: false });
    await expect(createGrokSessionAuth().token()).rejects.toThrow(
      "Your Grok session has expired. Run `grok login`."
    );
    vi.stubEnv("GROK_HOME", tempDir());
    await expect(createGrokSessionAuth().token()).rejects.toThrow(
      "Run `grok login`"
    );
  });

  test("sends subscription proxy headers and renews the session after 401", async () => {
    const { calls } = grokHome({ expiresInMs: 3_600_000, renews: true });
    const requests = stubFetch(
      () => new Response("{}", { status: requests.length === 1 ? 401 : 200 })
    );
    const request = grokSessionFetch(createGrokSessionAuth(), "9.9.9", PROXY);
    const response = await request(`${PROXY}/responses`, {
      method: "POST",
      headers: { authorization: "Bearer grok-session" },
      body: JSON.stringify({ model: "grok-4.7" }),
    });
    expect(response.status).toBe(200);
    expect(calls()).toEqual(["models"]);
    expect(requests.map((r) => r.headers.get("authorization"))).toEqual([
      "Bearer first",
      "Bearer renewed",
    ]);
    expect(requests[1]!.headers.get("x-xai-token-auth")).toBe("xai-grok-cli");
    expect(requests[1]!.headers.get("x-grok-client-version")).toBe("9.9.9");
    expect(requests[1]!.headers.get("x-grok-model-override")).toBe("grok-4.7");
  });

  test("never sends the session to other origins, such as image URLs", async () => {
    grokHome({ expiresInMs: 3_600_000, renews: true });
    const requests = stubFetch(() => new Response("image"));
    const request = grokSessionFetch(createGrokSessionAuth(), "9.9.9", PROXY);
    await request("https://imgen.x.ai/output/image.jpg", { method: "GET" });
    expect(requests).toHaveLength(1);
    expect(requests[0]!.headers.get("authorization")).toBeNull();
    expect(requests[0]!.headers.get("x-xai-token-auth")).toBeNull();
  });
});

describe("Codex login", () => {
  function codexHome(accessToken: string) {
    const home = tempDir();
    writeFileSync(
      join(home, "auth.json"),
      JSON.stringify({
        auth_mode: "chatgpt",
        OPENAI_API_KEY: null,
        tokens: {
          id_token: "id-old",
          access_token: accessToken,
          refresh_token: "refresh-old",
          account_id: "account-1",
        },
        last_refresh: "2026-01-01T00:00:00Z",
      })
    );
    vi.stubEnv("CODEX_HOME", home);
    return home;
  }

  test("uses a fresh `codex login` token without refreshing", async () => {
    const token = jwt(86_400_000);
    codexHome(token);
    const requests = stubFetch(() => new Response("", { status: 500 }));
    await expect(createCodexAuth().credentials()).resolves.toEqual({
      accessToken: token,
      accountId: "account-1",
    });
    expect(requests).toHaveLength(0);
  });

  test("refreshes like Codex and writes the rotated tokens back", async () => {
    const home = codexHome(jwt(60_000));
    const fresh = jwt(86_400_000);
    const requests = stubFetch(() =>
      Response.json({ access_token: fresh, refresh_token: "refresh-new" })
    );
    await expect(createCodexAuth().credentials()).resolves.toEqual({
      accessToken: fresh,
      accountId: "account-1",
    });
    expect(requests[0]!.url).toBe("https://auth.openai.com/oauth/token");
    expect(JSON.parse(String(requests[0]!.init?.body))).toEqual({
      client_id: "app_EMoamEEZ73f0CkXaXp7hrann",
      grant_type: "refresh_token",
      refresh_token: "refresh-old",
    });
    const saved = JSON.parse(readFileSync(join(home, "auth.json"), "utf8"));
    expect(saved.auth_mode).toBe("chatgpt");
    expect(saved.tokens).toEqual({
      id_token: "id-old",
      access_token: fresh,
      refresh_token: "refresh-new",
      account_id: "account-1",
    });
    expect(saved.last_refresh).not.toBe("2026-01-01T00:00:00Z");
    expect(statSync(join(home, "auth.json")).mode & 0o777).toBe(0o600);
  });

  test("refreshes past a rejected token even before it expires", async () => {
    const rejected = jwt(86_400_000);
    codexHome(rejected);
    const fresh = jwt(86_400_000 + 60_000);
    const requests = stubFetch(() => Response.json({ access_token: fresh }));
    await expect(createCodexAuth().credentials(rejected)).resolves.toEqual({
      accessToken: fresh,
      accountId: "account-1",
    });
    expect(requests).toHaveLength(1);
  });

  test("concurrent 401s for the same token share one refresh", async () => {
    const rejected = jwt(86_400_000);
    codexHome(rejected);
    const fresh = jwt(86_400_000 + 60_000);
    const requests = stubFetch(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return Response.json({ access_token: fresh, refresh_token: "next" });
    });
    const auth = createCodexAuth();
    const results = await Promise.all([
      auth.credentials(rejected),
      auth.credentials(rejected),
    ]);
    expect(results.map((r) => r.accessToken)).toEqual([fresh, fresh]);
    expect(requests).toHaveLength(1);
  });

  test("adopts tokens another process rotated when its refresh wins", async () => {
    const home = codexHome(jwt(-60_000));
    const sibling = jwt(86_400_000);
    stubFetch(() => {
      // The sibling spent the refresh token first and saved its result.
      writeFileSync(
        join(home, "auth.json"),
        JSON.stringify({
          tokens: {
            access_token: sibling,
            refresh_token: "sibling-refresh",
            account_id: "account-1",
          },
        })
      );
      return Response.json({ error: "refresh_token_reused" }, { status: 401 });
    });
    await expect(createCodexAuth().credentials()).resolves.toEqual({
      accessToken: sibling,
      accountId: "account-1",
    });
  });

  test("reports an expired login instead of retrying forever", async () => {
    codexHome(jwt(-60_000));
    stubFetch(() =>
      Response.json({ error: "refresh_token_reused" }, { status: 401 })
    );
    await expect(createCodexAuth().credentials()).rejects.toThrow(
      "Could not refresh your Codex login (HTTP 401). Run `codex login`."
    );
    vi.stubEnv("CODEX_HOME", tempDir());
    await expect(createCodexAuth().credentials()).rejects.toThrow(
      "Not signed in to Codex"
    );
  });
});

describe("Codex image model", () => {
  const options = (
    overrides: Partial<ImageModelV4CallOptions> = {}
  ): ImageModelV4CallOptions => ({
    prompt: "a fox",
    n: 1,
    size: undefined,
    aspectRatio: undefined,
    seed: undefined,
    files: undefined,
    mask: undefined,
    providerOptions: {},
    ...overrides,
  });

  function model(responses: Response[]) {
    const requests = stubFetch(() => responses.shift()!);
    const credentials = vi.fn(async (rejected?: string) => ({
      accessToken: rejected ? "renewed" : "token",
      accountId: "account-1",
    }));
    const instance = new CodexImageModel("gpt-image-2", {
      auth: { credentials },
      baseURL: "https://chatgpt.test/codex",
    });
    const bodies = () =>
      requests.map((r) => JSON.parse(String(r.init?.body)) as object);
    return { instance, requests, bodies, credentials };
  }

  test("generates with Codex headers and lets Codex pick the size", async () => {
    const { instance, requests, bodies } = model([
      Response.json({ data: [{ b64_json: "aW1n" }] }),
    ]);
    const result = await instance.doGenerate(
      options({
        aspectRatio: "16:9",
        seed: 1,
        providerOptions: { codex: { quality: "high" } },
      })
    );
    expect(result.images).toEqual(["aW1n"]);
    expect(result.warnings.map((w) => "feature" in w && w.feature)).toEqual([
      "seed",
      "aspectRatio",
    ]);
    expect(requests[0]!.url).toBe(
      "https://chatgpt.test/codex/images/generations"
    );
    expect(bodies()[0]).toEqual({
      quality: "high",
      prompt: "a fox",
      model: "gpt-image-2",
      n: 1,
      size: "auto",
    });
    expect(requests[0]!.headers.get("authorization")).toBe("Bearer token");
    expect(requests[0]!.headers.get("chatgpt-account-id")).toBe("account-1");
    expect(requests[0]!.headers.get("originator")).toBe("codex_cli_rs");
  });

  test("edits with reference images as data URLs", async () => {
    const { instance, requests, bodies } = model([
      Response.json({ data: [{ b64_json: "aW1n" }] }),
    ]);
    await instance.doGenerate(
      options({
        files: [
          {
            type: "file",
            mediaType: "image/png",
            data: new Uint8Array([1, 2]),
          },
          { type: "url", url: "https://example.com/ref.png" },
        ],
      })
    );
    expect(requests[0]!.url).toBe("https://chatgpt.test/codex/images/edits");
    expect(bodies()[0]).toMatchObject({
      size: "auto",
      images: [
        { image_url: "data:image/png;base64,AQI=" },
        { image_url: "https://example.com/ref.png" },
      ],
    });
  });

  test("retries a 401 once with the rejected token marked for refresh", async () => {
    const { instance, requests, credentials } = model([
      new Response("", { status: 401 }),
      Response.json({ data: [{ b64_json: "aW1n" }] }),
    ]);
    await instance.doGenerate(options());
    expect(credentials).toHaveBeenLastCalledWith("token");
    expect(requests[1]!.headers.get("authorization")).toBe("Bearer renewed");
  });

  test("raises API errors the SDK can retry, without image data", async () => {
    const limited = model([
      Response.json(
        { error: { message: "Rate limit reached" } },
        { status: 429 }
      ),
    ]);
    const error = await limited.instance
      .doGenerate(options())
      .catch((caught: unknown) => caught);
    expect(APICallError.isInstance(error)).toBe(true);
    expect(error).toMatchObject({
      message: "Codex image request failed (HTTP 429): Rate limit reached",
      statusCode: 429,
      isRetryable: true,
      requestBodyValues: {
        model: "gpt-image-2",
        endpoint: "/images/generations",
      },
    });

    const rejected = model([
      Response.json({ error: { message: "Rejected" } }, { status: 400 }),
    ]);
    await expect(rejected.instance.doGenerate(options())).rejects.toMatchObject(
      { statusCode: 400, isRetryable: false }
    );
  });

  test("rejects unsupported inputs before sending a request", async () => {
    const { instance, requests } = model([]);
    await expect(
      instance.doGenerate(
        options({
          mask: { type: "url", url: "https://example.com/mask.png" },
        })
      )
    ).rejects.toThrow("does not support --mask");
    expect(requests).toHaveLength(0);
  });
});

describe("OpenRouter catalog", () => {
  afterEach(() => resetOpenRouterCatalog());

  test("merges the chat, image and video catalogs per model", async () => {
    const lists: Record<string, unknown[]> = {
      "/models": [
        {
          id: "openai/gpt-5-mini",
          name: "GPT-5 Mini",
          context_length: 400000,
          architecture: { output_modalities: ["text"] },
          pricing: { prompt: "0.00000025", completion: "0.000002" },
        },
        {
          id: "google/gemini-image",
          architecture: { output_modalities: ["text", "image"] },
        },
        {
          id: "embed/only",
          architecture: { output_modalities: ["embeddings"] },
        },
      ],
      "/images/models": [
        { id: "google/gemini-image", pricing: { image: "0.04" } },
        { id: "openai/gpt-5-image-mini" },
      ],
      "/videos/models": [{ id: "bytedance/seedance-2.0" }],
    };
    stubFetch((url) =>
      Response.json({
        data: lists[new URL(url).pathname.replace("/api/v1", "")],
      })
    );
    const catalog = await createOpenRouterProvider({}).catalog();
    expect(catalog.available).toBe(true);
    expect(catalog.text.map((m) => m.id)).toEqual([
      "openai/gpt-5-mini",
      "google/gemini-image",
    ]);
    expect(catalog.image.map((m) => m.id)).toEqual([
      "google/gemini-image",
      "openai/gpt-5-image-mini",
    ]);
    expect(catalog.video.map((m) => m.id)).toEqual(["bytedance/seedance-2.0"]);
    expect(
      catalog.lookup.find((m) => m.id === "google/gemini-image")
    ).toMatchObject({
      creator: "google",
      capabilities: ["text", "image"],
      pricing: { image: "0.04" },
    });
    expect(catalog.text[0]).toMatchObject({
      contextWindow: 400000,
      pricing: { input: "0.00000025", output: "0.000002" },
    });
  });

  test("reports an unavailable catalog when every list fails", async () => {
    stubFetch(() => new Response("", { status: 503 }));
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const catalog = await createOpenRouterProvider({}).catalog();
    expect(catalog.available).toBe(false);
    expect(catalog.all).toEqual([]);
    expect(stderr).toHaveBeenCalledWith(
      "Warning: could not fetch models from OpenRouter\n"
    );
    stderr.mockRestore();
  });
});
