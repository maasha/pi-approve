import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { resolve } from "node:path";
import { parseArgs } from "./args.ts";
import { collectChanges, isGitRepo, resetTracked, removeUntracked } from "./git.ts";
import type { GitOps, ResumeTarget } from "./review.ts";
import { ReviewComponent, type ReviewResult } from "./component.ts";
import { getDefaultHighlighter } from "./highlight.ts";

export default function piApprove(pi: ExtensionAPI) {
  /**
   * A review ended by a delegated reject (`r`) or a revise (`v`) leaves this
   * set; when the agent run it triggered settles, the review re-opens at the
   * hunk that caused it. One slot only — a second settle finds it already
   * consumed and does nothing.
   */
  let pendingReapprove: { dir: string; resume: ResumeTarget | null } | null = null;

  const gitFor = (dir: string): GitOps => ({
    resetTracked: (p) => resetTracked(dir, p),
    removeUntracked: (p) => removeUntracked(dir, p),
  });

  /** Interactive review: collect, open the overlay, dispatch the outcome. */
  async function runReviewSession(
    ctx: Pick<ExtensionCommandContext, "ui" | "isIdle">,
    dir: string,
    resume: ResumeTarget | null = null,
  ): Promise<void> {
    if (!ctx.isIdle()) {
      ctx.ui.notify("Agent is currently running. Wait for it to finish before reviewing changes.", "error");
      return;
    }

    const { files } = await collectChanges(dir);
    if (files.length === 0) {
      ctx.ui.notify("No changes to review.", "info");
      return;
    }

    // Present in deterministic order: alphabetical by path, then diff order.
    const sorted = [...files].sort((a, b) => a.path.localeCompare(b.path));

    // The diff's syntax palette follows pi's active theme (dark/light) so the
    // code stays readable on the overlay's background. `Theme.appearance`
    // reports whether the active theme is designed for a light background;
    // read lazily per line so a theme switch mid-review is picked up.
    const isLight = () => ctx.ui.theme?.appearance === "light";

    const result = await ctx.ui.custom<ReviewResult | undefined>(
      (tui, theme, keybindings, done) =>
        new ReviewComponent(tui, theme, keybindings, done, sorted, gitFor(dir), getDefaultHighlighter(isLight), resume),
      { overlay: true, overlayOptions: { width: "100%", anchor: "top-center" } },
    );

    if (!result) return;

    // The overlay already applied instant git mutations (untracked deletes,
    // whole-file resets). A revise or a per-hunk reject hands feedback to the
    // model and arms the auto-reopen (see the agent_settled handler).
    if (result.revisedMessage) {
      pendingReapprove = { dir, resume: result.resumeTarget };
      await pi.sendUserMessage(result.revisedMessage);
      return;
    }
    if (result.revertMessages) {
      pendingReapprove = { dir, resume: result.resumeTarget };
      await pi.sendUserMessage(result.revertMessages.join("\n\n"));
      return;
    }

    const s = result.summary;
    const bits: string[] = [];
    if (s.acceptedHunks) bits.push(`${s.acceptedHunks} accepted`);
    if (s.rejectedFiles.length) bits.push(`${s.rejectedFiles.length} file(s) reset`);
    if (s.deletedFiles.length) bits.push(`${s.deletedFiles.length} deleted`);
    if (s.skippedHunks) bits.push(`${s.skippedHunks} skipped`);
    ctx.ui.notify(
      bits.length ? `Review complete: ${bits.join(", ")}. Changes remain unstaged.` : "Review complete.",
      "info",
    );
  }

  pi.registerCommand("approve", {
    description: "Require explicit approval of every unstaged change before it can be staged for commit.",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const tokens = args.trim().length ? args.trim().split(/\s+/) : [];
      let parsed;
      try {
        parsed = parseArgs(tokens);
      } catch (e) {
        ctx.ui.notify((e as Error).message, "error");
        return;
      }

      // Interactive review requires TUI mode. Bulk actions may run anywhere.
      if (!parsed.all && !parsed.rejectAll && ctx.mode !== "tui") {
        ctx.ui.notify("Approval review requires interactive (TUI) mode.", "error");
        return;
      }

      const dir = parsed.dir ? resolve(ctx.cwd, parsed.dir) : ctx.cwd;

      if (!(await isGitRepo(dir))) {
        ctx.ui.notify("Not a git repository. Approval requires a git repo.", "error");
        return;
      }

      // ---- Bulk: --all -----------------------------------------------------
      if (parsed.all) {
        const { files } = await collectChanges(dir);
        if (files.length === 0) {
          ctx.ui.notify("No changes to review.", "info");
          return;
        }
        // Accept everything: no git mutations. Accepted changes remain unstaged.
        const totalHunks = files.reduce((n, f) => n + f.hunks.length, 0);
        ctx.ui.notify(`Approved all ${files.length} file(s), ${totalHunks} hunk(s). Changes remain unstaged.`, "info");
        return;
      }

      // ---- Bulk: --reject-all ---------------------------------------------
      if (parsed.rejectAll) {
        const { files } = await collectChanges(dir);
        if (files.length === 0) {
          ctx.ui.notify("No changes to reject.", "info");
          return;
        }
        for (const f of files) {
          if (f.untracked) await gitFor(dir).removeUntracked(f.path);
          else await gitFor(dir).resetTracked(f.path);
        }
        ctx.ui.notify(`Rejected all ${files.length} file(s).`, "info");
        return;
      }

      // ---- Interactive review ---------------------------------------------
      await runReviewSession(ctx, dir);
    },
  });

  // ---- Auto-reopen after an agent-revert / revise turn -----------------------
  // When a review ended by delegating work to the agent (per-hunk reject or
  // revise), the agent's response is still visible in the chat when the run
  // settles, so the user reads it first. A confirm gate waits for the user,
  // then re-opens the review at the hunk that caused the pass. One slot only
  // — an extra settle finds it already consumed and does nothing.
  pi.on("agent_settled", async (event, ctx) => {
    if (!pendingReapprove || ctx.mode !== "tui") return;
    const { dir, resume } = pendingReapprove;
    pendingReapprove = null;
    if (!ctx.isIdle()) return;
    const proceed = await ctx.ui.confirm(
      "Approve review",
      "Agent finished. Return to the review?",
    );
    if (!proceed) return; // user stays in chat; /approve works whenever
    await runReviewSession(ctx, dir, resume);
  });
}
