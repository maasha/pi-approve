import type { FileChange, Hunk, HunkActionDecision } from "./types.ts";

/** Injectable git operations so the review engine is unit-testable. */
export interface GitOps {
  /** Reset a tracked file's working tree to the index (`git checkout -- <file>`). */
  resetTracked(path: string): Promise<void>;
  /** Delete an untracked file from disk (`rm`). */
  removeUntracked(path: string): Promise<void>;
}

/** Review state of a single hunk. */
export type HunkStatus = "open" | "accepted" | "rejected";

/**
 * Where to place the cursor when a review (re)starts: the hunk the previous
 * pass ended on (a delegated reject or a revise). The list is rebuilt from
 * the fresh diff, so the hunk is re-located by identity heuristics.
 */
export interface ResumeTarget {
  file: string;
  hunk: Hunk;
}

/** The view presented to the user for the hunk under the cursor. */
export interface HunkView {
  file: FileChange;
  hunk: Hunk;
  /** 0-based index of the hunk within its file. */
  hunkIndex: number;
  /** Current decision state; decision keys are inert when not "open". */
  status: HunkStatus;
  /**
   * 1-based position of the viewed file among files that still have ≥1 open
   * hunk; 0 when the viewed file is fully decided.
   */
  openFilePos: number;
  /** Number of files that still have ≥1 open hunk. */
  openFileCount: number;
}

export interface ReviewSummary {
  /** Files whose working tree was fully reset (reject-all-in-file) — i.e. rejected. */
  rejectedFiles: string[];
  /** Untracked files deleted. */
  deletedFiles: string[];
  /** Total hunks accepted (including implicit accept-all-in-file). */
  acceptedHunks: number;
  /** Hunks the agent was asked to revert (delegated, not applied locally). */
  requestedReverts: { file: string; hunk: Hunk }[];
  /** Hunks left undecided when the user quit. */
  skippedHunks: number;
  quit: boolean;
  /** Present when the review ended early via "revise". */
  revised: { file: string; hunk: Hunk; feedback: string } | null;
}

interface Entry {
  file: FileChange;
  hunk: Hunk;
  hunkIndex: number;
}

/** Locate the resume target in a freshly built hunk list. */
export function findStartIdx(flat: Entry[], resume?: ResumeTarget): number {
  if (!resume) return 0;
  const key = (h: Hunk) => h.lines.join("\n");
  const target = key(resume.hunk);
  // 1. Same file, identical content (e.g. the agent didn't revert it yet).
  for (let j = 0; j < flat.length; j++) {
    if (flat[j]!.file.path === resume.file && key(flat[j]!.hunk) === target) return j;
  }
  // 2. Closest by line position in that file (content changed / hunk count
  //    shifted, but the file survived).
  let best = -1;
  let bestDist = Infinity;
  for (let j = 0; j < flat.length; j++) {
    if (flat[j]!.file.path !== resume.file) continue;
    const d = Math.abs(flat[j]!.hunk.newStart - resume.hunk.newStart);
    if (d < bestDist) {
      bestDist = d;
      best = j;
    }
  }
  // 3. File gone (fully reverted) or unknown: start from the top.
  return best === -1 ? 0 : best;
}

/**
 * Drive an interactive review over the collected file changes.
 *
 * A **static list** of hunks (files alphabetical, hunks in diff order — the
 * caller is expected to have sorted `files`) is built up front. A cursor
 * moves through it; navigation decisions (`↑` `↓` `←` `→`) never decide
 * anything, while `a`/`A`/`r`/`R` decide hunks and then the cursor
 * auto-advances to the next open hunk (wrapping). The review auto-closes when
 * every hunk is decided; `quit` ends it early, counting open hunks as
 * skipped. `revise` ends it with the feedback. Rejecting a hunk of an
 * ordinary tracked file is *delegated* to the agent: it records the request
 * and ends the review, so the user can re-run `/approve` to validate. Git
 * mutations happen only for untracked files, deleted/binary files, and
 * whole-file rejects.
 *
 * When `resume` is given (a re-opened review), the cursor starts on the
 * best-matching hunk: same file + identical content first, then the hunk
 * closest by line position in that file, then the first hunk overall.
 *
 * `git` is injectable for testing.
 */
