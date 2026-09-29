import type {
  Component,
  Focusable,
  KeybindingsManager,
  TUI,
} from "@earendil-works/pi-tui";
import {
  CURSOR_MARKER,
  matchesKey,
  visibleWidth,
} from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { FileChange, Hunk, HunkActionDecision } from "./types.ts";
import type { GitOps, ReviewSummary, HunkView } from "./review.ts";
import { runReview } from "./review.ts";
import { buildReviseMessage } from "./revise.ts";
import type { Highlighter } from "./highlight.ts";
import { renderDiffLine } from "./render.ts";

/** The result delivered when the review overlay closes. */
export interface ReviewResult {
  summary: ReviewSummary;
  /** The user message to send to the model on a revise, or null. */
  revisedMessage: string | null;
}

/** Map a single keystroke during the hunk view to a decision, or null to ignore. */
export function hunkKeyToAction(data: string): HunkActionDecision | null {
  if (matchesKey(data, "a")) return { action: "accept" };
  if (matchesKey(data, "shift+a")) return { action: "accept-all-in-file" };
  if (matchesKey(data, "r")) return { action: "reject" };
  if (matchesKey(data, "shift+r")) return { action: "reject-all-in-file" };
  if (matchesKey(data, "v")) return { action: "revise" };
  if (matchesKey(data, "up")) return { action: "navigate", dir: "prev-hunk" };
  if (matchesKey(data, "down")) return { action: "navigate", dir: "next-hunk" };
  if (matchesKey(data, "left")) return { action: "navigate", dir: "prev-file" };
  if (matchesKey(data, "right")) return { action: "navigate", dir: "next-file" };
  if (matchesKey(data, "q") || matchesKey(data, "escape")) return { action: "quit" };
  return null;
}

/**
 * Render the key-binding menu: a decision line and a navigation line.
 * The decision line fits on one line when `innerWidth` is wide enough;
 * otherwise it wraps after "[A] accept file". Esc is intentionally not
 * shown (it still quits); it is documented in the README instead.
 */
export function formatMenu(theme: { fg(color: string, text: string): string }, innerWidth: number): string[] {
  const items = [
    theme.fg("success", "[a] accept hunk"),
    theme.fg("error", "[r] reject hunk"),
    theme.fg("success", "[A] accept file"),
    theme.fg("error", "[R] reject file"),
    theme.fg("warning", "[v] revise"),
  ];
  const sep = theme.fg("dim", " · ");
  const whole = items.join(sep);
  const firstLine = visibleWidth(whole) <= innerWidth
    ? [whole]
    : [items.slice(0, 3).join(sep), items.slice(3).join(sep)];
  const nav = [
    "[↑] prev hunk",
    "[↓] next hunk",
    "[←] prev file",
    "[→] next file",
    "[q] quit",
  ]
    .map((s) => theme.fg("dim", s))
    .join(theme.fg("dim", " · "));
  return [...firstLine, nav];
}

type Phase = "busy" | "hunk" | "revise" | "done";

/**
 * The interactive review overlay. It drives the (unit-tested) `runReview`
 * engine, feeding it a `decide` callback that pauses for the user's keystroke.
 * Git mutations happen through the injectable `git` ops; the overlay only owns
 * presentation.
 */
export class ReviewComponent implements Component, Focusable {
  focused = false;

  private phase: Phase = "busy";
  private doneCalled = false;

  private currentFile: FileChange | null = null;
  private currentHunk: Hunk | null = null;
  private currentHunkIndex = 0;
  private currentStatus: HunkView["status"] = "open";
  private openFilePos = 1;
  private openFileCount = 1;
  private renderedLines: string[] = [];

  private reviseText = "";
  private reviseCursor = 0;

