import { readdirSync, statSync } from "node:fs";
import { appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { Key, matchesKey, truncateToWidth } from "@mariozechner/pi-tui";
import { open, type GlimpseWindow } from "glimpseui";
import { explainReviewFile, explanationTitle, type ExplanationSelection } from "./explain.js";
import { getReviewWindowData, loadReviewFileContents } from "./git.js";
import { composeReviewPrompt } from "./prompt.js";
import { loadReviewedFiles, saveReviewedFiles } from "./review-state.js";
import type {
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

const LOG_PATH = "/tmp/pi-diff-review.log";

type WaitingEditorResult = "escape" | "window-settled";

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

function tailText(value: string, maxLines: number): string {
  const lines = value.split(/\r?\n/);
  return lines.slice(Math.max(0, lines.length - maxLines)).join("\n").trim();
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

export default function (pi: ExtensionAPI) {
  let activeWindow: GlimpseWindow | null = null;
  let activeWaitingUIDismiss: (() => void) | null = null;

  function closeActiveWindow(): void {
    if (activeWindow == null) return;
    const windowToClose = activeWindow;
    activeWindow = null;
    try {
      windowToClose.close();
    } catch {}
  }

  function showWaitingUI(ctx: ExtensionCommandContext): {
    promise: Promise<WaitingEditorResult>;
    dismiss: () => void;
  } {
    let settled = false;
    let doneFn: ((result: WaitingEditorResult) => void) | null = null;
    let pendingResult: WaitingEditorResult | null = null;

    const finish = (result: WaitingEditorResult): void => {
      if (settled) return;
      settled = true;
      if (activeWaitingUIDismiss === dismiss) {
        activeWaitingUIDismiss = null;
      }
      if (doneFn != null) {
        doneFn(result);
      } else {
        pendingResult = result;
      }
    };

    const promise = ctx.ui.custom<WaitingEditorResult>((_tui, theme, _kb, done) => {
      doneFn = done;
      if (pendingResult != null) {
        const result = pendingResult;
        pendingResult = null;
        queueMicrotask(() => done(result));
      }

      return {
        render(width: number): string[] {
          const innerWidth = Math.max(24, width - 2);
          const borderTop = theme.fg("border", `╭${"─".repeat(innerWidth)}╮`);
          const borderBottom = theme.fg("border", `╰${"─".repeat(innerWidth)}╯`);
          const lines = [
            theme.fg("accent", theme.bold("Waiting for review")),
            "The native review window is open.",
            "Press Escape to cancel and close the review window.",
          ];
          return [
            borderTop,
            ...lines.map((line) => `${theme.fg("border", "│")}${truncateToWidth(line, innerWidth, "...", true).padEnd(innerWidth, " ")}${theme.fg("border", "│")}`),
            borderBottom,
          ];
        },
        handleInput(data: string): void {
          if (matchesKey(data, Key.escape)) {
            finish("escape");
          }
        },
        invalidate(): void {},
      };
    });

    const dismiss = (): void => {
      finish("window-settled");
    };

    activeWaitingUIDismiss = dismiss;

    return {
      promise,
      dismiss,
    };
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
    const window = open(html, {
      width: 1680,
      height: 1020,
      title: "pi review",
    });
    activeWindow = window;
    await logReview("info", "native review window opened", { logPath: LOG_PATH });

    const waitingUI = showWaitingUI(ctx);
    const fileMap = new Map(files.map((file) => [file.id, file]));
    const contentCache = new Map<string, Promise<ReviewFileContents>>();

    const sendWindowMessage = (message: ReviewHostMessage): void => {
      if (activeWindow !== window) return;
      const payload = escapeForInlineScript(JSON.stringify(message));
      window.send(`window.__reviewReceive(${payload});`);
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

    ctx.ui.notify("Opened native review window.", "info");

    try {
      const terminalMessagePromise = new Promise<ReviewSubmitPayload | ReviewCancelPayload | null>((resolve, reject) => {
        let settled = false;

        const cleanup = (): void => {
          window.removeListener("message", onMessage);
          window.removeListener("closed", onClosed);
          window.removeListener("error", onError);
          if (activeWindow === window) {
            activeWindow = null;
          }
        };

        const settle = (value: ReviewSubmitPayload | ReviewCancelPayload | null): void => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve(value);
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

        const onMessage = (data: unknown): void => {
          const message = data as ReviewWindowMessage;
          if (isClientLogPayload(message)) {
            void logReview(message.level, `client: ${message.message}`, message.details);
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
            settle(message);
          }
        };

        const onClosed = (): void => {
          void logReview("info", "native review window closed");
          settle(null);
        };

        const onError = (error: Error): void => {
          void logReview("error", "native review window error", { message: error.message, stack: error.stack });
          if (settled) return;
          settled = true;
          cleanup();
          reject(error);
        };

        window.on("message", onMessage);
        window.on("closed", onClosed);
        window.on("error", onError);
      });

      const result = await Promise.race([
        terminalMessagePromise.then((message) => ({ type: "window" as const, message })),
        waitingUI.promise.then((reason) => ({ type: "ui" as const, reason })),
      ]);

      if (result.type === "ui" && result.reason === "escape") {
        closeActiveWindow();
        await terminalMessagePromise.catch(() => null);
        ctx.ui.notify("Review cancelled.", "info");
        return;
      }

      const message = result.type === "window" ? result.message : await terminalMessagePromise;

      waitingUI.dismiss();
      await waitingUI.promise;
      closeActiveWindow();

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
      ctx.ui.setEditorText(prompt);
      ctx.ui.notify("Inserted review feedback into the editor.", "info");
    } catch (error) {
      activeWaitingUIDismiss?.();
      closeActiveWindow();
      const message = error instanceof Error ? error.message : String(error);
      await logReview("error", "review failed", { message, stack: error instanceof Error ? error.stack : undefined });
      ctx.ui.notify(`Review failed: ${message}`, "error");
    }
  }

  pi.registerCommand("diff-review", {
    description: "Open a native review window with git diff, last commit, all files, and optional main/master comparison scopes",
    handler: async (_args, ctx) => {
      await reviewRepository(ctx);
    },
  });

  pi.registerCommand("diff-review-log", {
    description: "Insert the tail of the pi diff review log into the editor",
    handler: async (args, ctx) => {
      const maxLines = Number.parseInt(args.trim(), 10) || 120;
      try {
        const log = await readFile(LOG_PATH, "utf8");
        ctx.ui.setEditorText(tailText(log, Math.max(20, Math.min(500, maxLines))));
        ctx.ui.notify(`Inserted ${LOG_PATH} into the editor.`, "info");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`No diff review log found at ${LOG_PATH}: ${message}`, "warning");
      }
    },
  });

  pi.on("session_shutdown", async () => {
    activeWaitingUIDismiss?.();
    closeActiveWindow();
  });
}
