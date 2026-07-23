import { randomBytes } from "crypto";
import { writeFileSync, mkdirSync, statSync } from "fs";
import { resolve, join, dirname } from "path";

import {
  supportsKittyGraphics,
  displayImage,
  displayVideoFrame,
} from "./kitty.js";

export type OutputFormat = "md" | "txt" | "image" | "video";

const DEFAULT_EXTENSIONS: Record<OutputFormat, string> = {
  md: ".md",
  txt: ".txt",
  image: ".png",
  video: ".mp4",
};

export interface WriteOutputOptions {
  data: Buffer | string;
  format: OutputFormat;
  outputPath?: string;
  outputId?: string;
  suffix?: string;
  quiet?: boolean;
  display?: boolean;
}

function defaultFilename(
  format: OutputFormat,
  outputId?: string,
  data?: Buffer
): string {
  const ext =
    format === "image" && data ? imageExtension(data) : DEFAULT_EXTENSIONS[format];
  return `${filenameStem(outputId)}${ext}`;
}

/** Prefer .svg when payload looks like vector markup (OpenRouter Recraft vector, etc.). */
function imageExtension(data: Buffer): string {
  const head = data
    .subarray(0, Math.min(data.length, 256))
    .toString("utf8")
    .trimStart()
    .toLowerCase();
  if (head.startsWith("<svg") || head.startsWith("<?xml")) return ".svg";
  return DEFAULT_EXTENSIONS.image;
}

function filenameStem(outputId?: string): string {
  return sanitizeFilenameStem(outputId) ?? randomBytes(4).toString("hex");
}

function sanitizeFilenameStem(outputId?: string): string | undefined {
  const trimmed = outputId?.trim();
  if (!trimmed) return undefined;

  const sanitized = trimmed.replace(/[^A-Za-z0-9._-]+/g, "-");
  if (!sanitized || sanitized === "." || sanitized === "..") return undefined;

  return sanitized;
}

function isDirectory(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

export async function writeOutput(
  opts: WriteOutputOptions
): Promise<string | null> {
  const { data, format, outputId, suffix, quiet, display } = opts;
  const effectiveOutput = opts.outputPath ?? process.env.AI_CLI_OUTPUT_DIR;
  const buf = typeof data === "string" ? Buffer.from(data, "utf-8") : data;
  const shouldDisplay =
    display !== false &&
    (format === "image" || format === "video") &&
    process.stdout.isTTY &&
    supportsKittyGraphics();

  if (effectiveOutput) {
    let filePath: string;
    if (isDirectory(effectiveOutput)) {
      filePath = join(
        effectiveOutput,
        addSuffix(defaultFilename(format, outputId, buf), suffix)
      );
    } else {
      filePath = addSuffix(effectiveOutput, suffix);
    }
    filePath = resolve(filePath);
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, buf);
    if (!quiet) process.stderr.write(`Saved to ${filePath}\n`);
    if (shouldDisplay) await showPreview(format, buf);
    return filePath;
  }

  if (!process.stdout.isTTY) {
    process.stdout.write(buf);
    return null;
  }

  const filename = addSuffix(defaultFilename(format, outputId, buf), suffix);
  const path = resolve(filename);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, buf);
  if (!quiet) process.stderr.write(`Saved to ${path}\n`);
  if (shouldDisplay) await showPreview(format, buf);
  return path;
}

async function showPreview(format: OutputFormat, buf: Buffer): Promise<void> {
  if (format === "video") {
    await displayVideoFrame(buf);
  } else {
    displayImage(buf);
  }
}

function addSuffix(filename: string, suffix?: string): string {
  if (!suffix) return filename;
  const dot = filename.lastIndexOf(".");
  if (dot === -1) return `${filename}-${suffix}`;
  return `${filename.slice(0, dot)}-${suffix}${filename.slice(dot)}`;
}