  private pendingDecide: ((d: HunkActionDecision) => void) | null = null;

  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly _keybindings: KeybindingsManager,
    private readonly finish: (result: ReviewResult | undefined) => void,
    private readonly files: FileChange[],
    private readonly git: GitOps,
    private readonly highlighter: Highlighter,
  ) {
    // Preload the highlighter for every non-plaintext language up front so the
    // first hunk renders immediately instead of stalling on a grammar fetch.
    const langs = [...new Set(files.map((f) => f.language).filter((l) => l !== "plaintext"))];
    this.highlighter.ensure(langs).catch(() => {});
    void this.start();
  }

  private requestRender(): void {
    this.tui?.requestRender?.();
  }

  private async start(): Promise<void> {
    // Bind explicitly: passing a bare method reference (`this.decide`) would
    // detach `this` in strict-mode ESM and crash when the engine invokes it.
    const summary = await runReview(this.files, this.decide.bind(this), this.git);
    let revisedMessage: string | null = null;
    if (summary.revised) {
      const { file, hunk, feedback } = summary.revised;
      revisedMessage = buildReviseMessage(file, feedback, hunk.lines);
    }
    this.phase = "done";
    this.requestRender();
    if (!this.doneCalled) {
      this.doneCalled = true;
      this.finish({ summary, revisedMessage });
    }
  }

  private async decide(view: HunkView): Promise<HunkActionDecision> {
    this.currentFile = view.file;
    this.currentHunk = view.hunk;
    this.currentHunkIndex = view.hunkIndex;
    this.currentStatus = view.status;
    this.openFilePos = view.openFilePos;
    this.openFileCount = view.openFileCount;
    this.phase = "busy";
    this.renderedLines = await this.renderHunk(view.file, view.hunk);
    this.phase = "hunk";
    this.requestRender();
    return new Promise<HunkActionDecision>((resolve) => {
      this.pendingDecide = resolve;
    });
  }

  private async renderHunk(file: FileChange, hunk: Hunk): Promise<string[]> {
    if (hunk.binary) return [this.theme.fg("warning", "  [Binary file] — no preview")];
    const out: string[] = [];
    for (const raw of hunk.lines) {
      const prefix = raw === "\\" ? " " : raw[0];
      const body = raw.startsWith("\\") ? raw : raw.slice(1);
      const tokens = await this.highlighter.highlightLine(body, file.language);
      out.push(renderDiffLine(tokens, prefix, this.theme));
    }
    return out;
  }

  handleInput(data: string): void {
    switch (this.phase) {
      case "hunk": {
        const decision = hunkKeyToAction(data);
        if (!decision) return;
        // Decision keys are inert on an already-decided hunk (it can only be
        // navigated to or quit from); navigation always works.
        if (decision.action !== "navigate" && this.currentStatus !== "open") return;
        if (decision.action === "revise") {
          this.reviseText = "";
          this.reviseCursor = 0;
          this.phase = "revise";
          this.requestRender();
          return;
        }
        this.phase = "busy";
        this.requestRender();
        const p = this.pendingDecide;
        this.pendingDecide = null;
        p?.(decision);
        return;
      }

      case "revise": {
        if (matchesKey(data, "return")) {
          const feedback = this.reviseText;
          this.phase = "busy";
          this.requestRender();
          const p = this.pendingDecide;
          this.pendingDecide = null;
          p?.({ action: "revise", feedback });
          return;
        }
        if (matchesKey(data, "escape")) {
          // Abandon the revise prompt; return to the hunk decision view.
          this.phase = "hunk";
          this.requestRender();
          return;
        }
        if (matchesKey(data, "backspace")) {
          if (this.reviseCursor > 0) {
            this.reviseText =
              this.reviseText.slice(0, this.reviseCursor - 1) +
              this.reviseText.slice(this.reviseCursor);
            this.reviseCursor--;
          }
        } else if (data.length === 1 && data.charCodeAt(0) >= 32) {
          this.reviseText =
            this.reviseText.slice(0, this.reviseCursor) +
            data +
            this.reviseText.slice(this.reviseCursor);
          this.reviseCursor++;
        }
        this.requestRender();
        return;
      }

      default:
        return;
    }
  }

  render(viewportWidth: number): string[] {
    // Span the full overlay width (the pi terminal), with a sane floor.
    const w = Math.max(40, viewportWidth);
    const inner = w - 2;
    const box = (s: string): string => {
      const vis = visibleWidth(s);
      return (
        this.theme.fg("border", "│") +
        s +
        " ".repeat(Math.max(0, inner - vis)) +
        this.theme.fg("border", "│")
      );
    };
    const top = this.theme.fg("border", `╭${"─".repeat(inner)}╮`);
    const bottom = this.theme.fg("border", `╰${"─".repeat(inner)}╯`);

    const lines: string[] = [];
    lines.push(top);
    lines.push(box(` ${this.theme.fg("accent", "⚖  Approve review")}`));
    lines.push(box(""));

    const file = this.currentFile;
    if ((this.phase === "hunk" || this.phase === "busy") && file && this.currentHunk) {
      lines.push(box(` ${this.theme.fg("text", file.path)}`));
      const meta = this.metaLine(file);
      lines.push(box(` ${this.theme.fg("dim", meta)}`));
      if (this.currentHunk.header) {
        lines.push(box(` ${this.theme.fg("dim", this.currentHunk.header)}`));
      }
      lines.push(box(""));
      for (const l of this.renderedLines) {
        lines.push(box(l));
      }
      lines.push(box(""));
      for (const menuLine of formatMenu(this.theme, inner)) {
        lines.push(box(` ${menuLine}`));
      }
      lines.push(box(""));
    } else if (this.phase === "revise" && file) {
      lines.push(box(` ${this.theme.fg("text", file.path)}`));
      lines.push(box(""));
      const marker = this.focused ? CURSOR_MARKER : "";
      const before = this.reviseText.slice(0, this.reviseCursor);
      const at = this.reviseCursor < this.reviseText.length ? this.reviseText[this.reviseCursor] : " ";
      const after = this.reviseCursor < this.reviseText.length ? this.reviseText.slice(this.reviseCursor + 1) : "";
      const inputLine = `${before}${marker}\x1b[7m${at}\x1b[27m${after}`;
      lines.push(box(` ${this.theme.fg("warning", "Revise — feedback:")} ${inputLine}`));
      lines.push(box(""));
      lines.push(
        box(
          ` ${this.theme.fg("dim", "Enter")}: send · ${this.theme.fg("dim", "Esc")}: back to hunk`,
        ),
      );
      lines.push(box(""));
    } else if (this.phase === "busy") {
      lines.push(box(` ${this.theme.fg("dim", "…")}`));
      lines.push(box(""));
    } else if (this.phase === "done") {
      lines.push(box(` ${this.theme.fg("success", "Review complete.")}`));
      lines.push(box(""));
    }

    lines.push(bottom);
    return lines;
  }

  private metaLine(file: FileChange): string {
    const parts: string[] = [];
    if (file.untracked) parts.push("untracked");
    parts.push(file.kind);
    let meta = `${parts.join(" · ")} — hunk ${this.currentHunkIndex + 1}/${file.hunks.length}`;
    if (this.openFileCount > 0) {
      meta += ` · file ${this.openFilePos}/${this.openFileCount}`;
    }
    if (this.currentStatus !== "open") {
      meta += ` · [${this.currentStatus}]`;
    }
    return meta;
  }

  invalidate(): void {}
  dispose(): void {
    // Never leave the engine suspended.
    if (this.pendingDecide) {
      const p = this.pendingDecide;
      this.pendingDecide = null;
      p({ action: "quit" });
    }
    if (!this.doneCalled) {
      this.doneCalled = true;
      this.finish(undefined);
    }
  }
}
