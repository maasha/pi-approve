import { describe, it, expect, vi } from "vitest";
import { runReview } from "./review.ts";
import type { FileChange, Hunk, HunkActionDecision } from "./types.ts";

function file(
  path: string,
  hunks: Hunk[],
  opts: { untracked?: boolean } = {},
): FileChange {
  return {
    path,
    untracked: !!opts.untracked,
    kind: "modified",
    language: "plaintext",
    hunks,
  };
}

function hunk(lines: string[], i: number): Hunk {
  return { header: null, lines, newStart: i };
}

function makeGit() {
  const resetTracked = vi.fn(async () => {});
  const removeUntracked = vi.fn(async () => {});
  const confirmDiscardStaged = vi.fn(async () => true);
  return { git: { resetTracked, removeUntracked, confirmDiscardStaged }, resetTracked, removeUntracked, confirmDiscardStaged };
}

function decideSeq(actions: HunkActionDecision["action"][]) {
  let i = 0;
  return async (_f: FileChange, _h: Hunk): Promise<HunkActionDecision> => ({
    action: actions[i++]!,
  });
}

describe("runReview", () => {
  it("accepting all hunks across files keeps everything on disk", async () => {
    const { git, resetTracked, removeUntracked } = makeGit();
    const a = file("a.txt", [hunk(["+1"], 1), hunk(["+2"], 2)]);
    const b = file("b.txt", [hunk(["+3"], 1)]);
    const s = await runReview([a, b], new Set(), decideSeq(["accept", "accept", "accept"]), git);
    expect(s.acceptedHunks).toBe(3);
    expect(s.quit).toBe(false);
    expect(s.revised).toBeNull();
    expect(resetTracked).not.toHaveBeenCalled();
    expect(removeUntracked).not.toHaveBeenCalled();
  });

  it("rejecting a tracked file resets it and skips remaining hunks", async () => {
    const { git, resetTracked } = makeGit();
    const a = file("a.txt", [hunk(["+1"], 1), hunk(["+2"], 2), hunk(["+3"], 3)]);
    const asked: number[] = [];
    const decide = async (_f: FileChange, h: Hunk) => {
      asked.push(h.newStart);
      return h.newStart === 2 ? ({ action: "reject" } as const) : ({ action: "accept" } as const);
    };
    const s = await runReview([a], new Set(), decide, git);
    expect(resetTracked).toHaveBeenCalledTimes(1);
    expect(resetTracked).toHaveBeenCalledWith("a.txt");
    // Hunk 3 should have been skipped after reset.
    expect(asked).toEqual([1, 2]);
    expect(s.rejectedFiles).toEqual(["a.txt"]);
  });

  it("rejecting an untracked file deletes it", async () => {
    const { git, removeUntracked } = makeGit();
    const n = file("new.ts", [hunk(["+x"], 1)], { untracked: true });
    const s = await runReview([n], new Set(), decideSeq(["reject"]), git);
    expect(removeUntracked).toHaveBeenCalledWith("new.ts");
    expect(s.deletedFiles).toEqual(["new.ts"]);
  });

  it("warns and confirms before rejecting a tracked file with staged changes", async () => {
    const { git, resetTracked, confirmDiscardStaged } = makeGit();
    const a = file("a.txt", [hunk(["+1"], 1)]);
    const s = await runReview([a], new Set(["a.txt"]), decideSeq(["reject"]), git);
    expect(confirmDiscardStaged).toHaveBeenCalledWith("a.txt");
    expect(resetTracked).toHaveBeenCalledWith("a.txt");
  });

  it("skips a hunk (leaves file unchanged) if the user declines to discard staged changes", async () => {
    const { git, resetTracked, confirmDiscardStaged } = makeGit();
    confirmDiscardStaged.mockResolvedValue(false);
    const a = file("a.txt", [hunk(["+1"], 1), hunk(["+2"], 2)]);
    const asked: number[] = [];
    const decide = async (_f: FileChange, h: Hunk) => {
      asked.push(h.newStart);
      return h.newStart === 1 ? ({ action: "reject" } as const) : ({ action: "accept" } as const);
    };
    const s = await runReview([a], new Set(["a.txt"]), decide, git);
    expect(resetTracked).not.toHaveBeenCalled();
    // hunk 1 declined, so hunk 2 is still reviewed and accepted
    expect(asked).toEqual([1, 2]);
    expect(s.acceptedHunks).toBe(1);
    expect(s.rejectedFiles).toEqual([]);
  });

  it("accept-all-in-file accepts the rest of the file and advances", async () => {
    const { git } = makeGit();
    const a = file("a.txt", [hunk(["+1"], 1), hunk(["+2"], 2), hunk(["+3"], 3)]);
    const b = file("b.txt", [hunk(["+4"], 1)]);
    const asked: string[] = [];
    const decide = async (f: FileChange, _h: Hunk) => {
      asked.push(f.path);
      return f.path === "a.txt" ? ({ action: "accept-all-in-file" } as const) : ({ action: "accept" } as const);
    };
    const s = await runReview([a, b], new Set(), decide, git);
    // only the first hunk of a.txt should be prompted; rest are implicit
    expect(asked.filter((p) => p === "a.txt")).toHaveLength(1);
    expect(s.acceptedHunks).toBe(4); // 3 from a.txt (1 explicit + 2 implicit) + 1 from b.txt
  });

  it("revise ends the review and records the hunk and feedback", async () => {
    const { git } = makeGit();
    const a = file("a.txt", [hunk(["+1"], 1), hunk(["+2"], 2)]);
    const target = a.hunks[1]!;
    const decide = async (_f: FileChange, h: Hunk) =>
      h === target
        ? ({ action: "revise", feedback: "use camelCase" } as const)
        : ({ action: "accept" } as const);
    const s = await runReview([a], new Set(), decide, git);
    expect(s.revised).not.toBeNull();
    expect(s.revised!.file).toBe("a.txt");
    expect(s.revised!.feedback).toBe("use camelCase");
    expect(s.acceptedHunks).toBe(1); // first hunk accepted before revise
  });

  it("quit ends the review preserving prior decisions", async () => {
    const { git, resetTracked } = makeGit();
    const a = file("a.txt", [hunk(["+1"], 1), hunk(["+2"], 2)]);
    const b = file("b.txt", [hunk(["+3"], 1)]);
    const decide = async (_f: FileChange, h: Hunk) =>
      h.newStart === 1 ? ({ action: "accept" } as const) : ({ action: "quit" } as const);
    const s = await runReview([a, b], new Set(), decide, git);
    expect(s.quit).toBe(true);
    expect(s.acceptedHunks).toBe(1);
    // b.txt should not have been touched
    expect(resetTracked).not.toHaveBeenCalled();
  });
});
