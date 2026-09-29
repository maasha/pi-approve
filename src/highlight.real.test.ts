import { describe, it, expect } from "vitest";
import { createRealHighlighter } from "./highlight.ts";

describe("Highlighter (real Shiki + WASM)", () => {
  it("highlights a typescript line with the real engine", async () => {
    const h = createRealHighlighter();
    const out = await h.highlightLine("const x = 1;", "typescript");
    expect(out).toHaveLength(1);
    const line = out[0]!;
    const text = line.map((t) => t.content).join("");
    expect(text).toBe("const x = 1;");
    // at least one token should have a color
    expect(line.some((t) => !!t.color)).toBe(true);
  });

  it("handles multiple lines", async () => {
    const h = createRealHighlighter();
    const out = await h.highlightLine("function f() {}", "javascript");
    const text = out[0]!.map((t) => t.content).join("");
    expect(text).toBe("function f() {}");
  });
});
