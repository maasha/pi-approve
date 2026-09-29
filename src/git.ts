import { readFile, rm } from "node:fs/promises";
import type { FileChange } from "./types.ts";
import { parseDiff, untrackedFileChange, isBinaryFile } from "./parse.ts";

/** Result of inspecting the working tree for reviewable changes. */
export interface GitState {
  files: FileChange[];
  /** Paths (repo-relative) that also have staged changes. */
  stagedPaths: Set<string>;
}

async function run(
  args: string[],
  cwd: string,
): Promise<{ stdout: string; code: number }> {
  const { execFile } = await import("node:child_process");
  return new Promise((resolve) => {
    execFile(
      "git",
      args,
      { cwd, maxBuffer: 64 * 1024 * 1024 },
      (error, stdout, _stderr) => {
        resolve({ stdout: stdout ?? "", code: error ? 1 : 0 });
      },
    );
  });
}

/** True if `dir` is inside a git work tree. */
export async function isGitRepo(dir: string): Promise<boolean> {
  const { stdout, code } = await run(["rev-parse", "--is-inside-work-tree"], dir);
  return code === 0 && stdout.trim() === "true";
}

function parseNameOnly(output: string): Set<string> {
  const set = new Set<string>();
  for (const raw of output.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    // git may quote unusual path names
    if (line.startsWith('"') && line.endsWith('"')) {
      try {
        set.add(JSON.parse(line));
      } catch {
        set.add(line.slice(1, -1));
      }
    } else {
      set.add(line);
    }
  }
  return set;
}

async function readUntracked(
  dir: string,
  names: string[],
): Promise<FileChange[]> {
  const out: FileChange[] = [];
  for (const name of names) {
    if (!name) continue;
    const abs = `${dir}/${name}`;
    let buf: Buffer;
    try {
      buf = await readFile(abs);
    } catch {
      continue; // vanished between listing and read
    }
    const binary = isBinaryFile(new Uint8Array(buf));
    const content = binary ? "" : buf.toString("utf8");
    out.push(untrackedFileChange(name, content, binary));
  }
  return out;
}

/**
 * Reset a tracked file's working tree to the index (`git checkout -- <file>`).
 * Staged changes are preserved. Paths are passed as argv (never interpolated).
 */
export async function resetTracked(dir: string, path: string): Promise<void> {
  await run(["checkout", "--", path], dir);
}

/** Delete an untracked file from disk (`rm --`). */
export async function removeUntracked(dir: string, path: string): Promise<void> {
  const abs = `${dir}/${path}`;
  try {
    await rm(abs, { recursive: true, force: true });
  } catch {
    // already gone
  }
}

/**
 * Collect unstaged working-tree changes and untracked files for review.
 * Staged changes are excluded from the diff (they are already approved) but we
 * report which paths also have staged changes so the UI can warn on rejection.
 */
export async function collectChanges(dir: string): Promise<GitState> {
  const tracked = await run(["diff", "-U3", "--no-color"], dir);
  const trackedChanges = parseDiff(tracked.stdout);

  const untracked = await run(["ls-files", "--others", "--exclude-standard"], dir);
  const names = untracked.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
  const untrackedChanges = await readUntracked(dir, names);

  const cached = await run(["diff", "--name-only", "--cached", "--no-color"], dir);
  const stagedPaths = parseNameOnly(cached.stdout);

  return { files: [...trackedChanges, ...untrackedChanges], stagedPaths };
}
