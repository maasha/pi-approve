import { describe, it, expect, vi, beforeEach } from "vitest";
import { hunkKeyToAction, formatMenu, ReviewComponent } from "./component.ts";
import type { HunkActionDecision } from "./types.ts";
import type { FileChange, Hunk } from "./types.ts";
import type { GitOps, HunkView } from "./review.ts";

const makeView = (file: FileChange, hunk: Hunk): HunkView => ({
  file,
  hunk,
  hunkIndex: file.hunks.indexOf(hunk),
  status: "open",
  openFilePos: 1,
  openFileCount: 1,
});

describe("hunkKeyToAction", () => {
  it("maps a to accept", () => {
    expect(hunkKeyToAction("a")).toEqual<HunkActionDecision>({ action: "accept" });
  });
  it("does NOT default accept on return/enter", () => {
    expect(hunkKeyToAction("\r")).toBeNull();
    expect(hunkKeyToAction("\n")).toBeNull();
  });
  it("maps A (shift+a) to accept-all-in-file", () => {
    expect(hunkKeyToAction("A")).toEqual<HunkActionDecision>({ action: "accept-all-in-file" });
  });
  it("maps A via kitty CSI-u sequence to accept-all-in-file", () => {
    expect(hunkKeyToAction("\x1b[97;2u")).toEqual<HunkActionDecision>({ action: "accept-all-in-file" });
  });
  it("maps r to reject", () => {
    expect(hunkKeyToAction("r")).toEqual<HunkActionDecision>({ action: "reject" });
  });
  it("maps R (shift+r) to reject-all-in-file", () => {
    expect(hunkKeyToAction("R")).toEqual<HunkActionDecision>({ action: "reject-all-in-file" });
  });
  it("maps R via kitty CSI-u sequence to reject-all-in-file", () => {
    expect(hunkKeyToAction("\x1b[114;2u")).toEqual<HunkActionDecision>({ action: "reject-all-in-file" });
  });
  it("no longer maps f or d to file actions", () => {
    expect(hunkKeyToAction("f")).toBeNull();
    expect(hunkKeyToAction("d")).toBeNull();
  });
  it("maps v to revise", () => {
    expect(hunkKeyToAction("v")).toEqual<HunkActionDecision>({ action: "revise" });
  });
  it("maps the arrow keys to navigation", () => {
    expect(hunkKeyToAction("\x1b[A")).toEqual<HunkActionDecision>({ action: "navigate", dir: "prev-hunk" });
    expect(hunkKeyToAction("\x1b[B")).toEqual<HunkActionDecision>({ action: "navigate", dir: "next-hunk" });
    expect(hunkKeyToAction("\x1b[D")).toEqual<HunkActionDecision>({ action: "navigate", dir: "prev-file" });
    expect(hunkKeyToAction("\x1b[C")).toEqual<HunkActionDecision>({ action: "navigate", dir: "next-file" });
  });
  it("maps q or escape to quit", () => {
    expect(hunkKeyToAction("q")).toEqual<HunkActionDecision>({ action: "quit" });
    expect(hunkKeyToAction("\x1b")).toEqual<HunkActionDecision>({ action: "quit" });
  });
  it("ignores unrelated keys", () => {
    expect(hunkKeyToAction("z")).toBeNull();
    expect(hunkKeyToAction("x")).toBeNull();
  });
});