export async function runReview(
  files: FileChange[],
  decide: (view: HunkView) => Promise<HunkActionDecision>,
  git: GitOps,
  resume?: ResumeTarget,
): Promise<ReviewSummary> {
  const summary: ReviewSummary = {
    rejectedFiles: [],
    deletedFiles: [],
    acceptedHunks: 0,
    requestedReverts: [],
    skippedHunks: 0,
    quit: false,
    revised: null,
  };

  // ---- Static hunk list ----------------------------------------------------
  const flat: Entry[] = [];
  const fileStart = new Map<string, number>(); // file path -> first flat index
  const fileEnd = new Map<string, number>(); // file path -> last flat index (inclusive)
  for (const file of files) {
    if (file.hunks.length === 0) continue;
    fileStart.set(file.path, flat.length);
    file.hunks.forEach((hunk, hunkIndex) => flat.push({ file, hunk, hunkIndex }));
    fileEnd.set(file.path, flat.length - 1);
  }
  if (flat.length === 0) return summary;

  const status: HunkStatus[] = flat.map(() => "open");
  const cur0 = findStartIdx(flat, resume);

  // ---- Helpers -------------------------------------------------------------
  const isFileOpen = (path: string): boolean => {
    for (let j = fileStart.get(path)!; j <= fileEnd.get(path)!; j++) {
      if (status[j] === "open") return true;
    }
    return false;
  };

  const openFiles = (): string[] =>
    files.map((f) => f.path).filter((p) => fileStart.has(p) && isFileOpen(p));

  const makeView = (idx: number): HunkView => {
    const e = flat[idx]!;
    const of = openFiles();
    return {
      file: e.file,
      hunk: e.hunk,
      hunkIndex: e.hunkIndex,
      status: status[idx]!,
      openFilePos: of.indexOf(e.file.path) + 1, // 0 when the file is fully decided
      openFileCount: of.length,
    };
  };

  /** Move the cursor for a navigation decision; returns the new index. */
  const move = (cur: number, dir: "prev-hunk" | "next-hunk" | "prev-file" | "next-file"): number => {
    switch (dir) {
      case "prev-hunk":
        return Math.max(0, cur - 1);
      case "next-hunk":
        return Math.min(flat.length - 1, cur + 1);
      case "next-file": {
        const curFile = flat[cur]!.file.path;
        for (let j = cur + 1; j < flat.length; j++) {
          if (status[j] !== "open") continue;
          if (flat[j]!.file.path === curFile) continue;
          return j; // first open hunk of the next open file
        }
        return cur; // clamp
      }
      case "prev-file": {
        const curFile = flat[cur]!.file.path;
        for (let j = cur - 1; j >= 0; j--) {
          if (status[j] !== "open") continue;
          if (flat[j]!.file.path === curFile) continue;
          return j; // last open hunk of the previous open file
        }
        return cur; // clamp
      }
    }
  };

  /** Next open hunk after `cur` (wrapping); null when everything is decided. */
  const nextOpenFrom = (cur: number): number | null => {
    for (let j = cur + 1; j < flat.length; j++) if (status[j] === "open") return j;
    for (let j = 0; j <= cur; j++) if (status[j] === "open") return j;
    return null;
  };

  const closeFile = (path: string, s: HunkStatus): void => {
    for (let j = fileStart.get(path)!; j <= fileEnd.get(path)!; j++) {
      if (status[j] === "open") status[j] = s;
    }
  };

  const allDecided = (): boolean => status.every((s) => s !== "open");

  const countSkipped = (): number => status.filter((s) => s === "open").length;

  /** Apply a deciding action to the open hunk at `cur`. */
  const applyDecision = async (cur: number, d: HunkActionDecision): Promise<void> => {
    const e = flat[cur]!;
    const { file, hunk } = e;
    switch (d.action) {
      case "accept":
        status[cur] = "accepted";
        summary.acceptedHunks++;
        break;
      case "accept-all-in-file": {
        let n = 0;
        for (let j = fileStart.get(file.path)!; j <= fileEnd.get(file.path)!; j++) {
          if (status[j] === "open") {
            status[j] = "accepted";
            n++;
          }
        }
        summary.acceptedHunks += n;
        break;
      }
      case "reject":
        if (file.untracked) {
          await git.removeUntracked(file.path);
          summary.deletedFiles.push(file.path);
          closeFile(file.path, "rejected");
        } else if (file.deleted || hunk.binary) {
          // A hunk inside a deleted/binary file can't be reverted in place —
          // reverting it means restoring the whole file.
          await git.resetTracked(file.path);
          summary.rejectedFiles.push(file.path);
          closeFile(file.path, "rejected");
        } else {
          // Ordinary tracked file: delegate the revert to the agent (the
          // review ends right after this decision).
          status[cur] = "rejected";
          summary.requestedReverts.push({ file: file.path, hunk });
        }
        break;
      case "reject-all-in-file":
        if (file.untracked) {
          await git.removeUntracked(file.path);
          summary.deletedFiles.push(file.path);
        } else {
          await git.resetTracked(file.path);
          summary.rejectedFiles.push(file.path);
        }
        closeFile(file.path, "rejected");
        break;
      default:
        break;
    }
  };

  // ---- Main loop -----------------------------------------------------------
  let cur = cur0;
  for (;;) {
    const view = makeView(cur);
    const d = await decide(view);

    // Navigation and quit are always allowed.
    if (d.action === "navigate") {
      cur = move(cur, d.dir);
      continue;
    }
    if (d.action === "quit") {
      summary.quit = true;
      summary.skippedHunks = countSkipped();
      return summary;
    }
    if (d.action === "revise") {
      summary.revised = { file: view.file.path, hunk: view.hunk, feedback: d.feedback ?? "" };
      return summary;
    }

    // Decisions only apply to open hunks; on decided hunks they are inert.
    if (status[cur] !== "open") continue;

    await applyDecision(cur, d);

    // A delegated agent-revert ends the review right away: the user re-runs
    // /approve after the model turn to validate the result.
    if (d.action === "reject" && summary.requestedReverts.length > 0) {
      summary.skippedHunks = countSkipped();
      return summary;
    }

    if (allDecided()) return summary; // auto-close

    const next = nextOpenFrom(cur);
    if (next !== null) cur = next;
  }
}
