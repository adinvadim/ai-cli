import { afterEach, describe, expect, mock, test } from "bun:test";

import {
  fetchModels,
  resolveModels,
  fetchGatewayModels,
  resetModelsCache,
} from "./models.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  resetModelsCache();
});

function mockGateway(models: Record<string, unknown>[]) {
  globalThis.fetch = mock(() =>
    Promise.resolve(
      new Response(JSON.stringify({ data: models }), { status: 200 })
    )
  ) as unknown as typeof fetch;
}

function mockGatewayError() {
  globalThis.fetch = mock(() =>
    Promise.reject(new Error("network error"))
  ) as unknown as typeof fetch;
}

describe("resolveModels", () => {
  test("returns default when no user model", () => {
    expect(resolveModels("text")[0]).toContain("/");
    expect(resolveModels("image")[0]).toContain("/");
    expect(resolveModels("video")[0]).toContain("/");
  });

  test("returns fully-qualified model as-is", () => {
    expect(resolveModels("text", "openai/gpt-4")).toEqual(["openai/gpt-4"]);
    expect(resolveModels("image", "openai/gpt-image-1")).toEqual([
      "openai/gpt-image-1",
    ]);
  });

  test("expands short names when knownModels provided", () => {
    const known = [{ id: "openai/gpt-image-1" }, { id: "bfl/flux-2-pro" }];
    expect(resolveModels("image", "gpt-image-1", known)).toEqual([
      "openai/gpt-image-1",
    ]);
    expect(resolveModels("image", "flux-2-pro", known)).toEqual([
      "bfl/flux-2-pro",
    ]);
  });

  test("returns unknown short names as-is when no knownModels", () => {
    expect(resolveModels("text", "my-model")).toEqual(["my-model"]);
  });

  test("returns unknown short names as-is when not in knownModels", () => {
    const known = [{ id: "openai/gpt-5" }];
    expect(resolveModels("text", "nonexistent", known)).toEqual([
      "nonexistent",
    ]);
  });

  test("uses OpenRouter defaults for OpenRouter provider", () => {
    const prev = {
      text: process.env.AI_CLI_TEXT_MODEL,
      image: process.env.AI_CLI_IMAGE_MODEL,
      video: process.env.AI_CLI_VIDEO_MODEL,
    };
    try {
      delete process.env.AI_CLI_TEXT_MODEL;
      delete process.env.AI_CLI_IMAGE_MODEL;
      delete process.env.AI_CLI_VIDEO_MODEL;
      expect(resolveModels("text", undefined, undefined, "openrouter")).toEqual([
        "openai/gpt-5-mini",
      ]);
      expect(resolveModels("image", undefined, undefined, "openrouter")).toEqual([
        "openai/gpt-5-image-mini",
      ]);
      expect(resolveModels("video", undefined, undefined, "openrouter")).toEqual([
        "bytedance/seedance-2.0",
      ]);
    } finally {
      if (prev.text === undefined) delete process.env.AI_CLI_TEXT_MODEL;
      else process.env.AI_CLI_TEXT_MODEL = prev.text;
      if (prev.image === undefined) delete process.env.AI_CLI_IMAGE_MODEL;
      else process.env.AI_CLI_IMAGE_MODEL = prev.image;
      if (prev.video === undefined) delete process.env.AI_CLI_VIDEO_MODEL;
      else process.env.AI_CLI_VIDEO_MODEL = prev.video;
    }
  });
});

describe("resolveModels multi", () => {
  test("returns default when no user model", () => {
    const result = resolveModels("text");
    expect(result).toHaveLength(1);
    expect(result[0]).toContain("/");
  });

  test("splits comma-separated models", () => {
    const result = resolveModels("image", "openai/gpt-image-1,bfl/flux-2-pro");
    expect(result).toEqual(["openai/gpt-image-1", "bfl/flux-2-pro"]);
  });

  test("trims whitespace around model names", () => {
    const result = resolveModels(
      "image",
      "openai/gpt-image-1 , bfl/flux-2-pro"
    );
    expect(result).toEqual(["openai/gpt-image-1", "bfl/flux-2-pro"]);
  });

  test("expands short names in comma list", () => {
    const known = [{ id: "openai/gpt-image-1" }, { id: "bfl/flux-2-pro" }];
    const result = resolveModels("image", "gpt-image-1,flux-2-pro", known);
    expect(result).toEqual(["openai/gpt-image-1", "bfl/flux-2-pro"]);
  });

  test("filters empty segments from trailing comma", () => {
    const result = resolveModels("image", "openai/gpt-image-1,");
    expect(result).toEqual(["openai/gpt-image-1"]);
  });

  test("falls back to default when all segments are empty", () => {
    const result = resolveModels("image", ",,,");
    expect(result).toHaveLength(1);
    expect(result[0]).toContain("/");
  });
});

