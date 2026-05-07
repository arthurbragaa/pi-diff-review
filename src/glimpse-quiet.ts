import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { createInterface } from "node:readline";
import { getNativeHostInfo, supportsFollowCursor, type GlimpseInfo, type GlimpseOpenOptions, type GlimpseWindow } from "glimpseui";

type GlimpseProtocolMessage =
  | ({ type: "ready" | "info" } & GlimpseInfo)
  | { type: "message"; data: unknown }
  | { type: "click" }
  | { type: "closed" };

export type GlimpseStderrHandler = (line: string) => void;

class QuietGlimpseWindow extends EventEmitter {
  #proc: ChildProcessWithoutNullStreams;
  #closed = false;
  #pendingHTML: string | null;
  #info: GlimpseInfo | null = null;

  constructor(proc: ChildProcessWithoutNullStreams, initialHTML: string, onStderr?: GlimpseStderrHandler) {
    super();
    this.on("error", () => {});
    this.#proc = proc;
    this.#pendingHTML = initialHTML;

    proc.stdin.on("error", () => {});

    const stdout = createInterface({ input: proc.stdout, crlfDelay: Infinity });
    stdout.on("line", (line) => {
      let msg: GlimpseProtocolMessage;
      try {
        msg = JSON.parse(line) as GlimpseProtocolMessage;
      } catch {
        this.emit("error", new Error(`Malformed protocol line: ${line}`));
        return;
      }

      switch (msg.type) {
        case "ready":
          this.#info = {
            screen: msg.screen,
            screens: msg.screens,
            appearance: msg.appearance,
            cursor: msg.cursor,
            cursorTip: msg.cursorTip ?? null,
          };
          if (this.#pendingHTML != null) {
            this.setHTML(this.#pendingHTML);
            this.#pendingHTML = null;
          }
          this.emit("ready", this.#info);
          break;
        case "info":
          this.#info = {
            screen: msg.screen,
            screens: msg.screens,
            appearance: msg.appearance,
            cursor: msg.cursor,
            cursorTip: msg.cursorTip ?? null,
          };
          this.emit("info", this.#info);
          break;
        case "message":
          this.emit("message", msg.data);
          break;
        case "click":
          this.emit("click");
          break;
        case "closed":
          this.markClosed();
          break;
      }
    });

    const stderr = createInterface({ input: proc.stderr, crlfDelay: Infinity });
    stderr.on("line", (line) => {
      onStderr?.(line);
    });

    proc.on("error", (error) => this.emit("error", error));
    proc.on("exit", () => this.markClosed());
  }

  #write(obj: unknown): void {
    if (this.#closed) return;
    this.#proc.stdin.write(`${JSON.stringify(obj)}\n`);
  }

  private markClosed(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.emit("closed");
  }

  send(js: string): void {
    this.#write({ type: "eval", js });
  }

  setHTML(html: string): void {
    this.#write({ type: "html", html: Buffer.from(html).toString("base64") });
  }

  show(options: { title?: string } = {}): void {
    const message: { type: "show"; title?: string } = { type: "show" };
    if (options.title != null) message.title = options.title;
    this.#write(message);
  }

  close(): void {
    this.#write({ type: "close" });
  }

  loadFile(path: string): void {
    this.#write({ type: "file", path });
  }

  get info(): GlimpseInfo | null {
    return this.#info;
  }

  getInfo(): void {
    this.#write({ type: "get-info" });
  }

  followCursor(enabled: boolean, anchor?: string, mode?: string): void {
    const message: { type: "follow-cursor"; enabled: boolean; anchor?: string; mode?: string } = { type: "follow-cursor", enabled };
    if (anchor !== undefined) message.anchor = anchor;
    if (mode !== undefined) message.mode = mode;
    this.#write(message);
  }
}

function optionArgs(options: GlimpseOpenOptions, platform: ReturnType<typeof getNativeHostInfo>["platform"]): string[] {
  const args: string[] = [];
  if (options.width != null) args.push("--width", String(options.width));
  if (options.height != null) args.push("--height", String(options.height));
  if (options.title != null) args.push("--title", options.title);

  if (options.frameless) args.push("--frameless");
  if (options.floating) args.push("--floating");
  if (options.transparent) args.push("--transparent");
  if (options.clickThrough) args.push("--click-through");
  if (options.noDock) args.push("--no-dock");
  if (options.hidden) args.push("--hidden");
  if (options.autoClose) args.push("--auto-close");

  const supportsOpenLinks = platform === "darwin" || platform === "override";
  if (options.openLinks && supportsOpenLinks) args.push("--open-links");
  if (options.openLinksApp && supportsOpenLinks) args.push("--open-links-app", options.openLinksApp);

  if (options.followCursor && supportsFollowCursor()) args.push("--follow-cursor");

  if (options.x != null) args.push(`--x=${options.x}`);
  if (options.y != null) args.push(`--y=${options.y}`);

  if (options.cursorOffset?.x != null) args.push(`--cursor-offset-x=${options.cursorOffset.x}`);
  if (options.cursorOffset?.y != null) args.push(`--cursor-offset-y=${options.cursorOffset.y}`);
  if (options.cursorAnchor) args.push("--cursor-anchor", options.cursorAnchor);
  if (options.followMode != null) args.push("--follow-mode", options.followMode);

  return args;
}

export function openQuietGlimpse(html: string, options: GlimpseOpenOptions = {}, onStderr?: GlimpseStderrHandler): GlimpseWindow {
  const host = getNativeHostInfo();
  const spawnArgs = [...(host.extraArgs ?? []), ...optionArgs(options, host.platform)];
  const proc = spawn(host.path, spawnArgs, {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: process.platform === "win32",
  });

  return new QuietGlimpseWindow(proc, html, onStderr) as unknown as GlimpseWindow;
}
