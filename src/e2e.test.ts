import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { rm, writeFile, readFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { collectChanges, resetTracked, removeUntracked } from "./git.ts";
import { runReview } from "./review.ts";
import type { GitOps } from "./review.ts";

let dir: string;
const run = (args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "pi-approve-e2e-"));
  run(["init", "-q"]);
  run(["config", "user.email", "t@e.st"]);
  run(["config", "user.name", "T"]);
  await writeFile(join(dir, "a.ts"), "export const a = 1;\n");
  run(["add", "."]);
  run(["commit", "-q", "-m", "init"]);
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const gitOps = (cwd: string): GitOps => ({
  resetTracked: (p) => resetTracked(cwd, p),
  removeUntracked: (p) => removeUntracked(cwd, p),
});

describe("end-to-end review in a real repo", () => {
  it("accepts tracked changes (leaves them) and deletes rejected untracked files", async () => {
    // Clean slate
    run(["checkout", "-q", "--", "a.ts"]);
    await writeFile(join(dir, "a.ts"), "export const a = 2;\n");
    await writeFile(join(dir, "temp.txt"), "scratch\n");

    const { files } = await collectChanges(dir);
    expect(files.map((f) => f.path).sort()).toEqual(["a.ts", "temp.txt"]);

    // Decide: accept a.ts, reject temp.txt (untracked -> deleted locally)
    const s = await runReview(
      files,
      async (v) => (v.file.path === "temp.txt" ? { action: "reject" } : { action: "accept" }),
      gitOps(dir),
    );

    // a.ts kept its unstaged change
    expect(await readFile(join(dir, "a.ts"), "utf8")).toBe("export const a = 2;\n");
    // temp.txt deleted
    await expect(access(join(dir, "temp.txt"))).rejects.toThrow();

    expect(s.acceptedHunks).toBe(1);
    expect(s.deletedFiles).toEqual(["temp.txt"]);
    expect(s.rejectedFiles).toEqual([]);
    expect(s.requestedReverts).toEqual([]);
  });

  it("rejecting a hunk of an ordinary tracked file delegates to the agent (no local mutation)", async () => {
    run(["checkout", "-q", "--", "a.ts"]);
    const lines: string[] = [];
    for (let i = 1; i <= 30; i++) lines.push(`line${i}`);
    await writeFile(join(dir, "a.ts"), lines.join("\n") + "\n");
    run(["add", "a.ts"]);
    run(["commit", "-q", "-m", "delegbase"]);
    const base = (await readFile(join(dir, "a.ts"), "utf8")).split("\n");
    base[4] = "line5-EDIT";
    base[24] = "line25-EDIT";
    await writeFile(join(dir, "a.ts"), base.join("\n") + "\n");

    const { files } = await collectChanges(dir);
    const a = files.find((f) => f.path === "a.ts")!;
    expect(a.hunks.length).toBe(2);

    // Accept hunk 1, reject hunk 2.
    const s = await runReview(
      files,
      async (v) => (v.hunk === a.hunks[1] ? { action: "reject" } : { action: "accept" }),
      gitOps(dir),
    );

    // Nothing was reverted locally: both edits are still on disk, waiting
    // for the agent to act on the request.
    const after = (await readFile(join(dir, "a.ts"), "utf8")).split("\n");
    expect(after[4]).toBe("line5-EDIT");
    expect(after[24]).toBe("line25-EDIT");
    expect(s.requestedReverts).toHaveLength(1);
    expect(s.requestedReverts[0]).toEqual({ file: "a.ts", hunk: a.hunks[1] });
    expect(s.rejectedFiles).toEqual([]);
    expect(s.acceptedHunks).toBe(1);
    expect(s.skippedHunks).toBe(0);

    // The generated message names the file and embeds the hunk diff.
    const { buildRevertMessage } = await import("./revise.ts");
    const msg = buildRevertMessage("a.ts", a.hunks[1]!);
    expect(msg).toContain("a.ts");
    expect(msg).toContain("+line25-EDIT");

    // cleanup: restore base for the next test
    run(["checkout", "-q", "--", "a.ts"]);
  });

  it("navigates with arrows in a real repo (pure viewing cursor)", async () => {
    run(["checkout", "-q", "--", "a.ts"]);
    const lines: string[] = [];
    for (let i = 1; i <= 30; i++) lines.push(`nav${i}`);
    await writeFile(join(dir, "a.ts"), lines.join("\n") + "\n");
    run(["add", "a.ts"]);
    run(["commit", "-q", "-m", "navbase"]);
    const base = (await readFile(join(dir, "a.ts"), "utf8")).split("\n");
    base[4] = "nav5-EDIT";
    base[24] = "nav25-EDIT";
    await writeFile(join(dir, "a.ts"), base.join("\n") + "\n");

    const { files } = await collectChanges(dir);
    const a = files.find((f) => f.path === "a.ts")!;
    expect(a.hunks.length).toBe(2);

    // 1: start at hunk 0, ↑ clamps; 2: still hunk 0, ↓ moves to hunk 1;
    // 3: back ↑ to hunk 0 (still open); 4: accept hunk 0;
    // 5: auto-advance hunk 1, ↓ clamps; 6: reject hunk 1 (delegated: review ends).
    let s!: Awaited<ReturnType<typeof runReview>>;
    let step = 0;
    s = await runReview(
      files,
      async (v) => {
        expect(v.file.path).toBe("a.ts");
        expect(v.hunkIndex === 0 ? v.status : "open").toBe("open");
        step++;
        switch (step) {
          case 1: return { action: "navigate", dir: "prev-hunk" };
          case 2: return { action: "navigate", dir: "next-hunk" };
          case 3: return { action: "navigate", dir: "prev-hunk" };
          case 4: return { action: "accept" };
          case 5: return { action: "navigate", dir: "next-hunk" };
          case 6: return { action: "reject" };
        }
        return { action: "quit" };
      },
      gitOps(dir),
    );

    // The accept stays on disk; the reject is delegated to the agent, so
    // nothing has been reverted locally yet.
    expect(s.acceptedHunks).toBe(1);
    expect(s.requestedReverts).toHaveLength(1);
    const after = (await readFile(join(dir, "a.ts"), "utf8")).split("\n");
    expect(after[4]).toBe("nav5-EDIT"); // accepted hunk stays
    expect(after[24]).toBe("nav25-EDIT"); // reject delegated, file untouched

    // cleanup
    run(["checkout", "-q", "--", "a.ts"]);
  });

  it("rejecting a file (R) preserves staged changes without confirmation", async () => {
    run(["checkout", "-q", "--", "a.ts"]);
    run(["reset", "-q", "a.ts"]);
    // Commit a 30-line base (unique to this test), stage an edit to line 5,
    // then an unstaged edit to line 30.
    const lines: string[] = [];
    for (let i = 1; i <= 30; i++) lines.push(`t3-line${i}`);
    await writeFile(join(dir, "a.ts"), lines.join("\n") + "\n");
    run(["add", "a.ts"]);
    run(["commit", "-q", "-m", "base30"]);
    let c = (await readFile(join(dir, "a.ts"), "utf8")).split("\n");
    c[4] = "t3-line5-STAGED";
    await writeFile(join(dir, "a.ts"), c.join("\n") + "\n");
    run(["add", "a.ts"]); // staged
    c = (await readFile(join(dir, "a.ts"), "utf8")).split("\n");
    c[29] = "t3-line30-UNSTAGED";
    await writeFile(join(dir, "a.ts"), c.join("\n") + "\n"); // unstaged, far from the staged line

    const { files } = await collectChanges(dir);
    const a = files.find((f) => f.path === "a.ts")!;
    expect(a.hunks.length).toBe(1);

    const s = await runReview(
      files,
      async () => ({ action: "reject-all-in-file" }),
      gitOps(dir),
    );

    // Unstaged edit reverted; staged edit stays in both index and work tree.
    const after = (await readFile(join(dir, "a.ts"), "utf8")).split("\n");
    expect(after[4]).toBe("t3-line5-STAGED");
    expect(after[29]).toBe("t3-line30");
    // Staged change still in index
    const cached = execFileSync("git", ["diff", "--cached", "--name-only"], { cwd: dir, encoding: "utf8" });
    expect(cached).toContain("a.ts");
    expect(s.rejectedFiles).toEqual(["a.ts"]);

    // cleanup: drop staged + work tree, restore base
    run(["reset", "-q", "a.ts"]);
  });
});


