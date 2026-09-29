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

const gitOps = (cwd: string, confirm = async () => true): GitOps => ({
  resetTracked: (p) => resetTracked(cwd, p),
  removeUntracked: (p) => removeUntracked(cwd, p),
  confirmDiscardStaged: confirm,
});

describe("end-to-end review in a real repo", () => {
  it("accepts tracked changes (leaves them) and deletes rejected untracked files", async () => {
    // a tracked modification + an untracked file
    await writeFile(join(dir, "a.ts"), "export const a = 2;\n");
    await writeFile(join(dir, "temp.txt"), "scratch\n");

    const { files, stagedPaths } = await collectChanges(dir);
    expect(files.map((f) => f.path).sort()).toEqual(["a.ts", "temp.txt"]);
    expect(stagedPaths.size).toBe(0);

    // Decide: accept a.ts, reject temp.txt
    const s = await runReview(
      files,
      stagedPaths,
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

  it("rejecting a tracked file resets it to the index and preserves staged changes", async () => {
    // Clean slate for a.ts
    run(["checkout", "-q", "--", "a.ts"]);
    run(["reset", "-q", "a.ts"]);
    // Stage a change, then make a further unstaged change
    await writeFile(join(dir, "a.ts"), "export const a = 3; // STAGED\n");
    run(["add", "a.ts"]);
    await writeFile(join(dir, "a.ts"), "export const a = 3; // STAGED\nexport const b = 4;\n");

    const { files, stagedPaths } = await collectChanges(dir);
    expect(stagedPaths.has("a.ts")).toBe(true);
    const a = files.find((f) => f.path === "a.ts")!;
    // The unstaged diff is only the `b` line
    expect(a.hunks[0]!.lines.join("\n")).toContain("b = 4");

    // Reject a.ts (confirm staged discard)
    let confirmed = false;
    const s = await runReview(
      files,
      stagedPaths,
      async () => ({ action: "reject" }),
      {
        ...gitOps(dir),
        confirmDiscardStaged: async () => {
          confirmed = true;
          return true;
        },
      },
    );

    expect(confirmed).toBe(true);
    // Working tree reset to index (staged content), the unstaged `b` line is gone
    const content = await readFile(join(dir, "a.ts"), "utf8");
    expect(content).toBe("export const a = 3; // STAGED\n");
    // Staged change still in index
    expect(execFileSync("git", ["diff", "--cached", "--name-only"], { cwd: dir, encoding: "utf8" }).includes("a.ts")).toBe(true);
    expect(s.rejectedFiles).toEqual(["a.ts"]);
  });
});
