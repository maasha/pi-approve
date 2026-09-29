import { describe, expect, it } from "vitest";
import { parseArgs } from "./args";

describe("parseArgs", () => {
  it("returns no flags and no srcDir for empty args", () => {
    expect(parseArgs("")).toEqual({ all: false, rejectAll: false, srcDir: null });
  });

  it("parses --all flag", () => {
    expect(parseArgs("--all")).toEqual({ all: true, rejectAll: false, srcDir: null });
  });

  it("parses --reject-all flag", () => {
    expect(parseArgs("--reject-all")).toEqual({ all: false, rejectAll: true, srcDir: null });
  });

  it("parses a source directory", () => {
    expect(parseArgs("/home/user/project")).toEqual({
      all: false,
      rejectAll: false,
      srcDir: "/home/user/project",
    });
  });

  it("parses source directory with --all flag", () => {
    expect(parseArgs("/home/user/project --all")).toEqual({
      all: true,
      rejectAll: false,
      srcDir: "/home/user/project",
    });
  });

  it("parses --all flag with source directory", () => {
    expect(parseArgs("--all /home/user/project")).toEqual({
      all: true,
      rejectAll: false,
      srcDir: "/home/user/project",
    });
  });

  it("parses source directory with --reject-all flag", () => {
    expect(parseArgs("/home/user/project --reject-all")).toEqual({
      all: false,
      rejectAll: true,
      srcDir: "/home/user/project",
    });
  });
});
