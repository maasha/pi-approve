import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { rm, writeFile, readFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { collectChanges, resetTracked, removeUntracked, rejectHunk } from "./git.ts";
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
  rejectHunk: (p, f, h) => rejectHunk(cwd, f, h),
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

    // Decide: accept a.ts, reject temp.txt
    const s = await runReview(
      files,
      async (f) => (f.path === "temp.txt" ? { action: "reject" } : { action: "accept" }),
      gitOps(dir),
    );

    // a.ts kept its unstaged change
    expect(await readFile(join(dir, "a.ts"), "utf8")).toBe("export const a = 2;\n");
    // temp.txt deleted
    await expect(access(join(dir, "temp.txt"))).rejects.toThrow();

    expect(s.acceptedHunks).toBe(1);
    expect(s.deletedFiles).toEqual(["temp.txt"]);
    expect(s.rejectedFiles).toEqual([]);
  });

  it("rejecting one hunk of a multi-hunk file reverts only that hunk", async () => {
    // Clean slate, then write a file with two far-apart unstaged changes.
    run(["checkout", "-q", "--", "a.ts"]);
    const lines: string[] = [];
    for (let i = 1; i <= 30; i++) lines.push(`line${i}`);
    await writeFile(join(dir, "a.ts"), lines.join("\n") + "\n");
    // Commit as the new base, then make two distant edits.
    run(["add", "a.ts"]);
    run(["commit", "-q", "-m", "bump"]);
    const base = (await readFile(join(dir, "a.ts"), "utf8")).split("\n");
    base[4] = "line5-EDIT"; // change A
    base[24] = "line25-EDIT"; // change B
    await writeFile(join(dir, "a.ts"), base.join("\n") + "\n");

    const { files } = await collectChanges(dir);
    const a = files.find((f) => f.path === "a.ts")!;
    expect(a.hunks.length).toBe(2); // two separate hunks

    // Accept hunk 1, reject hunk 2.
    const s = await runReview(
      files,
      async (_f, h) => (h === a.hunks[1] ? { action: "reject" } : { action: "accept" }),
      gitOps(dir),
    );

    const after = (await readFile(join(dir, "a.ts"), "utf8")).split("\n");
    expect(after[4]).toBe("line5-EDIT"); // accepted hunk survives
    expect(after[24]).toBe("line25"); // rejected hunk reverted
    expect(s.rejectedHunks).toHaveLength(1);
    expect(s.rejectedFiles).toEqual([]);
    expect(s.acceptedHunks).toBe(1);

    // cleanup: restore base for the next test
    run(["checkout", "-q", "--", "a.ts"]);
  });

  it("rejecting a hunk preserves staged changes without confirmation", async () => {
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
      async () => ({ action: "reject" }),
      gitOps(dir),
    );

    // Unstaged edit reverted; staged edit stays in both index and work tree.
    const after = (await readFile(join(dir, "a.ts"), "utf8")).split("\n");
    expect(after[4]).toBe("t3-line5-STAGED");
    expect(after[29]).toBe("t3-line30");
    // Staged change still in index
    const cached = execFileSync("git", ["diff", "--cached", "--name-only"], { cwd: dir, encoding: "utf8" });
    expect(cached).toContain("a.ts");
    expect(s.rejectedHunks).toHaveLength(1);

    // cleanup: drop staged + work tree, restore base
    run(["reset", "-q", "a.ts"]);
    run(["checkout", "-q", "--", "a.ts"]);
  });
});
