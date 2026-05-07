import { complete, type UserMessage } from "@mariozechner/pi-ai";
import type { ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import type { ReviewFile, ReviewFileContents, ReviewScope } from "./types.js";

const SYSTEM_PROMPT = `You explain source files and diffs to a developer using a review UI.

Be concise, concrete, and educational. Explain what the code is for, the key flow, important dependencies or data shapes, and anything risky or surprising. Do not propose code changes unless there is an obvious issue in the provided text. If context is truncated, say so briefly. Use markdown.`;

const MAX_SECTION_CHARS = 18_000;
const MAX_SELECTION_LINES = 240;

export interface ExplanationSelection {
  side: "original" | "modified";
  startLine: number;
  endLine: number;
}

type RequestAuth = {
  apiKey?: string;
  headers?: Record<string, string>;
};

type ModelRegistryCompat = {
  getApiKeyAndHeaders?: (model: unknown) => Promise<{ ok: true; apiKey?: string; headers?: Record<string, string> } | { ok: false; error: string }>;
  getApiKey?: (model: unknown) => Promise<string | undefined>;
  getApiKeyForProvider?: (provider: string) => Promise<string | undefined>;
};

async function resolveRequestAuth(ctx: ExtensionCommandContext, model: { provider: string }): Promise<RequestAuth> {
  const registry = ctx.modelRegistry as unknown as ModelRegistryCompat;

  if (typeof registry.getApiKeyAndHeaders === "function") {
    const result = await registry.getApiKeyAndHeaders(model);
    if (!result.ok) throw new Error(result.error);
    return { apiKey: result.apiKey, headers: result.headers };
  }

  if (typeof registry.getApiKey === "function") {
    return { apiKey: await registry.getApiKey(model) };
  }

  if (typeof registry.getApiKeyForProvider === "function") {
    return { apiKey: await registry.getApiKeyForProvider(model.provider) };
  }

  throw new Error("This pi version does not expose a model auth helper to extensions.");
}

function hasRequestAuth(auth: RequestAuth): boolean {
  return typeof auth.apiKey === "string" && auth.apiKey.length > 0 || auth.headers != null && Object.keys(auth.headers).length > 0;
}

function scopeLabel(scope: ReviewScope, branch: string | null): string {
  switch (scope) {
    case "branch-diff": return branch ? `branch diff against ${branch}` : "branch diff";
    case "git-diff": return "git diff against HEAD";
    case "last-commit": return "last commit";
    default: return "current working-tree file";
  }
}

function fenceLanguage(path: string): string {
  const lower = path.toLowerCase();
  if (lower.endsWith(".ts") || lower.endsWith(".tsx")) return "ts";
  if (lower.endsWith(".js") || lower.endsWith(".jsx") || lower.endsWith(".mjs") || lower.endsWith(".cjs")) return "js";
  if (lower.endsWith(".json")) return "json";
  if (lower.endsWith(".md")) return "md";
  if (lower.endsWith(".css")) return "css";
  if (lower.endsWith(".html")) return "html";
  if (lower.endsWith(".sh")) return "sh";
  if (lower.endsWith(".yml") || lower.endsWith(".yaml")) return "yaml";
  if (lower.endsWith(".rs")) return "rust";
  if (lower.endsWith(".java")) return "java";
  if (lower.endsWith(".kt")) return "kotlin";
  if (lower.endsWith(".py")) return "python";
  if (lower.endsWith(".go")) return "go";
  return "";
}

function truncateMiddle(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  const keep = Math.floor((maxChars - 120) / 2);
  return `${value.slice(0, keep)}\n\n[... ${value.length - (keep * 2)} characters omitted ...]\n\n${value.slice(-keep)}`;
}

function numberedLines(value: string, startLine = 1): string {
  return value
    .split(/\r?\n/)
    .map((line, index) => `${String(startLine + index).padStart(5, " ")} | ${line}`)
    .join("\n");
}

function sliceSelection(contents: ReviewFileContents, selection: ExplanationSelection): { content: string; startLine: number; endLine: number; truncated: boolean } {
  const source = selection.side === "original" ? contents.originalContent : contents.modifiedContent;
  const lines = source.split(/\r?\n/);
  const startLine = Math.max(1, Math.min(selection.startLine, lines.length || 1));
  const endLine = Math.max(startLine, Math.min(selection.endLine, lines.length || startLine));
  const selectedLines = lines.slice(startLine - 1, endLine);

  if (selectedLines.length <= MAX_SELECTION_LINES) {
    return {
      content: numberedLines(selectedLines.join("\n"), startLine),
      startLine,
      endLine,
      truncated: false,
    };
  }

  const headCount = Math.floor(MAX_SELECTION_LINES / 2);
  const tailCount = MAX_SELECTION_LINES - headCount;
  const omitted = selectedLines.length - MAX_SELECTION_LINES;
  const head = selectedLines.slice(0, headCount);
  const tail = selectedLines.slice(-tailCount);
  return {
    content: [
      numberedLines(head.join("\n"), startLine),
      `[... ${omitted} selected lines omitted ...]`,
      numberedLines(tail.join("\n"), endLine - tail.length + 1),
    ].join("\n"),
    startLine,
    endLine,
    truncated: true,
  };
}

function buildFilePrompt(file: ReviewFile, scope: ReviewScope, branch: string | null, contents: ReviewFileContents): string {
  const language = fenceLanguage(file.path);
  const sameContent = contents.originalContent === contents.modifiedContent;

  if (sameContent || scope === "all-files") {
    return [
      `Explain this file to me.`,
      `Path: ${file.path}`,
      `Scope: ${scopeLabel(scope, branch)}`,
      "",
      `\`\`\`${language}`,
      truncateMiddle(contents.modifiedContent || contents.originalContent, MAX_SECTION_CHARS * 2),
      "```",
    ].join("\n");
  }

  return [
    `Explain this changed file to me.`,
    `Path: ${file.path}`,
    `Scope: ${scopeLabel(scope, branch)}`,
    "",
    `Original version:`,
    `\`\`\`${language}`,
    truncateMiddle(contents.originalContent, MAX_SECTION_CHARS),
    "```",
    "",
    `Modified version:`,
    `\`\`\`${language}`,
    truncateMiddle(contents.modifiedContent, MAX_SECTION_CHARS),
    "```",
  ].join("\n");
}

function buildSelectionPrompt(file: ReviewFile, scope: ReviewScope, branch: string | null, contents: ReviewFileContents, selection: ExplanationSelection): string {
  const language = fenceLanguage(file.path);
  const selected = sliceSelection(contents, selection);
  const sideLabel = selection.side === "original" ? "original/old side" : "modified/new side";

  return [
    `Explain this selected range to me.`,
    `Path: ${file.path}`,
    `Scope: ${scopeLabel(scope, branch)}`,
    `Side: ${sideLabel}`,
    `Lines: ${selected.startLine}-${selected.endLine}${selected.truncated ? " (selection truncated)" : ""}`,
    "",
    `\`\`\`${language}`,
    selected.content,
    "```",
  ].join("\n");
}

export function explanationTitle(file: ReviewFile, selection: ExplanationSelection | null): string {
  if (selection == null) return `Explanation: ${file.path}`;
  const side = selection.side === "original" ? "old" : "new";
  return `Explanation: ${file.path}:${selection.startLine}-${selection.endLine} (${side})`;
}

export async function explainReviewFile(
  ctx: ExtensionCommandContext,
  file: ReviewFile,
  scope: ReviewScope,
  branch: string | null,
  contents: ReviewFileContents,
  selection: ExplanationSelection | null,
): Promise<string> {
  const model = ctx.model;
  if (!model) {
    throw new Error("No model selected in pi.");
  }

  const auth = await resolveRequestAuth(ctx, model);
  if (!hasRequestAuth(auth)) {
    throw new Error(`No API key or request headers for ${model.provider}.`);
  }

  const prompt = selection == null
    ? buildFilePrompt(file, scope, branch, contents)
    : buildSelectionPrompt(file, scope, branch, contents, selection);

  const userMessage: UserMessage = {
    role: "user",
    content: [{ type: "text", text: prompt }],
    timestamp: Date.now(),
  };

  const response = await complete(
    model,
    { systemPrompt: SYSTEM_PROMPT, messages: [userMessage] },
    { apiKey: auth.apiKey, headers: auth.headers },
  );

  if (response.stopReason === "aborted") {
    throw new Error("Explanation cancelled.");
  }

  const text = response.content
    .filter((item): item is { type: "text"; text: string } => item.type === "text")
    .map((item) => item.text)
    .join("\n")
    .trim();

  return text || "No explanation returned.";
}
