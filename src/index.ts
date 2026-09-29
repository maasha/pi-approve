import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { resolve } from "node:path";
import { parseArgs } from "./args.ts";
import { collectChanges, isGitRepo, resetTracked, removeUntracked, rejectHunk } from "./git.ts";
import type { GitOps } from "./review.ts";
import { ReviewComponent, type ReviewResult } from "./component.ts";
import { getDefaultHighlighter } from "./highlight.ts";

export default function piApprove(pi: ExtensionAPI) {
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

      const git: GitOps = {
        rejectHunk: (p, f, h) => rejectHunk(dir, f, h),
        resetTracked: (p) => resetTracked(dir, p),
        removeUntracked: (p) => removeUntracked(dir, p),
      };

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
          if (f.untracked) await git.removeUntracked(f.path);
          else await git.resetTracked(f.path);
        }
        ctx.ui.notify(`Rejected all ${files.length} file(s).`, "info");
        return;
      }

      // ---- Interactive review ---------------------------------------------
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

      const result = await ctx.ui.custom<ReviewResult | undefined>(
        (tui, theme, keybindings, done) =>
          new ReviewComponent(
            tui,
            theme,
            keybindings,
            done,
            sorted,
            git,
            getDefaultHighlighter(),
          ),
        { overlay: true, overlayOptions: { width: "100%", anchor: "top-center" } },
      );

      if (!result) return;

      // The overlay already applied git mutations for accept/reject.
      // If the user chose to revise, hand feedback to the model.
      if (result.revisedMessage) {
        // Send via the model on the next turn; the review has ended.
        await pi.sendUserMessage(result.revisedMessage);
        return;
      }

      const s = result.summary;
      const bits: string[] = [];
      if (s.acceptedHunks) bits.push(`${s.acceptedHunks} accepted`);
      if (s.rejectedHunks.length) bits.push(`${s.rejectedHunks.length} hunk(s) rejected`);
      if (s.rejectedFiles.length) bits.push(`${s.rejectedFiles.length} file(s) reset`);
      if (s.deletedFiles.length) bits.push(`${s.deletedFiles.length} deleted`);
      if (s.skippedHunks) bits.push(`${s.skippedHunks} skipped`);
      ctx.ui.notify(
        bits.length ? `Review complete: ${bits.join(", ")}. Changes remain unstaged.` : "Review complete.",
        "info",
      );
    },
  });
}
