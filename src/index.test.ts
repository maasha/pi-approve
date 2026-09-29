import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { exec as cpExec } from "node:child_process";
import { default as ext } from "./index.ts";

type UI = {
  confirm: ReturnType<typeof vi.fn>;
  notify: ReturnType<typeof vi.fn>;
  custom: ReturnType<typeof vi.fn>;
};
type Ctx = { mode: string; isIdle: () => boolean; ui: UI; cwd: string };

const run = (dir: string, args: string[]) =>
  new Promise<void>((res, rej) =>
    cpExec("git " + args.map((a) => `"${a}"`).join(" "), { cwd: dir }, (e) => (e ? rej(e) : res())),
  );

describe("agent_settled auto-reopen gate (integration)", () => {
  let dir: string;
  let commandHandler: (args: string, ctx: Ctx) => Promise<void>;
  let settledHandler: (event: unknown, ctx: Ctx) => Promise<void>;
  const sendUserMessage = vi.fn().mockResolvedValue(undefined);

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "pi-approve-index-"));
    await run(dir, ["init", "-q", "-b", "main"]);
    await run(dir, ["config", "user.email", "t@e.st"]);
    await run(dir, ["config", "user.name", "T"]);
    await writeFile(join(dir, "a.ts"), "x1\nx2\n");
    await run(dir, ["add", "a.ts"]);
    await run(dir, ["commit", "-q", "-m", "base"]);
    await writeFile(join(dir, "a.ts"), "x1\nx2-changed\n");

    const pi = {
      registerCommand: (_name: string, def: { handler: typeof commandHandler }) => {
        commandHandler = def.handler;
      },
      on: (ev: string, h: typeof settledHandler) => {
        if (ev === "agent_settled") settledHandler = h;
      },
      sendUserMessage,
    } as unknown as ExtensionAPI;
    ext(pi);
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const ctx = (uiOverrides?: Partial<UI>): Ctx =>
    ({
      mode: "tui",
      isIdle: () => true,
      cwd: dir,
      ui: {
        confirm: vi.fn().mockResolvedValue(true),
        notify: vi.fn(),
        custom: vi.fn().mockResolvedValue(undefined),
        ...uiOverrides,
      },
    } as Ctx);

  const resumeTarget = {
    file: "a.ts",
    hunk: { header: "@@ -1 +1 @@", lines: ["-x2", "+x2-changed"], newStart: 1, oldStart: 1, oldCount: 1, newCount: 1 },
  };

  const customWith = (result: unknown) =>
    vi.fn().mockResolvedValue(result);

  it("reject path: gate is consulted; decline stops the loop", async () => {
    // Pass 1: review ends in a delegated reject.
    const c1 = ctx({
      custom: customWith({ revertMessages: ["revert a.ts"], resumeTarget }),
    });
    await commandHandler("", c1 as never);
    expect(c1.ui.custom).toHaveBeenCalledTimes(1);
    expect(sendUserMessage).toHaveBeenCalledWith("revert a.ts");

    // Settle: the gate blocks the overlay, and a decline must NOT reopen.
    const c2 = ctx();
    (c2.ui.confirm as ReturnType<typeof vi.fn>).mockResolvedValue(false);
    await settledHandler(null, c2 as never);
    expect(c2.ui.confirm).toHaveBeenCalledWith("Approve review", expect.any(String));
    expect(c2.ui.custom).not.toHaveBeenCalled();
  });

  it("approve path: the reopen is constructed with the resume target", async () => {
    // Re-arm with a second reject.
    const c1 = ctx({
      custom: customWith({ revertMessages: ["revert a.ts"], resumeTarget }),
    });
    await commandHandler("", c1 as never);

    const c2 = ctx();
    (c2.ui.custom as ReturnType<typeof vi.fn>).mockResolvedValue({
      summary: { acceptedHunks: 1, rejectedFiles: [], deletedFiles: [], skippedHunks: 0, requestedReverts: [] },
      revisedMessage: null,
      revertMessages: null,
      resumeTarget,
    });
    await settledHandler(null, c2 as never);
    expect(c2.ui.confirm).toHaveBeenCalledWith("Approve review", expect.any(String));
    expect(c2.ui.custom).toHaveBeenCalledTimes(1);

    // Invoke the component factory the way the TUI would, and check that the
    // constructed overlay carries the resume target.
    const factory = (c2.ui.custom as ReturnType<typeof vi.fn>).mock.calls[0][0] as (...args: unknown[]) => unknown;
    const tui = { terminal: { width: 80, rows: 24 } };
    const theme = { fg: (_c: string, s: string) => s, bg: (_c: string, s: string) => s };
    const comp = factory(tui, theme, {}, () => undefined);
    expect((comp as { resume: typeof resumeTarget }).resume).toEqual(resumeTarget);
  });

  it("single slot: a settle with no pending reopen is a no-op", async () => {
    const c = ctx();
    await settledHandler(null, c as never);
    expect(c.ui.confirm).not.toHaveBeenCalled();
    expect(c.ui.custom).not.toHaveBeenCalled();
  });
});
