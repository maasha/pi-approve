import { describe, it, expect } from "vitest";
import { Highlighter } from "./highlight.ts";
import type { Token } from "./render.ts";

/** A fake highlighter that tags tokens with a color, to exercise the wrapper. */
function fakeCreate(tag: string) {
  let calledLangs: string[] | null = null;
  let calledThemes: string[] | null = null;
  const spy = {
    calledLangs: () => calledLangs,
    calledThemes: () => calledThemes,
    usedThemes: [] as string[],
  };
  const create = async (opts: { themes: string[]; langs: string[] }) => {
    calledLangs = opts.langs;
    calledThemes = opts.themes;
    return {
      codeToTokens: (code: string, opts2: { theme: string }) => {
        spy.usedThemes.push(opts2.theme);
        return { tokens: [[{ content: code, color: tag }]] };
      },
    };
  };
  return { create, spy };
}

describe("Highlighter (plaintext fallback)", () => {
  it("returns the input line unchanged for plaintext", async () => {
    const h = new Highlighter(null);
    const out = await h.highlightLine("hello world", "plaintext");
    expect(out).toEqual([[{ content: "hello world" }]]);
  });

  it("returns the input line unchanged when no highlighter is available", async () => {
    const h = new Highlighter(null);
    const out = await h.highlightLine("const x = 1;", "typescript");
    expect(out).toEqual([[{ content: "const x = 1;" }]]);
  });

  it("handles an empty line", async () => {
    const h = new Highlighter(null);
    const out = await h.highlightLine("", "plaintext");
    expect(out).toEqual([[{ content: "" }]]);
  });

  it("treats unknown languages as plaintext", async () => {
    const h = new Highlighter(null);
    const out = await h.highlightLine("x", "totally-not-a-lang");
    expect(out).toEqual([[{ content: "x" }]]);
  });
});

describe("Highlighter (with a highlighter)", () => {
  it("passes requested languages to the factory and uses the result", async () => {
    const { create, spy } = fakeCreate("#ff0000");
    const h = new Highlighter(create);
    const out = await h.highlightLine("const x = 1;", "typescript");
    expect(spy.calledLangs()).toEqual(["typescript"]);
    expect(out[0]![0]!.color).toBe("#ff0000");
  });

  it("loads both palettes up front", async () => {
    const { create, spy } = fakeCreate("#ff0000");
    const h = new Highlighter(create);
    await h.highlightLine("a", "typescript");
    expect(spy.calledThemes()).toEqual(["dark-plus", "light-plus"]);
  });

  it("defaults to the dark palette", async () => {
    const { create, spy } = fakeCreate("#ff0000");
    const h = new Highlighter(create);
    await h.highlightLine("a", "typescript");
    expect(spy.usedThemes).toEqual(["dark-plus"]);
  });

  it("uses the light palette when the terminal theme is light", async () => {
    const { create, spy } = fakeCreate("#ff0000");
    const h = new Highlighter(create, () => true);
    await h.highlightLine("a", "typescript");
    expect(spy.usedThemes).toEqual(["light-plus"]);
  });

  it("follows the terminal theme at render time", async () => {
    let light = false;
    const { create, spy } = fakeCreate("#ff0000");
    const h = new Highlighter(create, () => light);
    await h.highlightLine("a", "typescript");
    light = true;
    await h.highlightLine("b", "typescript");
    expect(spy.usedThemes).toEqual(["dark-plus", "light-plus"]);
  });

  it("reuses the initialised highlighter across calls (factory called once)", async () => {
    let calls = 0;
    const create = async (opts: { langs: string[] }) => {
      calls++;
      return {
        codeToTokens: (code: string) => ({ tokens: [[{ content: code, color: "#00ff00" }]] }),
      };
    };
    const h = new Highlighter(create);
    await h.highlightLine("a", "typescript");
    await h.highlightLine("b", "typescript");
    expect(calls).toBe(1);
  });

  it("falls back to plaintext if highlighting throws", async () => {
    const create = async () => ({
      codeToTokens: () => {
        throw new Error("boom");
      },
    });
    const h = new Highlighter(create);
    const out = await h.highlightLine("x", "typescript");
    expect(out).toEqual([[{ content: "x" }]]);
  });

  it("falls back to plaintext if initialisation throws", async () => {
    const create = async () => {
      throw new Error("wasm failed");
    };
    const h = new Highlighter(create);
    const out = await h.highlightLine("x", "typescript");
    expect(out).toEqual([[{ content: "x" }]]);
  });
});
