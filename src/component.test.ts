import { describe, it, expect } from "vitest";
import { hunkKeyToAction, confirmKeyToChoice } from "./component.ts";
import type { HunkActionDecision } from "./types.ts";

describe("hunkKeyToAction", () => {
  it("maps a to accept", () => {
    expect(hunkKeyToAction("a")).toEqual<HunkActionDecision>({ action: "accept" });
  });
  it("maps return/enter to accept (default)", () => {
    expect(hunkKeyToAction("\r")).toEqual<HunkActionDecision>({ action: "accept" });
  });
  it("maps f to accept-all-in-file", () => {
    expect(hunkKeyToAction("f")).toEqual<HunkActionDecision>({ action: "accept-all-in-file" });
  });
  it("maps r to reject", () => {
    expect(hunkKeyToAction("r")).toEqual<HunkActionDecision>({ action: "reject" });
  });
  it("maps d to reject-all-in-file", () => {
    expect(hunkKeyToAction("d")).toEqual<HunkActionDecision>({ action: "reject-all-in-file" });
  });
  it("maps v to revise", () => {
    expect(hunkKeyToAction("v")).toEqual<HunkActionDecision>({ action: "revise" });
  });
  it("maps q or escape to quit", () => {
    expect(hunkKeyToAction("q")).toEqual<HunkActionDecision>({ action: "quit" });
    expect(hunkKeyToAction("\x1b")).toEqual<HunkActionDecision>({ action: "quit" });
  });
  it("ignores unrelated keys", () => {
    expect(hunkKeyToAction("z")).toBeNull();
    expect(hunkKeyToAction("x")).toBeNull();
  });
});

describe("confirmKeyToChoice", () => {
  it("y maps to true", () => {
    expect(confirmKeyToChoice("y")).toBe(true);
  });
  it("return maps to true (default yes)", () => {
    expect(confirmKeyToChoice("\r")).toBe(true);
  });
  it("n or escape maps to false", () => {
    expect(confirmKeyToChoice("n")).toBe(false);
    expect(confirmKeyToChoice("\x1b")).toBe(false);
  });
  it("ignores unrelated keys", () => {
    expect(confirmKeyToChoice("z")).toBeNull();
  });
});