describe("formatMenu", () => {
  const theme = { fg: (_c: string, s: string) => s };
  const NAV = "[↑] prev hunk · [↓] next hunk · [←] prev file · [→] next file · [q] quit";
  const SCROLL = "[PgUp/PgDn] scroll · [Home] top · [End] bottom";

  it("renders three lines when there is enough width", () => {
    const lines = formatMenu(theme, 120);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe(
      "[a] accept hunk · [r] reject hunk · [A] accept file · [R] reject file · [v] revise",
    );
    expect(lines[1]).toBe(NAV);
    expect(lines[2]).toBe(SCROLL);
  });

  it("wraps the first line when the width is too small", () => {
    const lines = formatMenu(theme, 40);
    expect(lines).toHaveLength(4);
    // First line is split into two parts; nav and scroll lines are intact.
    expect(lines[2]).toBe(NAV);
    expect(lines[3]).toBe(SCROLL);
    const joined = lines.slice(0, 2).join(" · ");
    for (const item of [
      "[a] accept hunk",
      "[r] reject hunk",
      "[A] accept file",
      "[R] reject file",
      "[v] revise",
    ]) {
      expect(joined).toContain(item);
    }
    expect(lines.join("\n")).not.toContain("Esc");
  });

  it("documents PgUp/PgDn scrolling on a dedicated line", () => {
    expect(formatMenu(theme, 120)[2]).toContain("[PgUp/PgDn] scroll");
  });
});

// ---------------------------------------------------------------------------
// Regression: the `decide` callback handed to runReview must retain the
// component as `this`. Passing a bare method reference (e.g. `this.decide`)
// detaches `this` under strict-mode ESM, so the engine's call throws
//   "Cannot set properties of undefined (setting 'currentFile')"
// and crashes pi. We spy on runReview to capture the exact callback the
// component hands off, then invoke it the same way the engine does —
// with a detached receiver.
// ---------------------------------------------------------------------------
describe("ReviewComponent callback `this` binding (regression)", () => {
  let captured: {
    decide?: (v: HunkView) => Promise<HunkActionDecision>;
    git?: GitOps;
    component?: unknown;
  };

  beforeEach(async () => {
    captured = {};
    vi.resetModules();
    const reviewMod = await import("./review.ts");
    vi.spyOn(reviewMod, "runReview").mockImplementation(async (...args) => {
      captured.decide = args[1] as (v: HunkView) => Promise<HunkActionDecision>;
      captured.git = args[2] as GitOps;
      return {
        rejectedFiles: [],
        deletedFiles: [],
        acceptedHunks: 0,
        requestedReverts: [],
        skippedHunks: 0,
        quit: false,
        revised: null,
      };
    });
    // Import the component AFTER the spy is in place so its import of
    // `runReview` from the (now-reset) module resolves to the spy.
    const { ReviewComponent: Ctor } = await import("./component.ts");

    const file: FileChange = {
      path: "a.ts",
      untracked: false,
      kind: "modified",
      language: "plaintext",
      hunks: [{ header: null, lines: ["+x"], newStart: 1, oldStart: 0, oldCount: 0, newCount: 1 }],
    };
    const highlighter = {
      ensure: async () => {},
      highlightLine: async (l: string) => [[{ content: l }]],
    };

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const component = new Ctor(
      { requestRender: () => {}, terminal: { rows: 40 } } as never, // TUI
      { fg: (_c: string, s: string) => s } as never, // Theme
      null as never, // KeybindingsManager
      () => {}, // finish
      [file], // files
      {
        resetTracked: async () => {},
        removeUntracked: async () => {},
      }, // git
      highlighter as never, // Highlighter
    );
    captured.component = component;
  });

  // Return "resolved", "rejected:<name>", or "pending" after a short window.
  // A detached-`this` crash rejects the promise with a TypeError almost
  // immediately; the fixed code returns a promise that stays pending until
  // the user answers. Racing against a timer keeps the test fast and
  // avoids awaiting a promise that legitimately never settles.
  async function settle(p: Promise<unknown>, ms = 30): Promise<string> {
    return Promise.race([
      p.then(() => "resolved", (e) => `rejected:${e?.constructor?.name ?? typeof e}`),
      new Promise<string>((r) => setTimeout(() => r("pending"), ms)),
    ]);
  }

  it("decide() survives a detached-this call (waits for input, no TypeError)", async () => {
    const decide = captured.decide!;
    const file = {
      path: "a.ts",
      untracked: false,
      kind: "modified",
      language: "plaintext",
      hunks: [{ header: null, lines: ["+x"], newStart: 1, oldStart: 0, oldCount: 0, newCount: 1 }],
    } as FileChange;

    // Engine calls the captured reference without the component as receiver.
    const p = Promise.resolve().then(() => decide.call(undefined, makeView(file, file.hunks[0]!)));
    expect(await settle(p)).toBe("pending");
  });

  it("renders at the full terminal height (stable overlay position)", async () => {
    // Empty file list: runReview resolves immediately, so the component is
    // in the "done" phase and render() must pad to the terminal height.
    const component = captured.component as unknown as { render(w: number): string[] };
    const lines = component.render(100);
    expect(lines.length).toBe(40);
    expect(lines[0]!.startsWith("╭")).toBe(true);
    expect(lines[39]!.startsWith("╰")).toBe(true);
  });

  it("deciding the last hunk (accept) ends the review", async () => {
    // Sanity for the scrolling tests below: a plain "a" on the only hunk
    // resolves the pending decision the same way runReview's engine would.
    const component = captured.component as unknown as {
      handleInput(data: string): void;
    };
    const decide = captured.decide!;
    const file = {
      path: "a.ts",
      untracked: false,
      kind: "modified",
      language: "plaintext",
      hunks: [{ header: null, lines: ["+x"], newStart: 1, oldStart: 0, oldCount: 0, newCount: 1 }],
    } as FileChange;
    const p = Promise.resolve().then(() => decide.call(undefined, makeView(file, file.hunks[0]!)));
    const t = setTimeout(() => component.handleInput("a"), 10);
    expect(await p).toEqual<HunkActionDecision>({ action: "accept" });
    clearTimeout(t);
  });
});

