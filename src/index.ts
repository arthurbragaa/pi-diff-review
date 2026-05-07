import { readdirSync, statSync } from "node:fs";
import { appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import type { GlimpseWindow } from "glimpseui";
import { answerReviewQuestion, explainReviewFile, explanationTitle, type ExplanationSelection } from "./explain.js";
import { getReviewWindowData, loadReviewFileContents } from "./git.js";
import { openQuietGlimpse } from "./glimpse-quiet.js";
import { composeReviewPrompt } from "./prompt.js";
import { loadReviewedFiles, saveReviewedFiles } from "./review-state.js";
import type {
  ReviewAiChatPayload,
  ReviewCancelPayload,
  ReviewClientLogPayload,
  ReviewExplainFilePayload,
  ReviewExplainSelectionPayload,
  ReviewFile,
  ReviewFileContents,
  ReviewHostMessage,
  ReviewRequestFilePayload,
  ReviewSubmitPayload,
  ReviewWindowMessage,
} from "./types.js";
import { buildReviewHtml } from "./ui.js";

function isSubmitPayload(value: ReviewWindowMessage): value is ReviewSubmitPayload {
  return value.type === "submit";
}

function isCancelPayload(value: ReviewWindowMessage): value is ReviewCancelPayload {
  return value.type === "cancel";
}

function isRequestFilePayload(value: ReviewWindowMessage): value is ReviewRequestFilePayload {
  return value.type === "request-file";
}

function isExplainFilePayload(value: ReviewWindowMessage): value is ReviewExplainFilePayload {
  return value.type === "explain-file";
}

function isExplainSelectionPayload(value: ReviewWindowMessage): value is ReviewExplainSelectionPayload {
  return value.type === "explain-selection";
}

function isClientLogPayload(value: ReviewWindowMessage): value is ReviewClientLogPayload {
  return value.type === "client-log";
}

function isClientReadyPayload(value: ReviewWindowMessage): boolean {
  return value.type === "client-ready";
}

function isAiChatPayload(value: ReviewWindowMessage): value is ReviewAiChatPayload {
  return value.type === "ai-chat";
}

const LOG_PATH = "/tmp/pi-diff-review.log";
const MAX_CHAT_CONTEXT_FILES = 6;
const MAX_CHAT_CONTEXT_FILE_CHARS = 12_000;
const MAX_CHAT_CONTEXT_TOTAL_CHARS = 48_000;
const MAX_CHAT_CONTEXT_FILE_BYTES = 180_000;

const CHAT_CONTEXT_BINARY_EXTENSIONS = new Set([
  ".7z", ".a", ".avi", ".avif", ".bin", ".bmp", ".class", ".dll", ".dylib", ".eot", ".exe", ".gif", ".gz", ".ico", ".jar", ".jpeg", ".jpg", ".lock", ".lockb", ".map", ".mov", ".mp3", ".mp4", ".o", ".otf", ".pdf", ".png", ".pyc", ".so", ".svgz", ".tar", ".ttf", ".wasm", ".webm", ".webp", ".woff", ".woff2", ".zip",
]);

function escapeForInlineScript(value: string): string {
  return value.replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026");
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

async function logReview(level: "debug" | "info" | "warn" | "error", message: string, details?: unknown): Promise<void> {
  const line = `${new Date().toISOString()} ${level.toUpperCase()} ${message}${details === undefined ? "" : ` ${safeJson(details)}`}\n`;
  try {
    await appendFile(LOG_PATH, line, "utf8");
  } catch {}
}

function waylandSocketExists(display: string): boolean {
  const runtimeDir = process.env.XDG_RUNTIME_DIR;
  if (!runtimeDir) return false;

  const socketPath = display.startsWith("/") ? display : join(runtimeDir, display);
  try {
    return statSync(socketPath).isSocket();
  } catch {
    return false;
  }
}

function detectWaylandDisplay(): string | null {
  const runtimeDir = process.env.XDG_RUNTIME_DIR;
  if (!runtimeDir) return null;

  try {
    const sockets = readdirSync(runtimeDir, { withFileTypes: true })
      .filter((entry) => entry.isSocket() && /^wayland-\d+$/.test(entry.name))
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    return sockets[0] ?? null;
  } catch {
    return null;
  }
}

function ensureGlimpseDisplayEnvironment(): void {
  if (process.platform !== "linux") return;

  const currentWaylandDisplay = process.env.WAYLAND_DISPLAY;
  if (currentWaylandDisplay && waylandSocketExists(currentWaylandDisplay)) return;

  const detectedWaylandDisplay = detectWaylandDisplay();
  if (detectedWaylandDisplay) {
    process.env.WAYLAND_DISPLAY = detectedWaylandDisplay;
  }
}

function parseGitPathList(output: string): string[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function fileExtension(path: string): string {
  const fileName = path.toLowerCase().split("/").pop() ?? path.toLowerCase();
  const dotIndex = fileName.lastIndexOf(".");
  return dotIndex < 0 ? "" : fileName.slice(dotIndex);
}

function isLikelyTextProjectPath(path: string): boolean {
  const lower = path.toLowerCase();
  if (lower.includes("/.git/") || lower.includes("/node_modules/") || lower.includes("/vendor/bundle/")) return false;
  if (lower.endsWith("package-lock.json") || lower.endsWith("pnpm-lock.yaml") || lower.endsWith("yarn.lock") || lower.endsWith("gemfile.lock")) return false;
  return !CHAT_CONTEXT_BINARY_EXTENSIONS.has(fileExtension(path));
}

function camelToSnake(value: string): string {
  return value
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .replace(/([a-z\d])([A-Z])/g, "$1_$2")
    .replace(/[-\s]+/g, "_")
    .toLowerCase();
}

function namespacePath(symbol: string): string {
  return symbol.split("::").map(camelToSnake).join("/");
}

function extractExplicitPathHints(value: string): string[] {
  const hints = new Set<string>();
  const addHint = (candidate: string): void => {
    const cleaned = candidate.trim().replace(/^['"`]+|['"`,.:;]+$/g, "");
    if (cleaned.length < 3 || cleaned.length > 220) return;
    if (!/[/.]/.test(cleaned)) return;
    if (/^https?:\/\//i.test(cleaned)) return;
    hints.add(cleaned);
  };

  for (const match of value.matchAll(/`([^`\n]+)`/g)) addHint(match[1]);
  for (const match of value.matchAll(/(?:^|\s)([\w@./-]+\.[A-Za-z0-9]{1,8})(?=\s|$|[),.;:])/g)) addHint(match[1]);
  return [...hints];
}

function extractNamespaceSymbols(value: string): string[] {
  return [...new Set([...value.matchAll(/\b[A-Z][A-Za-z0-9]*(?:::[A-Z][A-Za-z0-9]*)+\b/g)].map((match) => match[0]))];
}

function extractQuestionClassWords(value: string): string[] {
  return [...new Set([...value.matchAll(/\b[A-Z][A-Za-z0-9]{2,}\b/g)].map((match) => match[0]))]
    .filter((word) => !["AI", "API", "HTTP", "JSON", "URL", "ID"].includes(word));
}

function scoreProjectPath(path: string, activePath: string | null, explicitHints: string[], namespaceSymbols: string[], classWords: string[]): number {
  if (!isLikelyTextProjectPath(path)) return 0;
  if (activePath != null && path === activePath) return 0;

  const lowerPath = path.toLowerCase();
  let score = 0;

  for (const hint of explicitHints) {
    const normalized = hint.replace(/^\.\//, "").toLowerCase();
    if (lowerPath === normalized) score += 1200;
    else if (lowerPath.endsWith(`/${normalized}`) || lowerPath.includes(normalized)) score += 800;
  }

  for (const symbol of namespaceSymbols) {
    const namespacedPath = namespacePath(symbol);
    const parts = namespacedPath.split("/");
    const lastPart = parts[parts.length - 1] ?? "";
    if (lowerPath.includes(namespacedPath)) score += 1200;
    if (lowerPath.endsWith(`${namespacedPath}.rb`) || lowerPath.endsWith(`${namespacedPath}.ts`) || lowerPath.endsWith(`${namespacedPath}.js`)) score += 400;
    if (parts.length > 1 && parts.every((part) => lowerPath.includes(part))) score += 500;
    if (lastPart && lowerPath.split("/").pop()?.startsWith(lastPart)) score += 80;
  }

  for (const word of classWords) {
    const snake = camelToSnake(word);
    const fileName = lowerPath.split("/").pop() ?? lowerPath;
    if (fileName.startsWith(snake)) score += 120;
  }

  return score;
}

async function listProjectFiles(pi: ExtensionAPI, repoRoot: string): Promise<string[]> {
  const tracked = await pi.exec("git", ["ls-files", "--cached"], { cwd: repoRoot });
  const untracked = await pi.exec("git", ["ls-files", "--others", "--exclude-standard"], { cwd: repoRoot });
  return [...new Set([
    ...(tracked.code === 0 ? parseGitPathList(tracked.stdout) : []),
    ...(untracked.code === 0 ? parseGitPathList(untracked.stdout) : []),
  ])];
}

async function readProjectTextFile(repoRoot: string, path: string): Promise<string | null> {
  try {
    const fullPath = join(repoRoot, path);
    const stats = statSync(fullPath);
    if (!stats.isFile() || stats.size > MAX_CHAT_CONTEXT_FILE_BYTES) return null;
    return await readFile(fullPath, "utf8");
  } catch {
    return null;
  }
}

function scoreProjectContent(content: string, namespaceSymbols: string[], classWords: string[]): number {
  let score = 0;
  for (const symbol of namespaceSymbols) {
    if (content.includes(symbol)) score += 800;
    const parts = symbol.split("::");
    const lastPart = parts[parts.length - 1] ?? "";
    if (lastPart && new RegExp(`\\b(class|module)\\s+${lastPart}\\b`).test(content)) score += 300;
    if (parts.every((part) => content.includes(part))) score += 250;
  }
  for (const word of classWords) {
    if (new RegExp(`\\b(class|module)\\s+${word}\\b`).test(content)) score += 220;
  }
  return score;
}

function formatProjectContextFile(path: string, content: string): string {
  const truncated = content.length > MAX_CHAT_CONTEXT_FILE_CHARS
    ? `${content.slice(0, MAX_CHAT_CONTEXT_FILE_CHARS)}\n\n[... ${content.length - MAX_CHAT_CONTEXT_FILE_CHARS} characters omitted ...]`
    : content;
  return [`### ${path}`, "```", truncated, "```"].join("\n");
}

async function buildProjectChatContext(pi: ExtensionAPI, repoRoot: string, activeFile: ReviewFile | null, activeContents: ReviewFileContents | null, question: string, contextMarkdown: string, selectedText: string): Promise<string> {
  const activePath = activeFile?.path ?? null;
  const searchText = [question, contextMarkdown, selectedText, activeContents?.modifiedContent ?? "", activeContents?.originalContent ?? ""].join("\n");
  const explicitHints = extractExplicitPathHints(question);
  const namespaceSymbols = extractNamespaceSymbols(searchText).slice(0, 12);
  const classWords = extractQuestionClassWords(question).slice(0, 8);

  if (explicitHints.length === 0 && namespaceSymbols.length === 0 && classWords.length === 0) return "";

  const projectFiles = await listProjectFiles(pi, repoRoot);
  const scoredByPath = projectFiles
    .map((path) => ({ path, score: scoreProjectPath(path, activePath, explicitHints, namespaceSymbols, classWords) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 16);

  const candidates = new Map<string, { path: string; score: number; content: string }>();
  for (const entry of scoredByPath) {
    const content = await readProjectTextFile(repoRoot, entry.path);
    if (content != null) candidates.set(entry.path, { ...entry, content });
  }

  const contentSearchFiles = projectFiles
    .filter((path) => !candidates.has(path))
    .filter((path) => isLikelyTextProjectPath(path))
    .filter((path) => activePath == null || path !== activePath)
    .slice(0, 600);

  for (const path of contentSearchFiles) {
    if (candidates.size >= 24) break;
    const content = await readProjectTextFile(repoRoot, path);
    if (content == null) continue;
    const score = scoreProjectContent(content, namespaceSymbols, classWords);
    if (score > 0) candidates.set(path, { path, score, content });
  }

  const selected = [...candidates.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_CHAT_CONTEXT_FILES);

  const sections: string[] = [];
  let totalChars = 0;
  for (const item of selected) {
    const section = formatProjectContextFile(item.path, item.content);
    if (totalChars + section.length > MAX_CHAT_CONTEXT_TOTAL_CHARS) break;
    sections.push(section);
    totalChars += section.length;
  }

  return sections.length === 0 ? "" : sections.join("\n\n");
}

export default function (pi: ExtensionAPI) {
  let activeWindow: GlimpseWindow | null = null;

  function closeWindow(window: GlimpseWindow): void {
    try {
      window.close();
    } catch {}
  }

  function closeActiveWindow(): void {
    if (activeWindow == null) return;
    const windowToClose = activeWindow;
    activeWindow = null;
    closeWindow(windowToClose);
  }

  function insertOrAppendEditorText(ctx: ExtensionCommandContext, text: string): "inserted" | "appended" {
    const currentText = ctx.ui.getEditorText();
    if (currentText.trim().length === 0) {
      ctx.ui.setEditorText(text);
      return "inserted";
    }

    const separator = currentText.endsWith("\n\n") ? "" : currentText.endsWith("\n") ? "\n" : "\n\n";
    ctx.ui.setEditorText(`${currentText}${separator}${text}`);
    return "appended";
  }

  async function reviewRepository(ctx: ExtensionCommandContext): Promise<void> {
    await logReview("info", "diff-review command started", { cwd: ctx.cwd, model: ctx.model == null ? null : `${ctx.model.provider}/${ctx.model.id}` });
    if (activeWindow != null) {
      await logReview("warn", "diff-review command rejected because window is already open");
      ctx.ui.notify("A review window is already open.", "warning");
      return;
    }

    const { repoRoot, files, branchComparisons } = await getReviewWindowData(pi, ctx.cwd);
    await logReview("info", "review data loaded", { repoRoot, files: files.length, branchComparisons: branchComparisons.map((item) => item.branch) });
    if (files.length === 0) {
      await logReview("info", "no reviewable files found", { repoRoot });
      ctx.ui.notify("No reviewable files found.", "info");
      return;
    }

    const reviewedFiles = await loadReviewedFiles(pi, repoRoot);
    const html = buildReviewHtml({ repoRoot, files, reviewedFiles, branchComparisons });
    ensureGlimpseDisplayEnvironment();
    const window = openQuietGlimpse(html, {
      width: 1680,
      height: 1020,
      title: "pi review",
    }, (line) => {
      void logReview("warn", "glimpse stderr", line);
    });
    activeWindow = window;
    await logReview("info", "native review window opened", { logPath: LOG_PATH });

    const fileMap = new Map(files.map((file) => [file.id, file]));
    const contentCache = new Map<string, Promise<ReviewFileContents>>();
    const queuedWindowMessages: ReviewHostMessage[] = [];
    let clientReady = false;

    const sendWindowMessageNow = (message: ReviewHostMessage): void => {
      if (activeWindow !== window) return;
      const payload = escapeForInlineScript(JSON.stringify(message));
      window.send(`window.__reviewReceive(${payload});`);
    };

    const sendWindowMessage = (message: ReviewHostMessage): void => {
      if (!clientReady) {
        queuedWindowMessages.push(message);
        return;
      }
      sendWindowMessageNow(message);
    };

    const flushWindowMessages = (): void => {
      if (activeWindow !== window) return;
      clientReady = true;
      for (const message of queuedWindowMessages.splice(0)) {
        sendWindowMessageNow(message);
      }
    };

    const loadContents = (file: ReviewFile, scope: ReviewRequestFilePayload["scope"], branch: string | null): Promise<ReviewFileContents> => {
      const branchComparison = scope === "branch-diff"
        ? branchComparisons.find((comparison) => comparison.branch === branch) ?? null
        : null;
      const cacheKey = `${scope}:${branchComparison?.branch ?? ""}:${file.id}`;
      const cached = contentCache.get(cacheKey);
      if (cached != null) return cached;

      const pending = loadReviewFileContents(pi, repoRoot, file, scope, branchComparison);
      contentCache.set(cacheKey, pending);
      return pending;
    };

    const finishReview = async (message: ReviewSubmitPayload | ReviewCancelPayload | null): Promise<void> => {
      if (message == null || message.type === "cancel") {
        ctx.ui.notify("Review cancelled.", "info");
        return;
      }

      await saveReviewedFiles(pi, repoRoot, message.reviewedFiles);

      const hasFeedback = message.overallComment.trim().length > 0 || message.comments.some((comment) => comment.body.trim().length > 0);
      if (!hasFeedback) {
        ctx.ui.notify("Review finished.", "info");
        return;
      }

      const prompt = composeReviewPrompt(files, message);
      const insertMode = insertOrAppendEditorText(ctx, prompt);
      ctx.ui.notify(
        insertMode === "inserted"
          ? "Inserted review feedback into the editor."
          : "Appended review feedback to the editor.",
        "info",
      );
    };

    const handleBackgroundError = async (error: unknown): Promise<void> => {
      const message = error instanceof Error ? error.message : String(error);
      await logReview("error", "review failed", { message, stack: error instanceof Error ? error.stack : undefined });
      ctx.ui.notify(`Review failed: ${message}`, "error");
    };

    let settled = false;

    const cleanup = (): void => {
      window.removeListener("message", onMessage);
      window.removeListener("closed", onClosed);
      window.removeListener("error", onError);
      ctx.ui.setStatus("diff-review", undefined);
      if (activeWindow === window) {
        activeWindow = null;
      }
    };

    const settle = (value: ReviewSubmitPayload | ReviewCancelPayload | null, shouldCloseWindow: boolean): void => {
      if (settled) return;
      settled = true;
      cleanup();
      if (shouldCloseWindow) {
        closeWindow(window);
      }
      void finishReview(value).catch((error) => {
        void handleBackgroundError(error);
      });
    };

    const handleRequestFile = async (message: ReviewRequestFilePayload): Promise<void> => {
      await logReview("debug", "window requested file", { fileId: message.fileId, scope: message.scope, branch: message.branch });
      const file = fileMap.get(message.fileId);
      if (file == null) {
        await logReview("warn", "window requested unknown file", { fileId: message.fileId });
        sendWindowMessage({
          type: "file-error",
          requestId: message.requestId,
          fileId: message.fileId,
          scope: message.scope,
          branch: message.branch,
          message: "Unknown file requested.",
        });
        return;
      }

      try {
        const contents = await loadContents(file, message.scope, message.branch);
        await logReview("debug", "file contents loaded", { path: file.path, scope: message.scope, originalChars: contents.originalContent.length, modifiedChars: contents.modifiedContent.length });
        sendWindowMessage({
          type: "file-data",
          requestId: message.requestId,
          fileId: message.fileId,
          scope: message.scope,
          branch: message.branch,
          originalContent: contents.originalContent,
          modifiedContent: contents.modifiedContent,
        });
      } catch (error) {
        const messageText = error instanceof Error ? error.message : String(error);
        await logReview("error", "file contents failed", { fileId: message.fileId, scope: message.scope, message: messageText });
        sendWindowMessage({
          type: "file-error",
          requestId: message.requestId,
          fileId: message.fileId,
          scope: message.scope,
          branch: message.branch,
          message: messageText,
        });
      }
    };

    const handleExplain = async (message: ReviewExplainFilePayload | ReviewExplainSelectionPayload): Promise<void> => {
      await logReview("info", "window requested explanation", message);
      const file = fileMap.get(message.fileId);
      const selection: ExplanationSelection | null = isExplainSelectionPayload(message)
        ? { side: message.side, startLine: message.startLine, endLine: message.endLine }
        : null;
      const title = file == null ? "Explanation" : explanationTitle(file, selection);

      if (file == null) {
        await logReview("warn", "window requested explanation for unknown file", { fileId: message.fileId });
        sendWindowMessage({
          type: "explanation-error",
          requestId: message.requestId,
          fileId: message.fileId,
          scope: message.scope,
          branch: message.branch,
          title,
          message: "Unknown file requested.",
        });
        return;
      }

      try {
        const contents = await loadContents(file, message.scope, message.branch);
        const markdown = await explainReviewFile(ctx, file, message.scope, message.branch, contents, selection);
        await logReview("info", "explanation generated", { path: file.path, requestId: message.requestId, chars: markdown.length });
        sendWindowMessage({
          type: "explanation-data",
          requestId: message.requestId,
          fileId: message.fileId,
          scope: message.scope,
          branch: message.branch,
          title,
          markdown,
        });
      } catch (error) {
        const messageText = error instanceof Error ? error.message : String(error);
        await logReview("error", "explanation failed", { requestId: message.requestId, fileId: message.fileId, title, message: messageText });
        sendWindowMessage({
          type: "explanation-error",
          requestId: message.requestId,
          fileId: message.fileId,
          scope: message.scope,
          branch: message.branch,
          title,
          message: messageText,
        });
      }
    };

    const handleAiChat = async (message: ReviewAiChatPayload): Promise<void> => {
      await logReview("info", "window requested ai chat", { requestId: message.requestId, fileId: message.fileId, chars: message.question.length });
      const file = message.fileId == null ? null : fileMap.get(message.fileId) ?? null;

      try {
        const contents = file == null ? null : await loadContents(file, message.scope, message.branch);
        const selectedText = message.selection?.text ?? "";
        const projectContextMarkdown = await buildProjectChatContext(pi, repoRoot, file, contents, message.question, message.contextMarkdown, selectedText);
        await logReview("debug", "project chat context loaded", { requestId: message.requestId, chars: projectContextMarkdown.length, selectedChars: selectedText.length });
        const markdown = await answerReviewQuestion(ctx, {
          repoRoot,
          file,
          scope: message.scope,
          branch: message.branch,
          contents,
          contextMarkdown: message.contextMarkdown,
          projectContextMarkdown,
          selection: message.selection,
          messages: message.messages,
          question: message.question,
        });
        sendWindowMessage({
          type: "ai-chat-data",
          requestId: message.requestId,
          markdown,
        });
      } catch (error) {
        const messageText = error instanceof Error ? error.message : String(error);
        await logReview("error", "ai chat failed", { requestId: message.requestId, message: messageText });
        sendWindowMessage({
          type: "ai-chat-error",
          requestId: message.requestId,
          message: messageText,
        });
      }
    };

    const onMessage = (data: unknown): void => {
      const message = data as ReviewWindowMessage;
      if (isClientLogPayload(message)) {
        void logReview(message.level, `client: ${message.message}`, message.details);
        return;
      }
      if (isClientReadyPayload(message)) {
        flushWindowMessages();
        return;
      }
      if (isAiChatPayload(message)) {
        void handleAiChat(message);
        return;
      }
      if (isRequestFilePayload(message)) {
        void handleRequestFile(message);
        return;
      }
      if (isExplainFilePayload(message) || isExplainSelectionPayload(message)) {
        void handleExplain(message);
        return;
      }
      if (isSubmitPayload(message) || isCancelPayload(message)) {
        void logReview("info", `window ${message.type}`);
        settle(message, true);
      }
    };

    const onClosed = (): void => {
      void logReview("info", "native review window closed");
      settle(null, false);
    };

    const onError = (error: Error): void => {
      void logReview("error", "native review window error", { message: error.message, stack: error.stack });
      if (settled) return;
      settled = true;
      cleanup();
      closeWindow(window);
      void handleBackgroundError(error);
    };

    window.on("message", onMessage);
    window.on("closed", onClosed);
    window.on("error", onError);

    ctx.ui.setStatus("diff-review", "Review window open");
    ctx.ui.notify("Opened native review window. Pi input remains available.", "info");
  }

  pi.registerCommand("diff-review", {
    description: "Open a native review window with git diff, last commit, all files, and optional main/master comparison scopes",
    handler: async (_args, ctx) => {
      await reviewRepository(ctx);
    },
  });

  pi.on("session_shutdown", async () => {
    closeActiveWindow();
  });
}
