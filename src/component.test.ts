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

  it("renders two lines when there is enough width", () => {
    const lines = formatMenu(theme, 120);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe(
      "[a] accept hunk · [r] reject hunk · [A] accept file · [R] reject file · [v] revise",
    );
    expect(lines[1]).toBe(NAV);
  });

  it("wraps the first line when the width is too small", () => {
    const lines = formatMenu(theme, 40);
    expect(lines).toHaveLength(3);
    // First line is split into two parts; nav line is intact and last.
    expect(lines[2]).toBe(NAV);
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
        rejectedHunks: [],
        deletedFiles: [],
        acceptedHunks: 0,
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
    new Ctor(
      { requestRender: () => {} } as never, // TUI
      { fg: (_c: string, s: string) => s } as never, // Theme
      null as never, // KeybindingsManager
      () => {}, // finish
      [file], // files
      {
        rejectHunk: async () => true,
        resetTracked: async () => {},
        removeUntracked: async () => {},
      }, // git
      highlighter as never, // Highlighter
    );
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
});
