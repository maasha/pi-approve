import type { Hunk } from "./types.ts";

/** Build the user message sent to the model on a "revise" action. */
export function buildReviseMessage(file: string, feedback: string, hunkLines: string[]): string {
  return `Please revise \`${file}\`: ${feedback}. The relevant hunk was: ${hunkLines.join("\n")}`;
}

/**
 * Build the user message sent to the model on a per-hunk "reject" of an
 * ordinary tracked file. The message embeds the hunk's exact diff so the
 * agent's task is mechanical: revert exactly this change, nothing else.
 */
export function buildRevertMessage(file: string, hunk: Hunk): string {
  const header = hunk.header ? ` (${hunk.header})` : "";
  return (
    `Reject this change in \`${file}\`${header}: revert *exactly this hunk* and nothing ` +
    `else in the file — leave all other unstaged hunks and any staged changes untouched. ` +
    `Do not stage or commit anything. The hunk to revert was:\n` +
    `${hunk.lines.join("\n")}\n` +
    `When done, run nothing else; the user will re-run /approve to validate the result.`
  );
}
