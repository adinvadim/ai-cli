import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import { mediaFixture, png } from "../test/media.js";

// Exercise the real CLI and SDK adapters for Codex and Grok without network.
const fixture = mediaFixture();

const codexHome = join(fixture.directory, "codex-home");
mkdirSync(codexHome, { recursive: true });
const exp = Math.floor(Date.now() / 1000) + 86_400;
writeFileSync(
  join(codexHome, "auth.json"),
  JSON.stringify({
    auth_mode: "chatgpt",
    tokens: {
      access_token: `h.${Buffer.from(JSON.stringify({ exp })).toString("base64url")}.s`,
      refresh_token: "refresh",
      account_id: "account-1",
    },
  })
);

const grokHome = join(fixture.directory, "grok-home");
mkdirSync(grokHome, { recursive: true });
writeFileSync(
  join(grokHome, "auth.json"),
  JSON.stringify({
    "https://auth.x.ai::client": {
      key: "grok-session-token",
      expires_at: new Date(Date.now() + 86_400_000).toISOString(),
    },
  })
);

const env = {
  CODEX_HOME: codexHome,
  GROK_HOME: grokHome,
  GROK_CLIENT_VERSION: "1.2.3",
};

describe("codex provider", () => {
  test("generates images with the local `codex login`", async () => {
    const result = await fixture.run(
      [
        "image",
        "a fox",
        "--provider",
        "codex",
        "--json",
        "--quiet",
        "--no-preview",
      ],
      { env }
    );
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    const output = JSON.parse(result.stdout).results[0];
    expect(output.model).toBe("gpt-image-2");
    expect(readFileSync(output.images[0].file)).toEqual(png);
    const request = result.requests.find((r) =>
      r.url.startsWith("https://chatgpt.com/backend-api/codex/")
    );
    expect(request.route).toBe("/backend-api/codex/images/generations");
    expect(request.body).toEqual({
      prompt: "a fox",
      model: "gpt-image-2",
      n: 1,
      size: "auto",
    });
    expect(request.headers["chatgpt-account-id"]).toBe("account-1");
    expect(request.headers.authorization).toMatch(/^Bearer h\./);
  });

  test("keeps its own default when AI_CLI_* configure another provider", async () => {
    const result = await fixture.run(
      [
        "image",
        "a fox",
        "--provider",
        "codex",
        "--json",
        "--quiet",
        "--no-preview",
      ],
      {
        env: {
          ...env,
          AI_CLI_PROVIDER: "openrouter",
          AI_CLI_IMAGE_MODEL: "openai/gpt-5-image",
        },
      }
    );
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).results[0].model).toBe("gpt-image-2");
  });

  test("splits --n into one request per image, the Codex per-call limit", async () => {
    const result = await fixture.run(
      [
        "image",
        "a fox",
        "--provider",
        "codex",
        "-n",
        "2",
        "--json",
        "--quiet",
        "--no-preview",
      ],
      { env }
    );
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).results[0].images).toHaveLength(2);
    const calls = result.requests.filter((r) =>
      r.route.endsWith("/images/generations")
    );
    expect(calls.map((r) => r.body.n)).toEqual([1, 1]);
  });

  test("explains that Codex does not generate video", async () => {
    const result = await fixture.run(
      ["video", "a fox", "--provider", "codex", "--quiet", "--no-preview"],
      { env }
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("The codex provider generates images only");
  });
});

describe("grok provider", () => {
  test("generates images through the grok.com subscription proxy", async () => {
    const result = await fixture.run(
      [
        "image",
        "a fox",
        "--provider",
        "grok",
        "--json",
        "--quiet",
        "--no-preview",
      ],
      { env }
    );
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).results[0].model).toBe(
      "grok-imagine-image"
    );
    const request = result.requests.find((r) =>
      r.route.endsWith("/images/generations")
    );
    expect(request.url).toBe(
      "https://cli-chat-proxy.grok.com/v1/images/generations"
    );
    expect(request.body.model).toBe("grok-imagine-image");
    expect(request.headers.authorization).toBe("Bearer grok-session-token");
    expect(request.headers["x-xai-token-auth"]).toBe("xai-grok-cli");
    expect(request.headers["x-grok-client-version"]).toBe("1.2.3");
  });

  test("starts a video and checks it with the recorded provider", async () => {
    const operation = join(fixture.directory, "grok-operation.json");
    const started = await fixture.run(
      [
        "video",
        "start",
        "a fox",
        "--provider",
        "grok",
        "--duration",
        "1",
        "-o",
        operation,
        "--quiet",
      ],
      { env }
    );
    expect(started.stderr).toBe("");
    expect(started.exitCode).toBe(0);
    const saved = JSON.parse(readFileSync(operation, "utf8"));
    expect(saved).toMatchObject({
      model: "grok-imagine-video",
      provider: "grok",
    });
    expect(
      started.requests.find((r) => r.route.endsWith("/videos/generations")).body
    ).toMatchObject({
      model: "grok-imagine-video",
      prompt: "a fox",
      duration: 1,
    });

    // No --provider: status reads it from the operation file.
    const status = await fixture.run(
      [
        "video",
        "status",
        operation,
        "--download",
        "-o",
        join(fixture.directory, "grok-video/"),
        "--quiet",
      ],
      { env }
    );
    expect(status.stderr).toBe("");
    expect(status.exitCode).toBe(0);
    expect(
      status.requests.some(
        (r) => r.url === "https://cli-chat-proxy.grok.com/v1/videos/grok-job"
      )
    ).toBe(true);
  });

  test("splits video --n into one job per video, the xAI per-call limit", async () => {
    const result = await fixture.run(
      [
        "video",
        "a fox",
        "--provider",
        "grok",
        "-n",
        "2",
        "--poll-interval-ms",
        "10",
        "-o",
        join(fixture.directory, "grok-videos/"),
        "--json",
        "--quiet",
        "--no-preview",
      ],
      { env }
    );
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).results[0].videos).toHaveLength(2);
    expect(
      result.requests.filter((r) => r.route.endsWith("/videos/generations"))
    ).toHaveLength(2);
  });

  test("under ai mcp, an operation file cannot switch to the Grok login", async () => {
    const operation = join(fixture.directory, "agent-operation.json");
    writeFileSync(
      operation,
      JSON.stringify({
        model: "grok-imagine-video",
        provider: "grok",
        operation: { requestId: "grok-job" },
      })
    );
    const result = await fixture.run(
      ["video", "status", operation, "--quiet"],
      {
        env: { ...env, AI_CLI_MCP_SERVER: "1" },
      }
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      "Operation file uses provider grok, but this MCP server uses gateway"
    );
    expect(result.requests).toHaveLength(0);
  });

  test("rejects AI Gateway connection flags", async () => {
    const result = await fixture.run(
      [
        "image",
        "a fox",
        "--provider",
        "grok",
        "--base-url",
        "https://example.com",
        "--quiet",
      ],
      { env }
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("--base-url applies to AI Gateway only");
    expect(result.requests).toHaveLength(0);
  });
});
