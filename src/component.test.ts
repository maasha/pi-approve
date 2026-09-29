import { describe, it, expect, vi, beforeEach } from "vitest";
import { hunkKeyToAction, confirmKeyToChoice, ReviewComponent } from "./component.ts";
import type { HunkActionDecision } from "./types.ts";
import type { FileChange, Hunk } from "./types.ts";
import type { GitOps } from "./review.ts";

describe("hunkKeyToAction", () => {
  it("maps a to accept", () => {
    expect(hunkKeyToAction("a")).toEqual<HunkActionDecision>({ action: "accept" });
  });
  it("maps return/enter to accept (default)", () => {
    expect(hunkKeyToAction("\r")).toEqual<HunkActionDecision>({ action: "accept" });
  });
  it("maps f to accept-all-in-file", () => {
    expect(hunkKeyToAction("f")).toEqual<HunkActionDecision>({ action: "accept-all-in-file" });
  });
  it("maps r to reject", () => {
    expect(hunkKeyToAction("r")).toEqual<HunkActionDecision>({ action: "reject" });
  });
  it("maps d to reject-all-in-file", () => {
    expect(hunkKeyToAction("d")).toEqual<HunkActionDecision>({ action: "reject-all-in-file" });
  });
  it("maps v to revise", () => {
    expect(hunkKeyToAction("v")).toEqual<HunkActionDecision>({ action: "revise" });
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

describe("confirmKeyToChoice", () => {
  it("y maps to true", () => {
    expect(confirmKeyToChoice("y")).toBe(true);
  });
  it("return maps to true (default yes)", () => {
    expect(confirmKeyToChoice("\r")).toBe(true);
  });
  it("n or escape maps to false", () => {
    expect(confirmKeyToChoice("n")).toBe(false);
    expect(confirmKeyToChoice("\x1b")).toBe(false);
  });
  it("ignores unrelated keys", () => {
    expect(confirmKeyToChoice("z")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Regression: the `decide` and `confirmDiscardStaged` callbacks handed to
// runReview must retain the component as `this`. Passing a bare method
// reference (e.g. `this.decide`) detaches `this` under strict-mode ESM, so
// the engine's call throws
//   "Cannot set properties of undefined (setting 'currentFile')"
// and crashes pi. We spy on runReview to capture the exact callbacks the
// component hands off, then invoke them the same way the engine does —
// with a detached receiver.
// ---------------------------------------------------------------------------
describe("ReviewComponent callback `this` binding (regression)", () => {
  let captured: {
    decide?: (f: FileChange, h: Hunk) => Promise<HunkActionDecision>;
    git?: GitOps;
  };

  beforeEach(async () => {
    captured = {};
    vi.resetModules();
    const reviewMod = await import("./review.ts");
    vi.spyOn(reviewMod, "runReview").mockImplementation(async (...args) => {
      captured.decide = args[2] as (f: FileChange, h: Hunk) => Promise<HunkActionDecision>;
      captured.git = args[3] as GitOps;
      return {
        rejectedFiles: [],
        deletedFiles: [],
        acceptedHunks: 0,
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
      hunks: [{ header: null, lines: ["+x"], newStart: 1 }],
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
      new Set(), // stagedPaths
      {
        resetTracked: async () => {},
        removeUntracked: async () => {},
        confirmDiscardStaged: async () => true,
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
      hunks: [{ header: null, lines: ["+x"], newStart: 1 }],
    } as FileChange;

    // Engine calls the captured reference without the component as receiver.
    const p = Promise.resolve().then(() => decide.call(undefined, file, file.hunks[0]!));
    expect(await settle(p)).toBe("pending");
  });

  it("confirmDiscardStaged() survives a detached-this call (waits for input, no TypeError)", async () => {
    const confirm = captured.git!.confirmDiscardStaged;
    const p = Promise.resolve().then(() => confirm.call(undefined, "a.ts"));
    expect(await settle(p)).toBe("pending");
  });
});
