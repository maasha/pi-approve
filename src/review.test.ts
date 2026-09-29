import { describe, it, expect, vi } from "vitest";
import type { FileChange, Hunk } from "./types.ts";
import {
  runReview,
  type GitOps,
  type HunkView,
  type HunkStatus,
} from "./review.ts";
import type { HunkActionDecision } from "./types.ts";

function hunk(lines: string[], i: number): Hunk {
  const oldCount = lines.filter((l) => l.startsWith("-") || l.startsWith(" ")).length;
  const newCount = lines.filter((l) => l.startsWith("+") || l.startsWith(" ")).length;
  return { header: `@@ -${i},3 +${i},3 @@`, lines, newStart: i, oldStart: i, oldCount, newCount };
}
function file(path: string, overrides: Partial<FileChange> = {}): FileChange {
  return {
    path,
    untracked: false,
    kind: "modified",
    language: "plaintext",
    hunks: [hunk(["+a"], 1), hunk(["+b"], 10)],
    ...overrides,
  };
}

const git = () => ({
  resetTracked: vi.fn(async () => {}),
  removeUntracked: vi.fn(async () => {}),
});


describe("runReview — decisions", () => {
  it("accepts every hunk when the user accepts them all", async () => {
    const g = git();
    const s = await runReview(
      [file("a.ts")],
      async () => ({ action: "accept" }) as HunkActionDecision,
      g as unknown as GitOps,
    );
    expect(s.acceptedHunks).toBe(2);
    expect(s.rejectedFiles).toEqual([]);
    expect(s.requestedReverts).toEqual([]);
    expect(g.resetTracked).not.toHaveBeenCalled();
  });

  it("rejecting one hunk of a multi-hunk file delegates to the agent and ends the review", async () => {
    const g = git();
    const seen: HunkStatus[] = [];
    const f = file("a.ts");
    const s = await runReview(
      [f],
      async (v) => {
        seen.push(v.status);
        return v.hunk === f.hunks[1]
          ? ({ action: "reject" } as HunkActionDecision)
          : ({ action: "accept" } as HunkActionDecision);
      },
      g as unknown as GitOps,
    );
    // No local git mutation for a hunk of an ordinary tracked file.
    expect(g.resetTracked).not.toHaveBeenCalled();
    expect(s.requestedReverts).toEqual([{ file: "a.ts", hunk: f.hunks[1] }]);
    expect(s.acceptedHunks).toBe(1);
    // The review ends on the reject: only two views were presented, the
    // remaining open hunk is counted as skipped.
    expect(seen).toEqual(["open", "open"]);
    expect(s.skippedHunks).toBe(0);
  });

  it("A accepts every undecided hunk in the file and moves on", async () => {
    const g = git();
    const s = await runReview(
      [file("a.ts"), file("b.ts")],
      async () => ({ action: "accept-all-in-file" }) as HunkActionDecision,
      g as unknown as GitOps,
    );
    expect(s.acceptedHunks).toBe(4);
    expect(s.skippedHunks).toBe(0);
  });

  it("rejecting an untracked hunk deletes the file", async () => {
    const g = git();
    const s = await runReview(
      [file("t.txt", { untracked: true, kind: "added", hunks: [hunk(["+x"], 1)] })],
      async () => ({ action: "reject" }) as HunkActionDecision,
      g as unknown as GitOps,
    );
    expect(g.removeUntracked).toHaveBeenCalledWith("t.txt");
    expect(s.deletedFiles).toEqual(["t.txt"]);
  });

  it("rejecting a hunk in a deleted file resets the whole file", async () => {
    const g = git();
    const f = file("del.ts", { deleted: true, kind: "deleted", hunks: [hunk(["-a"], 1)] });
    const s = await runReview([f], async () => ({ action: "reject" }) as HunkActionDecision, g as unknown as GitOps);
    expect(g.resetTracked).toHaveBeenCalledWith("del.ts");
    expect(s.rejectedFiles).toEqual(["del.ts"]);
    expect(s.requestedReverts).toEqual([]);
  });

  it("rejecting a hunk in a binary file resets the whole file", async () => {
    const g = git();
    const f = file("bin.dat", { kind: "binary", hunks: [{ header: null, lines: [], newStart: 0, oldStart: 0, oldCount: 0, newCount: 0, binary: true }] });
    const s = await runReview([f], async () => ({ action: "reject" }) as HunkActionDecision, g as unknown as GitOps);
    expect(g.resetTracked).toHaveBeenCalledWith("bin.dat");
    expect(s.requestedReverts).toEqual([]);
  });

  it("reject on a multi-file review ends the review and counts later hunks as skipped", async () => {
    const g = git();
    const visits: string[] = [];
    const s = await runReview(
      [file("a.ts"), file("b.ts")],
      async (v) => {
        visits.push(v.file.path);
        return v.file.path === "a.ts"
          ? ({ action: "reject" } as HunkActionDecision)
          : ({ action: "accept" } as HunkActionDecision);
      },
      g as unknown as GitOps,
    );
    // a.ts hunk 0 -> reject ends the review; b.ts never presented.
    expect(visits).toEqual(["a.ts"]);
    expect(s.requestedReverts).toHaveLength(1);
    expect(s.skippedHunks).toBe(3); // a.ts:1 + b.ts:0 + b.ts:1
    expect(s.acceptedHunks).toBe(0);
  });


  it("R resets a tracked file and rejects all its hunks", async () => {
    const g = git();
    const s = await runReview(
      [file("a.ts"), file("b.ts")],
      async (v) =>
        v.file.path === "a.ts"
          ? ({ action: "reject-all-in-file" } as HunkActionDecision)
          : ({ action: "accept" } as HunkActionDecision),
      g as unknown as GitOps,
    );
    expect(g.resetTracked).toHaveBeenCalledTimes(1);
    expect(g.resetTracked).toHaveBeenCalledWith("a.ts");
    expect(s.rejectedFiles).toEqual(["a.ts"]);
    expect(s.acceptedHunks).toBe(2);
  });

  it("R on an untracked file deletes it", async () => {
    const g = git();
    const s = await runReview(
      [file("t.txt", { untracked: true, kind: "added" })],
      async () => ({ action: "reject-all-in-file" }) as HunkActionDecision,
      g as unknown as GitOps,
    );
    expect(g.removeUntracked).toHaveBeenCalledWith("t.txt");
    expect(s.deletedFiles).toEqual(["t.txt"]);
  });

  it("revise ends the review with the feedback", async () => {
    const s = await runReview(
      [file("a.ts")],
      async () => ({ action: "revise", feedback: "use camelCase" }) as HunkActionDecision,
      git() as unknown as GitOps,
    );
    expect(s.revised?.feedback).toBe("use camelCase");
    expect(s.quit).toBe(false);
  });

  it("quit preserves decisions and counts the rest as skipped", async () => {
    const calls: string[] = [];
    const s = await runReview(
      [file("a.ts"), file("b.ts")],
      async (v) => {
        calls.push(v.file.path);
        return calls.length < 3
          ? ({ action: "accept" } as HunkActionDecision)
          : ({ action: "quit" } as HunkActionDecision);
      },
      git() as unknown as GitOps,
    );
    // a.ts:0, a.ts:1 accepted; b.ts:0 viewed then quit -> b.ts hunks skipped
    expect(s.acceptedHunks).toBe(2);
    expect(s.skippedHunks).toBe(2);
    expect(s.quit).toBe(true);
  });
});