describe("re-opened review resumes at the right hunk", () => {
  it("after the agent edits the file, resume lands on the surviving hunk", async () => {
    run(["checkout", "-q", "--", "a.ts"]);
    const lines: string[] = [];
    for (let i = 1; i <= 30; i++) lines.push(`r${i}`);
    await writeFile(join(dir, "a.ts"), lines.join("\n") + "\n");
    run(["add", "a.ts"]);
    run(["commit", "-q", "-m", "resume-base"]);
    let base = (await readFile(join(dir, "a.ts"), "utf8")).split("\n");
    if (base[base.length - 1] === "") base.pop();
    base[4] = "r5-EDIT";
    base[24] = "r25-EDIT";
    await writeFile(join(dir, "a.ts"), base.join("\n") + "\n");

    const { files } = await collectChanges(dir);
    const a = files.find((f) => f.path === "a.ts")!;
    expect(a.hunks.length).toBe(2);

    // Pass 1: reject hunk 2 -> delegated to the agent (review ends).
    const s1 = await runReview(
      files,
      async (v) => (v.hunk === a.hunks[1] ? { action: "reject" } : { action: "accept" }),
      gitOps(dir),
    );
    expect(s1.requestedReverts).toHaveLength(1);
    const resumeTarget = s1.requestedReverts[0]!;

    // The agent "acts": it fully reverts hunk 2 (back to the committed
    // "r25"), so hunk 2 leaves the diff. The resume target — hunk 2's old
    // content — matches nothing; it must fall back to proximity and land on
    // the surviving hunk 1.
    let wt = (await readFile(join(dir, "a.ts"), "utf8")).split("\n");
    if (wt[wt.length - 1] === "") wt.pop();
    wt[24] = "r25"; // agent complied: hunk 2 reverted
    await writeFile(join(dir, "a.ts"), wt.join("\n") + "\n");

    // Pass 2 (auto-reopened): fresh diff has only hunk 1 (newStart 5);
    // resumeTarget still says newStart 25.
    const { files: files2 } = await collectChanges(dir);
    const a2 = files2.find((f) => f.path === "a.ts")!;
    expect(a2.hunks.length).toBe(1);
    let seen: string[] = [];
    await runReview(
      files2,
      async (v) => {
        seen.push(`${v.file.path}:${v.hunkIndex}`);
        return { action: "accept" };
      },
      gitOps(dir),
      resumeTarget,
    );
    expect(seen).toEqual(["a.ts:0"]);

    // cleanup
    run(["checkout", "-q", "--", "a.ts"]);
  });
});
