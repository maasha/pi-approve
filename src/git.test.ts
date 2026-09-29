import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { rm, writeFile, readFile } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectChanges, isGitRepo } from "./git.ts";

let dir: string;
const run = (args: string[], cwd: string) =>
  execFileSync("git", args, { cwd, encoding: "utf8" });

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "pi-approve-git-"));
  run(["init", "-q"], dir);
  run(["config", "user.email", "t@e.st"], dir);
  run(["config", "user.name", "T"], dir);
  await writeFile(join(dir, "base.txt"), "hello\n");
  run(["add", "."], dir);
  run(["commit", "-q", "-m", "init"], dir);
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("isGitRepo", () => {
  it("returns true inside a repo and false outside", async () => {
    expect(await isGitRepo(dir)).toBe(true);
    expect(await isGitRepo(join(tmpdir()))).toBe(false);
  });
});

describe("collectChanges", () => {
  it("collects an unstaged tracked modification as a modified change", async () => {
    await writeFile(join(dir, "base.txt"), "hello\nworld\n");
    const { files, stagedPaths } = await collectChanges(dir);
    const base = files.find((f) => f.path === "base.txt");
    expect(base).toBeDefined();
    expect(base!.untracked).toBe(false);
    expect(base!.kind).toBe("modified");
    expect(base!.hunks[0]!.lines.some((l) => l.startsWith("+"))).toBe(true);
    expect(stagedPaths.has("base.txt")).toBe(false);
  });

  it("collects an untracked file as a whole-file added change", async () => {
    run(["checkout", "-q", "--", "base.txt"], dir);
    await writeFile(join(dir, "new.ts"), "export const x = 1;\n");
    const { files } = await collectChanges(dir);
    const un = files.find((f) => f.path === "new.ts");
    expect(un).toBeDefined();
    expect(un!.untracked).toBe(true);
    expect(un!.kind).toBe("added");
    expect(un!.language).toBe("typescript");
    expect(un!.hunks[0]!.lines).toEqual(["+export const x = 1;"]);
  });

  it("excludes gitignored untracked files", async () => {
    await writeFile(join(dir, ".gitignore"), "secret.log\n");
    await writeFile(join(dir, "secret.log"), "log\n");
    const { files } = await collectChanges(dir);
    expect(files.find((f) => f.path === "secret.log")).toBeUndefined();
  });

  it("marks files that also have staged changes", async () => {
    run(["checkout", "-q", "--", "base.txt"], dir);
    // staged change
    await writeFile(join(dir, "base.txt"), "A\n");
    run(["add", "base.txt"], dir);
    // further unstaged change
    await writeFile(join(dir, "base.txt"), "A\nB\n");
    const { files, stagedPaths } = await collectChanges(dir);
    const base = files.find((f) => f.path === "base.txt");
    expect(base).toBeDefined();
    expect(stagedPaths.has("base.txt")).toBe(true);
    // the unstaged diff is only the B line
    expect(base!.hunks[0]!.lines.some((l) => l.includes("B"))).toBe(true);
    expect(base!.hunks[0]!.lines.some((l) => l.includes("A\n"))).toBe(false);
  });

  it("classifies an unstaged deletion of a tracked file", async () => {
    run(["checkout", "-q", "-f", "base.txt"], dir);
    run(["reset", "-q", "base.txt"], dir);
    run(["checkout", "-q", "--", "base.txt"], dir);
    await rm(join(dir, "base.txt"));
    const { files } = await collectChanges(dir);
    const base = files.find((f) => f.path === "base.txt");
    expect(base).toBeDefined();
    expect(base!.kind).toBe("deleted");
  });

  it("returns empty files when the working tree is clean", async () => {
    run(["checkout", "-q", "-f", "base.txt"], dir);
    run(["reset", "-q", "base.txt"], dir);
    run(["checkout", "-q", "--", "base.txt"], dir);
    // remove untracked
    for (const p of ["new.ts", ".gitignore", "secret.log"]) {
      try {
        await rm(join(dir, p));
      } catch {}
    }
    const { files, stagedPaths } = await collectChanges(dir);
    expect(files).toEqual([]);
    expect(stagedPaths.size).toBe(0);
  });
});
