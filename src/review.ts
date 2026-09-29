import type { FileChange, Hunk, HunkActionDecision } from "./types.ts";

/** Injectable git operations so the review engine is unit-testable. */
export interface GitOps {
  /** Reject one hunk by reverse-applying it (`git apply --reverse`). True on success. */
  rejectHunk(path: string, file: FileChange, hunk: Hunk): Promise<boolean>;
  /** Reset a tracked file's working tree to the index (`git checkout -- <file>`). */
  resetTracked(path: string): Promise<void>;
  /** Delete an untracked file from disk (`rm`). */
  removeUntracked(path: string): Promise<void>;
}

export interface ReviewSummary {
  /** Files whose working tree was fully reset (reject-all-in-file) — i.e. rejected. */
  rejectedFiles: string[];
  /** Individual hunks reverted in place. */
  rejectedHunks: string[];
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
 * Per-hunk actions: **reject** reverts just that hunk in place (via
 * `git apply --reverse` on a reconstructed single-hunk patch) and the review
 * continues with the next hunk; **reject-all-in-file** resets the whole file's
 * working tree to the index and skips the file's remaining hunks.
 *
 * `git` is injectable for testing.
 */
export async function runReview(
  files: FileChange[],
  decide: (file: FileChange, hunk: Hunk) => Promise<HunkActionDecision>,
  git: GitOps,
): Promise<ReviewSummary> {
  const summary: ReviewSummary = {
    rejectedFiles: [],
    rejectedHunks: [],
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

        case "reject": {
          if (file.untracked) {
            await git.removeUntracked(file.path);
            summary.deletedFiles.push(file.path);
            fileResolved = true;
            break;
          }
          // A hunk inside a tracked deletion (or binary) can't be applied in
          // place — reverting it means restoring the whole file.
          if (file.deleted || hunk.binary) {
            await git.resetTracked(file.path);
            summary.rejectedFiles.push(file.path);
            fileResolved = true;
            break;
          }
          const ok = await git.rejectHunk(file.path, file, hunk);
          if (ok) {
            summary.rejectedHunks.push(`${file.path}:${hunk.header ?? "?"}`);
            continue; // next hunk
          }
          // Fallback: the single-hunk patch didn't apply cleanly.
          await git.resetTracked(file.path);
          summary.rejectedFiles.push(file.path);
          fileResolved = true;
          break;
        }

        case "reject-all-in-file": {
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