describe("runReview — navigation", () => {
  const nav = (dir: "prev-hunk" | "next-hunk" | "prev-file" | "next-file"): HunkActionDecision =>
    ({ action: "navigate", dir });

  it("↑/↓ move the cursor and re-visit decided hunks with their status", async () => {
    const visits: { path: string; hunkIdx: number; status: HunkStatus }[] = [];
    let step = 0;
    const s = await runReview(
      [file("a.ts")],
      async (v) => {
        visits.push({ path: v.file.path, hunkIdx: v.hunkIndex, status: v.status });
        step++;
        if (step === 1) return { action: "accept" };
        if (step === 2) return nav("prev-hunk"); // back to hunk 0, now decided
        if (step === 3) return nav("next-hunk"); // forward again
        return { action: "accept" };
      },
      git() as unknown as GitOps,
    );
    expect(visits).toEqual([
      { path: "a.ts", hunkIdx: 0, status: "open" },
      { path: "a.ts", hunkIdx: 1, status: "open" },
      { path: "a.ts", hunkIdx: 0, status: "accepted" },
      { path: "a.ts", hunkIdx: 1, status: "open" },
    ]);
    expect(s.acceptedHunks).toBe(2);
  });

  it("clamps at the ends of the hunk list", async () => {
    const visits: number[] = [];
    let step = 0;
    await runReview(
      [file("a.ts")],
      async (v) => {
        visits.push(v.hunkIndex);
        step++;
        if (step === 1) return { action: "accept" }; // -> auto-advance to hunk 1 (last)
        if (step === 2) return nav("next-hunk"); // clamp: stay on 1
        return { action: "quit" };
      },
      git() as unknown as GitOps,
    );
    expect(visits).toEqual([0, 1, 1]);
  });

  it("→ jumps to the first open hunk of the next open file and ← to the last open hunk of the previous", async () => {
    const visits: string[] = [];
    let step = 0;
    await runReview(
      [file("a.ts"), file("b.ts")],
      async (v) => {
        visits.push(`${v.file.path}:${v.hunkIndex}`);
        step++;
        switch (step) {
          case 1: // on a.ts:0 -> jump forward to b.ts
            return nav("next-file");
          case 2: // on b.ts:0 -> jump back to a.ts (lands on LAST open hunk = a.ts:1)
            return nav("prev-file");
          case 3: // on a.ts:1 -> accept
            return { action: "accept" };
          case 4: // a.ts:0 still open -> accept
            return { action: "accept" };
          case 5: // b.ts:0 open -> accept
            return { action: "accept" };
          case 6: // b.ts:1 open -> quit
            return { action: "quit" };
        }
        return { action: "quit" };
      },
      git() as unknown as GitOps,
    );
    expect(visits.slice(0, 3)).toEqual(["a.ts:0", "b.ts:0", "a.ts:1"]);
  });

  it("file jumps skip files with no open hunks", async () => {
    const visits: string[] = [];
    let step = 0;
    await runReview(
      [file("a.ts"), file("b.ts"), file("c.ts")],
      async (v) => {
        visits.push(v.file.path);
        step++;
        switch (step) {
          case 1: // a.ts:0 -> R: a closed, auto-advance to b.ts:0
            return { action: "reject-all-in-file" };
          case 2: // b.ts:0 -> R: b closed, auto-advance to c.ts:0
            return { action: "reject-all-in-file" };
          case 3: // c.ts:0 -> <- must clamp (a, b closed)
            return nav("prev-file");
          case 4: // still c.ts:0 -> -> must clamp (no open file later)
            return nav("next-file");
          case 5:
            return { action: "quit" };
        }
        return { action: "quit" };
      },
      git() as unknown as GitOps,
    );
    expect(visits).toEqual(["a.ts", "b.ts", "c.ts", "c.ts", "c.ts"]);
  });

  it("auto-advance wraps to the first open hunk when none follow", async () => {
    const visits: string[] = [];
    let step = 0;
    await runReview(
      [file("a.ts")],
      async (v) => {
        visits.push(`${v.hunkIndex}:${v.status}`);
        step++;
        if (step === 1) return { action: "accept" }; // a.ts:0 accepted, next open is a.ts:1
        if (step === 2) return { action: "accept" }; // a.ts:1 accepted -> wraps to a.ts:0 (accepted)
        // hmm — auto-advance targets OPEN hunks only; a.ts:0 is accepted, so review must END.
        return { action: "quit" };
      },
      git() as unknown as GitOps,
    );
    expect(visits).toEqual(["0:open", "1:open"]);
  });

  it("decision keys are inert on a decided hunk", async () => {
    const g = git();
    let step = 0;
    const s = await runReview(
      [file("a.ts")],
      async (v) => {
        step++;
        if (step === 1) return { action: "accept" };
        if (step === 2) return nav("prev-hunk"); // onto decided a.ts:0
        if (step === 3) return { action: "reject" }; // INERT: decided hunk, must be ignored
        if (step === 4) return { action: "accept" }; // also inert
        return { action: "quit" };
      },
      g as unknown as GitOps,
    );
    expect(g.resetTracked).not.toHaveBeenCalled();
    expect(s.acceptedHunks).toBe(1);
    expect(s.requestedReverts).toEqual([]);
    expect(s.skippedHunks).toBe(1);
  });
});