describe("fetchGatewayModels", () => {
  test("partitions models by type with enriched fields", async () => {
    mockGateway([
      {
        id: "openai/gpt-5",
        name: "GPT 5",
        owned_by: "openai",
        type: "language",
        tags: [],
        pricing: { input: "0.000003", output: "0.000015" },
      },
      {
        id: "openai/gpt-image-2",
        name: "GPT Image 2",
        description: "Image gen",
        owned_by: "openai",
        type: "image",
        tags: ["image-generation"],
        pricing: { image: "0.02" },
      },
      {
        id: "google/veo-3.0",
        name: "Veo 3",
        owned_by: "google",
        type: "video",
        tags: [],
      },
      {
        id: "openai/text-embedding-3",
        name: "Embedding",
        owned_by: "openai",
        type: "embedding",
        tags: [],
      },
    ]);

    const result = await fetchGatewayModels();

    expect(result.text).toHaveLength(1);
    expect(result.text[0].id).toBe("openai/gpt-5");
    expect(result.text[0].creator).toBe("openai");
    expect(result.text[0].capabilities).toEqual(["text"]);
    expect(result.text[0].pricing).toEqual({
      input: "0.000003",
      output: "0.000015",
    });

    expect(result.image).toHaveLength(1);
    expect(result.image[0].id).toBe("openai/gpt-image-2");
    expect(result.image[0].creator).toBe("openai");
    expect(result.image[0].capabilities).toEqual(["image"]);
    expect(result.image[0].description).toBe("Image gen");
    expect(result.image[0].pricing).toEqual({ image: "0.02" });

    expect(result.video).toHaveLength(1);
    expect(result.video[0].id).toBe("google/veo-3.0");
    expect(result.video[0].creator).toBe("google");
    expect(result.video[0].capabilities).toEqual(["video"]);

    // embedding type is excluded
    expect(result.all).toHaveLength(3);
  });

  test("language models with image-generation tag appear in both text and image", async () => {
    mockGateway([
      {
        id: "google/gemini-2.5-flash-image",
        name: "Gemini Flash Image",
        owned_by: "google",
        type: "language",
        tags: ["image-generation"],
      },
      {
        id: "openai/gpt-image-2",
        name: "GPT Image 2",
        owned_by: "openai",
        type: "image",
        tags: ["image-generation"],
      },
    ]);

    const result = await fetchGatewayModels();

    expect(result.text.map((m) => m.id)).toContain(
      "google/gemini-2.5-flash-image"
    );
    expect(result.image.map((m) => m.id)).toContain(
      "google/gemini-2.5-flash-image"
    );
    expect(result.image.map((m) => m.id)).toContain("openai/gpt-image-2");

    const gemini = result.all.find(
      (m) => m.id === "google/gemini-2.5-flash-image"
    )!;
    expect(gemini.capabilities).toEqual(["text", "image"]);

    expect(
      result.languageImageModelIds.has("google/gemini-2.5-flash-image")
    ).toBe(true);
    expect(result.languageImageModelIds.has("openai/gpt-image-2")).toBe(false);
  });

  test("language models without image-generation tag stay in text only", async () => {
    mockGateway([
      {
        id: "openai/gpt-5",
        name: "GPT 5",
        owned_by: "openai",
        type: "language",
        tags: ["tool-use"],
      },
    ]);

    const result = await fetchGatewayModels();

    expect(result.text).toHaveLength(1);
    expect(result.image).toHaveLength(0);
    expect(result.languageImageModelIds.size).toBe(0);
    expect(result.all[0].capabilities).toEqual(["text"]);
  });

  test("returns empty lists on gateway error", async () => {
    mockGatewayError();

    const result = await fetchGatewayModels();

    expect(result.text).toHaveLength(0);
    expect(result.image).toHaveLength(0);
    expect(result.video).toHaveLength(0);
    expect(result.all).toHaveLength(0);
    expect(result.languageImageModelIds.size).toBe(0);
  });

  test("returns empty lists on non-200 response", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response("Not Found", { status: 404 }))
    ) as unknown as typeof fetch;

    const result = await fetchGatewayModels();

    expect(result.text).toHaveLength(0);
    expect(result.image).toHaveLength(0);
    expect(result.video).toHaveLength(0);
    expect(result.all).toHaveLength(0);
  });

  test("caches result across multiple calls", async () => {
    const fetchMock = mock(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            data: [
              {
                id: "openai/gpt-5",
                name: "GPT 5",
                owned_by: "openai",
                type: "language",
                tags: [],
              },
            ],
          }),
          { status: 200 }
        )
      )
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const r1 = await fetchGatewayModels();
    const r2 = await fetchGatewayModels();

    expect(r1).toBe(r2);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("pricing is omitted when all pricing fields are empty", async () => {
    mockGateway([
      {
        id: "openai/gpt-5",
        name: "GPT 5",
        owned_by: "openai",
        type: "language",
        tags: [],
        pricing: {},
      },
    ]);

    const result = await fetchGatewayModels();
    expect(result.text[0].pricing).toBeUndefined();
  });

  test("falls back to parsing creator from id when owned_by is absent", async () => {
    mockGateway([
      {
        id: "openai/gpt-5",
        name: "GPT 5",
        type: "language",
        tags: [],
      },
    ]);

    const result = await fetchGatewayModels();
    expect(result.text[0].creator).toBe("openai");
  });
});

