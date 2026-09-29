import { describe, it, expect } from "vitest";
import { parseDiff, isBinaryFile } from "./parse.ts";
import type { FileChange } from "./types.ts";

const ts = String.raw`diff --git a/src/app.ts b/src/app.ts
index 1234567..89abcde 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,4 +1,5 @@
 const a = 1;
-const b = 2;
+const b = 3;
+const c = 4;
 const d = 5;
`;

function expectFile(files: FileChange[], path: string): FileChange {
  const f = files.find((x) => x.path === path);
  expect(f, `missing file ${path}`).toBeDefined();
  return f!;
}

describe("parseDiff", () => {
  it("parses a single modified file into one hunk with its header", () => {
    const files = parseDiff(ts);
    expect(files).toHaveLength(1);
    const f = files[0]!;
    expect(f.path).toBe("src/app.ts");
    expect(f.untracked).toBe(false);
    expect(f.kind).toBe("modified");
    expect(f.language).toBe("typescript");

    expect(f.hunks).toHaveLength(1);
    const h = f.hunks[0]!;
    expect(h.header).toBe("@@ -1,4 +1,5 @@");
    expect(h.newStart).toBe(1);
    expect(h.binary).toBeUndefined();
    expect(h.lines).toEqual([
      " const a = 1;",
      "-const b = 2;",
      "+const b = 3;",
      "+const c = 4;",
      " const d = 5;",
    ]);
  });

  it("splits a file with two diff blocks into two hunks in order", () => {
    const two = String.raw`diff --git a/x.ts b/x.ts
--- a/x.ts
+++ b/x.ts
@@ -1,2 +1,2 @@
-aaa
+bbb
@@ -10,2 +10,2 @@
 ccc
-ddd
+eee
`;
    const f = expectFile(parseDiff(two), "x.ts");
    expect(f.hunks).toHaveLength(2);
    expect(f.hunks[0]!.header).toBe("@@ -1,2 +1,2 @@");
    expect(f.hunks[0]!.newStart).toBe(1);
    expect(f.hunks[1]!.header).toBe("@@ -10,2 +10,2 @@");
    expect(f.hunks[1]!.newStart).toBe(10);
    expect(f.hunks[1]!.lines).toEqual([" ccc", "-ddd", "+eee"]);
  });

  it("classifies an all-removed tracked file as deleted", () => {
    const del = String.raw`diff --git a/gone.ts b/gone.ts
--- a/gone.ts
+++ /dev/null
@@ -1,2 +0,0 @@
-line one
-line two
`;
    const f = expectFile(parseDiff(del), "gone.ts");
    expect(f.kind).toBe("deleted");
    expect(f.hunks).toHaveLength(1);
    expect(f.hunks[0]!.lines).toEqual(["-line one", "-line two"]);
  });

  it("parses binary diff files as a single binary hunk", () => {
    const bin = String.raw`diff --git a/logo.png b/logo.png
index 111..222 100644
Binary files a/logo.png and b/logo.png differ
`;
    const f = expectFile(parseDiff(bin), "logo.png");
    expect(f.kind).toBe("binary");
    expect(f.hunks).toHaveLength(1);
    expect(f.hunks[0]!.binary).toBe(true);
    expect(f.hunks[0]!.header).toBe("[Binary file]");
    expect(f.hunks[0]!.lines).toEqual(["[Binary file]"]);
  });

  it("strips the a/ and b/ prefixes from paths", () => {
    const files = parseDiff(
      String.raw`diff --git a/dir/with/space.md b/dir/with/space.md
--- a/dir/with/space.md
+++ b/dir/with/space.md
@@ -1 +1 @@
-old
+new
`,
    );
    expect(expectFile(files, "dir/with/space.md").language).toBe("markdown");
  });

  it("ignores diff metadata lines (index, similarity, mode, rename)", () => {
    const d = String.raw`diff --git a/old.ts b/new.ts
similarity index 95%
rename from old.ts
rename to new.ts
--- a/old.ts
+++ b/new.ts
@@ -1 +1 @@
-x
+y
`;
    const f = expectFile(parseDiff(d), "new.ts");
    expect(f.hunks).toHaveLength(1);
  });

  it("handles a quoted diff header from unusual filenames", () => {
    const d = String.raw`diff --git "a/weird (1).ts" "b/weird (1).ts"
--- "a/weird (1).ts"
+++ "b/weird (1).ts"
@@ -1 +1 @@
-a
+b
`;
    expect(expectFile(parseDiff(d), "weird (1).ts").hunks[0]!.lines).toEqual(["-a", "+b"]);
  });

  it("returns an empty array for empty input", () => {
    expect(parseDiff("")).toEqual([]);
    expect(parseDiff("\n")).toEqual([]);
  });

  it("detects binary content via NUL bytes", () => {
    expect(isBinaryFile(Buffer.from([0x00]))).toBe(true);
    expect(isBinaryFile(Buffer.from([0x00, 0x61, 0x00]))).toBe(true);
    expect(isBinaryFile(Buffer.from("hello world\n"))).toBe(false);
    expect(isBinaryFile(Buffer.from("plain utf8 text"))).toBe(false);
  });
});