describe("runReview — file counter", () => {
  it("reports 1-based position and live count among open files", async () => {
    const seen: { pos: number; total: number }[] = [];
    let step = 0;
    await runReview(
      [file("a.ts"), file("b.ts"), file("c.ts")],
      async (v) => {
        seen.push({ pos: v.openFilePos, total: v.openFileCount });
        step++;
        switch (step) {
          case 1: // a.ts:0 — file 1/3
            return { action: "reject-all-in-file" }; // a.ts closes
          case 2: // auto-advance b.ts:0 — file 1/2
            return { action: "reject-all-in-file" }; // b.ts closes
          case 3: // c.ts:0 — file 1/1
            return { action: "quit" };
        }
        return { action: "quit" };
      },
      git() as unknown as GitOps,
    );
    expect(seen).toEqual([
      { pos: 1, total: 3 },
      { pos: 1, total: 2 },
      { pos: 1, total: 1 },
    ]);
  });

  it("accepted files also leave the count (review work, not disk state)", async () => {
    const seen: { total: number }[] = [];
    let step = 0;
    await runReview(
      [file("a.ts"), file("b.ts")],
      async (v) => {
        seen.push({ total: v.openFileCount });
        step++;
        if (step === 1) return { action: "accept-all-in-file" }; // a.ts closes via accept
        if (step === 2) return { action: "accept" }; // b.ts:0
        return { action: "accept" }; // b.ts:1
      },
      git() as unknown as GitOps,
    );
    expect(seen).toEqual([{ total: 2 }, { total: 1 }, { total: 1 }]);
    // review auto-closed: decide was called exactly 3 times
    expect(step).toBe(3);
  });
});
