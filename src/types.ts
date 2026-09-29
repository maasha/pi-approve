/**
 * Data types shared across the pi-approve extension.
 *
 * A "Code Change" is an unstaged working-tree change (tracked modification,
 * tracked deletion, or untracked file). Staged changes are excluded by design.
 */

export type FileKind = "modified" | "deleted" | "added" | "binary";

/** One file's contribution to the review, made of one or more hunks. */
export interface FileChange {
  /** Path relative to the repository root. */
  path: string;
  /** True for files not tracked by git. */
  untracked: boolean;
  kind: FileKind;
  /** The Shiki language id used to highlight this file's hunks. */
  language: string;
  hunks: Hunk[];
  /** True when the unstaged change IS the file's deletion (file absent from working tree). */
  deleted?: boolean;
}

/** The atomic unit of review. */
export interface Hunk {
  /** The `@@ -a,b +c,d @@` header of a tracked diff, if present. */
  header: string | null;
  /** Diff lines, each prefixed with "+", "-", or " ". */
  lines: string[];
  /** First 1-based line number of the new file covered by this hunk. */
  newStart: number;
  /** First 1-based line number of the old (index) file covered by this hunk. */
  oldStart: number;
  /** Number of old (index) lines in the hunk, from its header. 0 for untracked/binary. */
  oldCount: number;
  /** Number of new (working tree) lines in the hunk, from its header. 0 for untracked/binary. */
  newCount: number;
  binary?: boolean;
}

export type HunkAction =
  | "accept"
  | "reject"
  | "revise"
  | "accept-all-in-file"
  | "reject-all-in-file"
  | "navigate"
  | "quit";

export type HunkActionDecision =
  | { action: "revise"; feedback?: string }
  | { action: "navigate"; dir: "prev-hunk" | "next-hunk" | "prev-file" | "next-file" }
  | { action: Exclude<HunkAction, "revise" | "navigate"> };

export type FileDecision =
  | { path: string; decision: "accepted" }
  | { path: string; decision: "rejected" }
  | { path: string; decision: "revised"; feedback: string };
