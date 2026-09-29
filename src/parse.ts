import type { FileChange, FileKind, Hunk } from "./types.ts";

/**
 * Return true if the buffer contains a NUL byte in its leading bytes,
 * which git and most tools treat as the marker for binary content.
 */
export function isBinaryFile(buf: Uint8Array): boolean {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

/** Map a file extension to a Shiki language id. */
export function detectLanguage(path: string): string {
  const base = path.split("/").pop()?.toLowerCase() ?? "";
  const dot = base.lastIndexOf(".");
  const ext = dot === -1 ? "" : base.slice(dot);
  switch (ext) {
    case ".ts":
    case ".tsx":
      return "typescript";
    case ".js":
    case ".jsx":
    case ".mjs":
    case ".cjs":
      return "javascript";
    case ".json":
      return "json";
    case ".md":
    case ".markdown":
      return "markdown";
    case ".py":
      return "python";
    case ".rb":
      return "ruby";
    case ".go":
      return "go";
    case ".rs":
      return "rust";
    case ".java":
      return "java";
    case ".c":
    case ".h":
      return "c";
    case ".cpp":
    case ".cc":
    case ".cxx":
    case ".hpp":
      return "cpp";
    case ".cs":
      return "csharp";
    case ".sh":
    case ".bash":
      return "bash";
    case ".yml":
    case ".yaml":
      return "yaml";
    case ".toml":
      return "toml";
    case ".html":
      return "html";
    case ".css":
      return "css";
    case ".scss":
      return "scss";
    case ".sql":
      return "sql";
    case ".php":
      return "php";
    case ".swift":
      return "swift";
    case ".kt":
    case ".kts":
      return "kotlin";
    case ".lua":
      return "lua";
    case ".r":
      return "r";
    case ".dart":
      return "dart";
    case ".zig":
      return "zig";
    case ".ex":
    case ".exs":
      return "elixir";
    case ".erl":
      return "erlang";
    case ".hs":
      return "haskell";
    case ".clj":
      return "clojure";
    case ".pl":
      return "perl";
    case ".ini":
      return "ini";
    default:
      return "plaintext";
  }
}

/** Remove surrounding double quotes, then a leading `a/` or `b/` prefix. */
function cleanPath(raw: string): string {
  let p = raw;
  if (p.startsWith('"') && p.endsWith('"') && p.length >= 2) p = p.slice(1, -1);
  if (p.startsWith("a/") || p.startsWith("b/")) p = p.slice(2);
  return p;
}

/** Extract the new (b-side) path from a `diff --git ...` line. */
function extractNewPath(diffGitLine: string): string | null {
  const quoted = diffGitLine.match(/^diff --git "(.+?)" "(.+?)"\s*$/);
  if (quoted) return cleanPath(quoted[2]!);
  const rest = diffGitLine.slice("diff --git ".length);
  const idx = rest.indexOf(" ");
  if (idx === -1) return null;
  return cleanPath(rest.slice(idx + 1));
}

interface HunkCounts {
  oldCount: number;
  newCount: number;
  newStart: number;
}

function parseHunkHeader(header: string): HunkCounts | null {
  const m = header.match(/@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
  if (!m) return null;
  return {
    oldCount: m[2] === undefined ? 1 : parseInt(m[2], 10),
    newCount: m[4] === undefined ? 1 : parseInt(m[4], 10),
    newStart: parseInt(m[3], 10),
  };
}

/**
 * Parse unified git diff output into per-file changes.
 *
 * Untracked files are not part of `git diff` output; the caller builds their
 * `FileChange` entries separately (see {@link untrackedFileChange}).
 */
export function parseDiff(diff: string): FileChange[] {
  const files: FileChange[] = [];
  if (!diff) return files;

  const lines = diff.replace(/\n$/, "").split("\n");
  let current: FileChange | null = null;
  let currentHunk: Hunk | null = null;
  let expectedBody = 0;

  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      const newPath = extractNewPath(line);
      current = null;
      currentHunk = null;
      expectedBody = 0;
      if (newPath) {
        current = { path: newPath, untracked: false, kind: "modified", language: detectLanguage(newPath), hunks: [] };
        files.push(current);
      }
      continue;
    }

    if (line.startsWith("Binary files ")) {
      if (!current) continue;
      // git emits "Binary files a/x and b/x differ" — synthesize a binary hunk.
      current.kind = "binary";
      if (!current.hunks.length) {
        currentHunk = { header: "[Binary file]", lines: ["[Binary file]"], newStart: 0, binary: true };
        current.hunks.push(currentHunk);
      }
      expectedBody = 0;
      continue;
    }

    // Skip pure metadata lines.
    if (
      line.startsWith("index ") ||
      line.startsWith("new file mode ") ||
      line.startsWith("deleted file mode ") ||
      line.startsWith("old mode ") ||
      line.startsWith("new mode ") ||
      line.startsWith("similarity index ") ||
      line.startsWith("rename from ") ||
      line.startsWith("rename to ")
    ) {
      continue;
    }

    if (line.startsWith("--- ")) continue; // old path; `+++` is authoritative

    if (line.startsWith("+++ ")) {
      const path = line.slice(4);
      if (path === "/dev/null" || cleanPath(path) === "/dev/null") {
        if (current) current.kind = "deleted";
        continue;
      }
      const clean = cleanPath(path);
      if (!current || current.path !== clean) {
        current = { path: clean, untracked: false, kind: "modified", language: detectLanguage(clean), hunks: [] };
        files.push(current);
        currentHunk = null;
        expectedBody = 0;
      }
      continue;
    }

    if (line.startsWith("@@")) {
      if (!current) continue;
      const meta = parseHunkHeader(line);
      const hunk: Hunk = { header: line, lines: [], newStart: meta ? meta.newStart : 0 };
      currentHunk = hunk;
      current.hunks.push(hunk);
      expectedBody = meta ? meta.oldCount + meta.newCount : 0;
      continue;
    }

    // Hunk body: consume exactly oldCount + newCount lines.
    if (expectedBody > 0) {
      const h = currentHunk;
      if (
        h &&
        (line.startsWith("+") || line.startsWith("-") || line.startsWith(" ") || line === "\\" || line === "")
      ) {
        h.lines.push(line === "" ? " " : line);
        expectedBody--;
      }
      continue;
    }
  }

  return files;
}

/** Build a FileChange for an untracked file. The whole file is a single hunk. */
export function untrackedFileChange(path: string, content: string, binary: boolean): FileChange {
  if (binary) {
    return {
      path,
      untracked: true,
      kind: "added",
      language: detectLanguage(path),
      hunks: [{ header: "[Binary file]", lines: ["[Binary file]"], newStart: 1, binary: true }],
    };
  }
  const text = content.endsWith("\n") ? content.slice(0, -1) : content;
  return {
    path,
    untracked: true,
    kind: "added",
    language: detectLanguage(path),
    hunks: [
      {
        header: null,
        lines: text.split("\n").map((l) => `+${l}`),
        newStart: 1,
      },
    ],
  };
}
