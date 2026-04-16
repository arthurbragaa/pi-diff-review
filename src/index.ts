import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { Key, matchesKey, truncateToWidth } from "@mariozechner/pi-tui";
import { open, type GlimpseWindow } from "glimpseui";
import { DEFAULT_BASE_REF, getReviewWindowData, loadReviewFileContents } from './git.js'
import { composeReviewPrompt } from './prompt.js'
import { loadReviewedFingerprints, updateReviewedFingerprint } from './review-state.js'
import type {
  ReviewCancelPayload,
  ReviewFile,
  ReviewFileContents,
  ReviewHostMessage,
  ReviewRequestFilePayload,
  ReviewSetReviewedPayload,
  ReviewSubmitPayload,
  ReviewWindowMessage,
} from './types.js'
import { buildReviewHtml } from './ui.js'

function isSubmitPayload(value: ReviewWindowMessage): value is ReviewSubmitPayload {
  return value.type === "submit";
}

function isCancelPayload(value: ReviewWindowMessage): value is ReviewCancelPayload {
  return value.type === "cancel";
}

function isRequestFilePayload(value: ReviewWindowMessage): value is ReviewRequestFilePayload {
  return value.type === 'request-file'
}

function isSetReviewedPayload(value: ReviewWindowMessage): value is ReviewSetReviewedPayload {
  return value.type === 'set-reviewed'
}

type WaitingEditorResult = "escape" | "window-settled";

function escapeForInlineScript(value: string): string {
  return value.replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026");
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
    if (activeWindow != null) {
      ctx.ui.notify("A review window is already open.", "warning");
      return;
    }

    const { repoRoot, files } = await getReviewWindowData(pi, ctx.cwd)
    if (files.length === 0) {
      ctx.ui.notify(`No branch changes found against ${DEFAULT_BASE_REF}.`, 'info')
      return
    }

    const reviewedFingerprints = await loadReviewedFingerprints(repoRoot)
    const initialReviewedFileIds = files
      .filter((file) => file.reviewFingerprint != null && reviewedFingerprints.has(file.reviewFingerprint))
      .map((file) => file.id)

    const html = buildReviewHtml({ repoRoot, files, baseRef: DEFAULT_BASE_REF, initialReviewedFileIds })
    const window = open(html, {
      width: 1680,
      height: 1020,
      title: `pi review • ${DEFAULT_BASE_REF}`,
    });
    activeWindow = window;

    const waitingUI = showWaitingUI(ctx)
    const fileMap = new Map(files.map((file) => [file.id, file]))
    const contentCache = new Map<string, Promise<ReviewFileContents>>()
    let reviewedStateWrite = Promise.resolve()

    const sendWindowMessage = (message: ReviewHostMessage): void => {
      if (activeWindow !== window) return
      const payload = escapeForInlineScript(JSON.stringify(message))
      window.send(`window.__reviewReceive(${payload});`)
    }

    const queueReviewedStateWrite = (message: ReviewSetReviewedPayload): void => {
      const file = fileMap.get(message.fileId)
      const fingerprint = file?.reviewFingerprint
      if (fingerprint == null) return

      reviewedStateWrite = reviewedStateWrite
        .then(() => updateReviewedFingerprint(repoRoot, fingerprint, message.reviewed))
        .catch((error) => {
          const messageText = error instanceof Error ? error.message : String(error)
          ctx.ui.notify(`Failed to save reviewed state: ${messageText}`, 'warning')
        })
    }

    const loadContents = (file: ReviewFile, scope: ReviewRequestFilePayload["scope"]): Promise<ReviewFileContents> => {
      const cacheKey = `${scope}:${file.id}`;
      const cached = contentCache.get(cacheKey);
      if (cached != null) return cached;

      const pending = loadReviewFileContents(pi, repoRoot, file, scope);
      contentCache.set(cacheKey, pending);
      return pending;
    };

    ctx.ui.notify(`Opened native review window against ${DEFAULT_BASE_REF}.`, "info");

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
          const file = fileMap.get(message.fileId);
          if (file == null) {
            sendWindowMessage({
              type: "file-error",
              requestId: message.requestId,
              fileId: message.fileId,
              scope: message.scope,
              message: "Unknown file requested.",
            });
            return;
          }

          try {
            const contents = await loadContents(file, message.scope);
            sendWindowMessage({
              type: "file-data",
              requestId: message.requestId,
              fileId: message.fileId,
              scope: message.scope,
              originalContent: contents.originalContent,
              modifiedContent: contents.modifiedContent,
            });
          } catch (error) {
            const messageText = error instanceof Error ? error.message : String(error);
            sendWindowMessage({
              type: "file-error",
              requestId: message.requestId,
              fileId: message.fileId,
              scope: message.scope,
              message: messageText,
            });
          }
        };

        const onMessage = (data: unknown): void => {
          const message = data as ReviewWindowMessage;
          if (isRequestFilePayload(message)) {
            void handleRequestFile(message)
            return
          }
          if (isSetReviewedPayload(message)) {
            queueReviewedStateWrite(message)
            return
          }
          if (isSubmitPayload(message) || isCancelPayload(message)) {
            settle(message)
          }
        };

        const onClosed = (): void => {
          settle(null);
        };

        const onError = (error: Error): void => {
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
        closeActiveWindow()
        await terminalMessagePromise.catch(() => null)
        await reviewedStateWrite
        ctx.ui.notify('Review cancelled.', 'info')
        return
      }

      const message = result.type === "window" ? result.message : await terminalMessagePromise;

      waitingUI.dismiss()
      await waitingUI.promise
      closeActiveWindow()
      await reviewedStateWrite

      if (message == null || message.type === 'cancel') {
        ctx.ui.notify('Review cancelled.', 'info')
        return
      }

      const prompt = composeReviewPrompt(files, message, DEFAULT_BASE_REF)
      ctx.ui.setEditorText(prompt)
      ctx.ui.notify('Inserted review feedback into the editor.', 'info')
    } catch (error) {
      activeWaitingUIDismiss?.();
      closeActiveWindow();
      const message = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(`Review failed: ${message}`, "error");
    }
  }

  pi.registerCommand("diff-review", {
    description: "Open a native review window for branch changes against origin/main",
    handler: async (_args, ctx) => {
      await reviewRepository(ctx);
    },
  });

  pi.on("session_shutdown", async () => {
    activeWaitingUIDismiss?.();
    closeActiveWindow();
  });
}