// ---------------------------------------------------------------------------
// Diff scrolling: hunks taller than the overlay no longer truncate with an
// ellipsis — they scroll (PgUp/PgDn/Home/End, wheel in fullscreen) with a
// scrollbar drawn into the right border.
// ---------------------------------------------------------------------------
describe("ReviewComponent diff scrolling", () => {
  type Comp = {
    handleInput(data: string): void;
    handleMouse(event: unknown): unknown;
    render(w: number): string[];
    scrollTop: number;
    renderedLines: string[];
  };

  const W = 96; // inner 94: menu fits on two lines
  // Highlighted lines may carry ANSI codes, so assert on visible text.
  const plain = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");

  async function makeOverflowComponent(linesCount: number): Promise<{ comp: Comp; decide: (v: HunkView) => Promise<HunkActionDecision> }> {
    vi.resetModules();
    const reviewMod = await import("./review.ts");
    let capturedDecide: ((v: HunkView) => Promise<HunkActionDecision>) | undefined;
    vi.spyOn(reviewMod, "runReview").mockImplementation(async (...args) => {
      capturedDecide = args[1] as (v: HunkView) => Promise<HunkActionDecision>;
      // Never resolves: the test parks the component on the first hunk and
      // drives it directly (the engine loop is irrelevant for rendering).
      return new Promise<never>(() => {});
    });
    const { ReviewComponent: Ctor } = await import("./component.ts");
    const file: FileChange = {
      path: "a.ts",
      untracked: false,
      kind: "modified",
      language: "plaintext",
      hunks: [{
        header: null,
        lines: Array.from({ length: linesCount }, (_, i) => `+line${i}`),
        newStart: 1,
        oldStart: 0,
        oldCount: 0,
        newCount: linesCount,
      }],
    };
    const highlighter = {
      ensure: async () => {},
      highlightLine: async (l: string) => [[{ content: l }]],
    };
    const comp = new Ctor(
      { requestRender: () => {}, terminal: { rows: 20 } } as never, // TUI
      { fg: (_c: string, s: string) => s } as never, // Theme
      null as never, // KeybindingsManager
      () => {}, // finish
      [file], // files
      { resetTracked: async () => {}, removeUntracked: async () => {} }, // git
      highlighter as never, // Highlighter
    ) as unknown as Comp;
    // Park on the first hunk the same way runReview does; let the async
    // renderHunk() run before awaiting the (never-settling) decision.
    void capturedDecide!(makeView(file, file.hunks[0]!));
    await new Promise((r) => setTimeout(r, 0));
    return { comp, decide: capturedDecide! };
  }

  it("shows the first lines with a scrollbar and no ellipsis line", async () => {
    const { comp } = await makeOverflowComponent(50);
    const lines = comp.render(W);
    // 20 rows total; with a 3-line menu and no hunk header, the 8 diff rows
    // sit at lines 6..13.
    expect(lines).toHaveLength(20);
    const diffRows = lines.slice(6, 14);
    expect(diffRows[0]).toContain("+ line0");
    expect(diffRows[7]).toContain("+ line7");
    // No truncation marker anywhere.
    expect(lines.join("\n")).not.toContain("…");
    // 50 lines in an 8-row window: the thumb is round(8*8/50)=1 cell at the
    // top (┃), plain track (│) on the rest.
    expect(plain(diffRows[0]!)).toMatch(/┃$/);
    expect(diffRows.slice(1).every((l) => plain(l).endsWith("│"))).toBe(true);
  });

  it("PgUp clamps at the top, PgDn scrolls one viewport", async () => {
    const { comp } = await makeOverflowComponent(50);
    comp.render(W);
    comp.handleInput("\x1b[5~"); // pageUp
    expect(comp.scrollTop).toBe(0);
    comp.handleInput("\x1b[6~"); // pageDown (viewport 8, page 7)
    expect(comp.scrollTop).toBe(7);
    expect(comp.render(W)[6]).toContain("+ line7");
  });

  it("Home/End jump to the top and bottom", async () => {
    const { comp } = await makeOverflowComponent(50);
    comp.render(W);
    comp.handleInput("\x1b[8~"); // End (maxScrollTop = 50 - 8 = 42)
    expect(comp.scrollTop).toBe(42);
    const lines = comp.render(W);
    expect(lines[6]).toContain("+ line42");
    expect(lines[13]).toContain("+ line49");
    // At the bottom the 1-cell thumb sits on the last visible row.
    expect(lines.slice(6, 13).every((l) => plain(l).endsWith("│"))).toBe(true);
    expect(plain(lines[13]!)).toMatch(/┃$/);
    comp.handleInput("\x1b[H"); // Home
    expect(comp.scrollTop).toBe(0);
  });

  it("the wheel scrolls too", async () => {
    const { comp } = await makeOverflowComponent(50);
    comp.render(W);
    comp.handleMouse({ type: "wheel", wheelDelta: 4 });
    expect(comp.scrollTop).toBe(4);
    comp.handleMouse({ type: "wheel", wheelDelta: -2 });
    expect(comp.scrollTop).toBe(2);
    // Non-wheel events are ignored.
    expect(comp.handleMouse({ type: "click" })).toBeUndefined();
  });

  it("short hunks render unchanged (plain border, no scrollbar)", async () => {
    const { comp } = await makeOverflowComponent(5);
    const lines = comp.render(W);
    expect(lines[6]).toContain("+ line0");
    expect(lines[10]).toContain("+ line4");
    // Right border stays a plain │ on every diff row.
    expect(lines.slice(6, 11).every((l) => plain(l).endsWith("│"))).toBe(true);
  });

  it("scrolling never exceeds the content", async () => {
    const { comp } = await makeOverflowComponent(50);
    comp.render(W);
    for (let i = 0; i < 10; i++) comp.handleInput("\x1b[6~");
    expect(comp.scrollTop).toBe(42);
    for (let i = 0; i < 10; i++) comp.handleInput("\x1b[5~");
    expect(comp.scrollTop).toBe(0);
  });
});
