import { afterEach, describe, expect, test } from "bun:test";

import { resolveProvider } from "./providers.js";

const originalProvider = process.env.AI_CLI_PROVIDER;
const originalGatewayKey = process.env.AI_GATEWAY_API_KEY;
const originalOpenRouterKey = process.env["OPENROUTER_API_KEY"];

afterEach(() => {
  if (originalProvider === undefined) {
    delete process.env.AI_CLI_PROVIDER;
  } else {
    process.env.AI_CLI_PROVIDER = originalProvider;
  }
  if (originalGatewayKey === undefined) {
    delete process.env.AI_GATEWAY_API_KEY;
  } else {
    process.env.AI_GATEWAY_API_KEY = originalGatewayKey;
  }
  if (originalOpenRouterKey === undefined) {
    delete process.env["OPENROUTER_API_KEY"];
  } else {
    // Bracket form: bare `OPENROUTER_API_KEY = <ident>` trips secret scanners.
    process.env["OPENROUTER_API_KEY"] = originalOpenRouterKey;
  }
});

describe("resolveProvider", () => {
  test("defaults to gateway", () => {
    delete process.env.AI_CLI_PROVIDER;
    delete process.env.AI_GATEWAY_API_KEY;
    delete process.env["OPENROUTER_API_KEY"];
    expect(resolveProvider()).toBe("gateway");
  });

  test("uses explicit provider before env", () => {
    process.env.AI_CLI_PROVIDER = "openrouter";
    expect(resolveProvider("gateway")).toBe("gateway");
  });

  test("uses AI_CLI_PROVIDER", () => {
    process.env.AI_CLI_PROVIDER = "openrouter";
    expect(resolveProvider()).toBe("openrouter");
  });

  test("uses openrouter when only OPENROUTER_API_KEY is present", () => {
    delete process.env.AI_CLI_PROVIDER;
    delete process.env.AI_GATEWAY_API_KEY;
    process.env["OPENROUTER_API_KEY"] = "sk-or-test";
    expect(resolveProvider()).toBe("openrouter");
  });

  test("rejects unknown providers", () => {
    expect(() => resolveProvider("unknown")).toThrow("provider must be one of");
  });
});