describe("fetchModels openrouter", () => {
  function mockOpenRouterCatalogs(opts: {
    models?: Record<string, unknown>[];
    images?: Record<string, unknown>[];
    videos?: Record<string, unknown>[];
  }) {
    globalThis.fetch = mock((input: RequestInfo | URL) => {
      const url = String(input);
      let data: Record<string, unknown>[] = [];
      if (url.includes("/images/models")) data = opts.images ?? [];
      else if (url.includes("/videos/models")) data = opts.videos ?? [];
      else data = opts.models ?? [];
      return Promise.resolve(
        new Response(JSON.stringify({ data }), { status: 200 })
      );
    }) as unknown as typeof fetch;
  }

  test("merges general, image, and video OpenRouter catalogs", async () => {
    mockOpenRouterCatalogs({
      models: [
        {
          id: "openai/gpt-5",
          name: "GPT 5",
          description: "Text model",
          architecture: { output_modalities: ["text"] },
          pricing: { prompt: "0.000001", completion: "0.00001" },
        },
        {
          id: "google/gemini-flash-image",
          name: "Gemini Flash Image",
          architecture: { output_modalities: ["text", "image"] },
          pricing: { image: "0.03" },
        },
        {
          id: "vendor/embedding",
          architecture: { output_modalities: ["embedding"] },
        },
      ],
      images: [
        {
          id: "openai/gpt-image-1",
          name: "GPT Image 1",
          architecture: { output_modalities: ["image"] },
        },
        {
          id: "google/gemini-flash-image",
          architecture: { output_modalities: ["image"] },
        },
      ],
      videos: [
        {
          id: "bytedance/seedance-2.0",
          name: "Seedance 2.0",
        },
      ],
    });

    const result = await fetchModels("openrouter");

    expect(result.text.map((m) => m.id)).toEqual([
      "openai/gpt-5",
      "google/gemini-flash-image",
    ]);
    expect(result.image.map((m) => m.id).sort()).toEqual([
      "google/gemini-flash-image",
      "openai/gpt-image-1",
    ]);
    expect(result.video.map((m) => m.id)).toEqual(["bytedance/seedance-2.0"]);
    expect(result.all).toHaveLength(4);

    expect(result.text[0].creator).toBe("openai");
    expect(result.text[0].pricing).toEqual({
      input: "0.000001",
      output: "0.00001",
    });
    // Dedicated imageModel path — do not route via generateText language-image.
    expect(result.languageImageModelIds.size).toBe(0);
  });

  test("returns empty lists when all OpenRouter catalogs fail", async () => {
    mockGatewayError();

    const result = await fetchModels("openrouter");

    expect(result.text).toHaveLength(0);
    expect(result.image).toHaveLength(0);
    expect(result.video).toHaveLength(0);
    expect(result.all).toHaveLength(0);
  });
});
