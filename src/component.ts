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
import type { GitOps, ReviewSummary } from "./review.ts";
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
  if (matchesKey(data, "return")) return { action: "accept" }; // Enter = default accept
  if (matchesKey(data, "a")) return { action: "accept" };
  if (matchesKey(data, "f")) return { action: "accept-all-in-file" };
  if (matchesKey(data, "r")) return { action: "reject" };
  if (matchesKey(data, "d")) return { action: "reject-all-in-file" };
  if (matchesKey(data, "v")) return { action: "revise" };
  if (matchesKey(data, "q") || matchesKey(data, "escape")) return { action: "quit" };
  return null;
}

/** Map a keystroke during the staged-changes confirmation to yes/no, or null. */
export function confirmKeyToChoice(data: string): boolean | null {
  if (matchesKey(data, "y") || matchesKey(data, "return")) return true;
  if (matchesKey(data, "n") || matchesKey(data, "escape")) return false;
  return null;
}

type Phase = "busy" | "hunk" | "revise" | "confirm" | "done";

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
  private renderedLines: string[] = [];

  private reviseText = "";
  private reviseCursor = 0;

  private confirmPath: string | null = null;

  private pendingDecide: ((d: HunkActionDecision) => void) | null = null;
  private pendingConfirm: ((b: boolean) => void) | null = null;

  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly _keybindings: KeybindingsManager,
    private readonly finish: (result: ReviewResult | undefined) => void,
    private readonly files: FileChange[],
    private readonly stagedPaths: Set<string>,
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
    const summary = await runReview(
      this.files,
      this.stagedPaths,
      this.decide.bind(this),
      { ...this.git, confirmDiscardStaged: this.confirmDiscardStaged.bind(this) },
    );
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

  private async decide(file: FileChange, hunk: Hunk): Promise<HunkActionDecision> {
    this.currentFile = file;
    this.currentHunk = hunk;
    this.currentHunkIndex = file.hunks.indexOf(hunk);
    this.phase = "busy";
    this.renderedLines = await this.renderHunk(file, hunk);
    this.phase = "hunk";
    this.requestRender();
    return new Promise<HunkActionDecision>((resolve) => {
      this.pendingDecide = resolve;
    });
  }

  private async confirmDiscardStaged(path: string): Promise<boolean> {
    this.confirmPath = path;
    this.phase = "confirm";
    this.requestRender();
    return new Promise<boolean>((resolve) => {
      this.pendingConfirm = resolve;
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

      case "confirm": {
        const choice = confirmKeyToChoice(data);
        if (choice === null) return;
        this.phase = "busy";
        this.requestRender();
        const p = this.pendingConfirm;
        this.pendingConfirm = null;
        p?.(choice);
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
    if (this.phase === "hunk" && file && this.currentHunk) {
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
      lines.push(
        box(
          ` ${this.theme.fg("success", "[a]ccept")} ${this.theme.fg("dim", "default: ")}${this.theme.fg("success", "accept")}`,
        ),
      );
      lines.push(
        box(
          ` ${this.theme.fg("success", "[f]")} accept file · ${this.theme.fg("error", "[r]")} reject · ${this.theme.fg("error", "[d]")} reject file`,
        ),
      );
      lines.push(
        box(
          ` ${this.theme.fg("warning", "[v]")} revise · ${this.theme.fg("dim", "[q]")} quit · ${this.theme.fg("dim", "Esc")}`,
        ),
      );
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
    } else if (this.phase === "confirm" && this.confirmPath) {
      lines.push(box(` ${this.theme.fg("warning", "⚠ Staged changes warning")}`));
      lines.push(box(` ${this.theme.fg("text", this.confirmPath)}`));
      lines.push(box(""));
      lines.push(
        box(
          ` ${this.theme.fg("error", "This file has staged (already approved) changes.")}`,
        ),
      );
      lines.push(
        box(` ${this.theme.fg("error", "Rejecting it will discard those staged changes.")}`),
      );
      lines.push(box(""));
      lines.push(
        box(
          ` ${this.theme.fg("success", "[y]")} yes, discard · ${this.theme.fg("dim", "[n]")} no (skip)` +
            ` ${this.theme.fg("dim", "(Esc)")}`,
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
    if (this.stagedPaths.has(file.path)) parts.push("has staged changes");
    return `${parts.join(" · ")} — hunk ${this.currentHunkIndex + 1}/${file.hunks.length}`;
  }

  invalidate(): void {}
  dispose(): void {
    if (!this.doneCalled) {
      this.doneCalled = true;
      this.finish(undefined);
    }
  }
}
