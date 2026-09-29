import { describe, it, expect } from "vitest";
import { buildReviseMessage } from "./revise.ts";

describe("buildReviseMessage", () => {
  it("formats the feedback, file, and diff context", () => {
    const out = buildReviseMessage("src/x.ts", "use camelCase", ["+const X = 1;", "-const y = 2;"]);
    expect(out).toBe(
      "Please revise `src/x.ts`: use camelCase. The relevant hunk was: +const X = 1;\n-const y = 2;",
    );
  });

  it("handles empty feedback", () => {
    const out = buildReviseMessage("a.ts", "", ["+x"]);
    expect(out).toBe("Please revise `a.ts`: . The relevant hunk was: +x");
  });

  it("handles an empty diff context", () => {
    const out = buildReviseMessage("a.ts", "fix it", []);
    expect(out).toBe("Please revise `a.ts`: fix it. The relevant hunk was: ");
  });
});
