import { describe, it, expect } from "vitest";
import { hexToAnsi, tokensToAnsi, renderDiffLine } from "./render.ts";

/** Simulated Pi Theme.fg — just wraps text in a marker for testing. */
function makeTheme() {
  const fg = (color: string, text: string) => `⟦${color}⟧${text}⟦/⟧`;
  return { fg };
}

describe("hexToAnsi", () => {
  it("converts pure red to 38;2;255;0;0", () => {
    expect(hexToAnsi("#ff0000")).toBe("38;2;255;0;0");
  });
  it("converts pure green to 38;2;0;255;0", () => {
    expect(hexToAnsi("#00ff00")).toBe("38;2;0;255;0");
  });
  it("converts white to 38;2;255;255;255", () => {
    expect(hexToAnsi("#ffffff")).toBe("38;2;255;255;255");
  });
  it("converts black to 38;2;0;0;0", () => {
    expect(hexToAnsi("#000000")).toBe("38;2;0;0;0");
  });
});

describe("tokensToAnsi", () => {
  it("renders a single-color token", () => {
    const tokens = [
      [{ content: "hello", color: "#ff0000" }],
    ];
    const out = tokensToAnsi(tokens);
    expect(out).toContain("\x1b[38;2;255;0;0m");
    expect(out).toContain("hello");
    expect(out).toContain("\x1b[0m");
  });

  it("renders multiple tokens on the same line with reset between", () => {
    const tokens = [
      [
        { content: "const", color: "#ff0000" },
        { content: " x ", color: "#00ff00" },
        { content: "= 1;", color: "#ffffff" },
      ],
    ];
    const out = tokensToAnsi(tokens);
    expect(out).toContain("\x1b[38;2;255;0;0mconst\x1b[0m");
    expect(out).toContain("\x1b[38;2;0;255;0m x \x1b[0m");
    expect(out).toContain("\x1b[38;2;255;255;255m= 1;\x1b[0m");
  });

  it("renders multiple lines joined with newlines", () => {
    const tokens = [
      [{ content: "line1", color: "#ffffff" }],
      [{ content: "line2", color: "#ffffff" }],
    ];
    const out = tokensToAnsi(tokens);
    expect(out).toBe("\x1b[38;2;255;255;255mline1\x1b[0m\n\x1b[38;2;255;255;255mline2\x1b[0m");
  });

  it("handles empty token arrays", () => {
    const out = tokensToAnsi([]);
    expect(out).toBe("");
  });

  it("skips tokens without a color (uses default)", () => {
    const tokens = [
      [{ content: "plain" }],
    ];
    const out = tokensToAnsi(tokens);
    expect(out).toBe("plain");
  });
});

describe("renderDiffLine", () => {
  it("prerends + prefix in success color", () => {
    const theme = makeTheme();
    const tokens = [[{ content: "code", color: "#ffffff" }]];
    const out = renderDiffLine(tokens, "+", theme);
    expect(out.startsWith("⟦success⟧+ ⟦/⟧")).toBe(true);
    expect(out).toContain("code");
  });

  it("prerends - prefix in error color", () => {
    const theme = makeTheme();
    const tokens = [[{ content: "code", color: "#ffffff" }]];
    const out = renderDiffLine(tokens, "-", theme);
    expect(out.startsWith("⟦error⟧- ⟦/⟧")).toBe(true);
  });

  it("prerends context prefix in dim color", () => {
    const theme = makeTheme();
    const tokens = [[{ content: "code", color: "#ffffff" }]];
    const out = renderDiffLine(tokens, " ", theme);
    expect(out.startsWith("⟦dim⟧  ⟦/⟧")).toBe(true);
  });
});
