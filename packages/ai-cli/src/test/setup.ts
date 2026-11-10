import { tmpdir } from "node:os";
import { join } from "node:path";

// Tests assert AI Gateway behavior unless they opt into another provider.
// A developer shell that selects a provider or default model (for example
// AI_CLI_PROVIDER=openrouter) must not leak into spawned CLI processes.
for (const name of [
  "AI_CLI_PROVIDER",
  "AI_CLI_TEXT_MODEL",
  "AI_CLI_IMAGE_MODEL",
  "AI_CLI_VIDEO_MODEL",
  "AI_CLI_SPEECH_MODEL",
  "AI_CLI_TRANSCRIPTION_MODEL",
  "AI_CLI_EVALUATION_MODEL",
  "OPENROUTER_API_KEY",
  "OPENROUTER_BASE_URL",
  "XAI_API_KEY",
  "XAI_BASE_URL",
  "GROK_BIN",
  "GROK_PROXY_BASE_URL",
  "GROK_CLIENT_VERSION",
  "CODEX_BASE_URL",
])
  delete process.env[name];

// Never read or refresh the developer's real Grok or Codex logins.
const missing = join(tmpdir(), "ai-cli-test-no-login");
process.env.GROK_HOME = join(missing, "grok");
process.env.CODEX_HOME = join(missing, "codex");
