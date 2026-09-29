import type { FileChange, Hunk, HunkActionDecision } from "./types.ts";

/** Injectable git operations so the review engine is unit-testable. */
export interface GitOps {
  /** Reset a tracked file's working tree to the index (`git checkout -- <file>`). */
  resetTracked(path: string): Promise<void>;
  /** Delete an untracked file from disk (`rm`). */
  removeUntracked(path: string): Promise<void>;
  /** Confirm with the user that destructive discard of staged changes is OK. */
  confirmDiscardStaged(path: string): Promise<boolean>;
}

export interface ReviewSummary {
  /** Files whose working tree was reset (tracked) — i.e. rejected. */
  rejectedFiles: string[];
  /** Untracked files deleted. */
  deletedFiles: string[];
  /** Total hunks accepted (including implicit accept-all-in-file). */
  acceptedHunks: number;
  quit: boolean;
  /** Present when the review ended early via "revise". */
  revised: { file: string; hunk: Hunk; feedback: string } | null;
}

/**
 * Drive an interactive review over the collected file changes.
 *
 * `decide` is asked for a decision on each hunk; the engine applies the
 * file-level-reset invariant: rejecting any hunk in a tracked file resets the
 * whole file (skipping its remaining hunks); accepting leaves the file on disk
 * and moves on. `git` is injectable for testing.
 */
export async function runReview(
  files: FileChange[],
  stagedPaths: Set<string>,
  decide: (file: FileChange, hunk: Hunk) => Promise<HunkActionDecision>,
  git: GitOps,
): Promise<ReviewSummary> {
  const summary: ReviewSummary = {
    rejectedFiles: [],
    deletedFiles: [],
    acceptedHunks: 0,
    quit: false,
    revised: null,
  };

  for (const file of files) {
    if (file.hunks.length === 0) continue;

    let fileResolved = false;

    for (let i = 0; i < file.hunks.length; i++) {
      const hunk = file.hunks[i]!;
      const { action, feedback } = await decide(file, hunk);

      switch (action) {
        case "accept":
          summary.acceptedHunks++;
          continue;

        case "accept-all-in-file": {
          // Implicitly accept the current and any remaining hunks in this file.
          summary.acceptedHunks += file.hunks.length - i;
          fileResolved = true;
          break;
        }

        case "reject":
        case "reject-all-in-file": {
          const ok =
            file.untracked ||
            !stagedPaths.has(file.path) ||
            (await git.confirmDiscardStaged(file.path));
          if (!ok) {
            // Declined: skip this hunk, leave the file unchanged, keep going.
            continue;
          }
          if (file.untracked) {
            await git.removeUntracked(file.path);
            summary.deletedFiles.push(file.path);
          } else {
            await git.resetTracked(file.path);
            summary.rejectedFiles.push(file.path);
          }
          fileResolved = true;
          break;
        }

        case "revise":
          summary.revised = { file: file.path, hunk, feedback: feedback ?? "" };
          return summary;

        case "quit":
          summary.quit = true;
          return summary;
      }

      if (fileResolved) break;
    }
  }

  return summary;
}
