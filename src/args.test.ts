import { describe, it, expect } from "vitest";
import { parseArgs } from "./args.ts";

describe("parseArgs", () => {
  it("defaults to the current directory with interactive review", () => {
    expect(parseArgs([])).toEqual({ dir: null, all: false, rejectAll: false });
  });

  it("parses a bare directory", () => {
    expect(parseArgs(["/some/repo"])).toEqual({ dir: "/some/repo", all: false, rejectAll: false });
  });

  it("parses --all", () => {
    expect(parseArgs(["--all"])).toEqual({ dir: null, all: true, rejectAll: false });
  });

  it("parses --reject-all", () => {
    expect(parseArgs(["--reject-all"])).toEqual({ dir: null, all: false, rejectAll: true });
  });

  it("parses flags and dir in any order", () => {
    expect(parseArgs(["--all", "/repo"])).toEqual({ dir: "/repo", all: true, rejectAll: false });
    expect(parseArgs(["/repo", "--reject-all"])).toEqual({ dir: "/repo", all: false, rejectAll: true });
  });

  it("treats unknown tokens as part of the directory (last non-flag token wins)", () => {
    expect(parseArgs(["./sub"])).toEqual({ dir: "./sub", all: false, rejectAll: false });
  });

  it("errors when both --all and --reject-all are given", () => {
    expect(() => parseArgs(["--all", "--reject-all"])).toThrow(/mutually exclusive/i);
  });

  it("errors on --all after a valid dir combined with --reject-all", () => {
    expect(() => parseArgs(["/repo", "--all", "--reject-all"])).toThrow(/mutually exclusive/i);
  });
});
