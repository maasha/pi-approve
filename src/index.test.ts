import { describe, expect, it, vi, beforeAll } from "vitest";

// Mock Pi modules before importing the extension
vi.mock("@earendil-works/pi-coding-agent", () => ({}));
vi.mock("@earendil-works/pi-tui", () => ({
	matchesKey: vi.fn(),
	stripTerminalSequences: vi.fn((s: string) => s),
	truncateToWidth: vi.fn((s: string) => s),
	visibleWidth: vi.fn((s: string) => s.length),
}));

// Import after mocks are set up
const { default: approveExtension } = await import("./index");

import type {
	ExtensionAPI,
	ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";

function createMockPi(): {
	pi: ExtensionAPI;
	execCalls: Array<{ cmd: string; args: string[]; opts?: Record<string, unknown> }>;
} {
	const execCalls: Array<{ cmd: string; args: string[]; opts?: Record<string, unknown> }> = [];

	const pi = {
		registerCommand: vi.fn(),
		exec: vi.fn(async (cmd: string, args: string[], opts?: Record<string, unknown>) => {
			execCalls.push({ cmd, args, opts });
			// Default: not a git repo so the handler exits early
			return { stdout: "", stderr: "not a git repo", code: 128, killed: false };
		}),
		on: vi.fn(),
		sendUserMessage: vi.fn(),
	} as unknown as ExtensionAPI;

	return { pi, execCalls };
}

function createMockCtx(): ExtensionCommandContext {
	return {
		ui: {
			notify: vi.fn(),
			select: vi.fn(),
			input: vi.fn(),
			custom: vi.fn(),
		},
		hasUI: true,
	} as unknown as ExtensionCommandContext;
}

describe("approve handler", () => {
	it("uses cwd option when source directory is provided", async () => {
		const { pi, execCalls } = createMockPi();
		const ctx = createMockCtx();

		// Mock pi.exec to return a valid git repo when called with cwd
		pi.exec = vi.fn(async (cmd: string, args: string[], opts?: Record<string, unknown>) => {
			execCalls.push({ cmd, args, opts });
			if (cmd === "git" && args[0] === "rev-parse") {
				return { stdout: ".git", stderr: "", code: 0, killed: false };
			}
			return { stdout: "", stderr: "", code: 0, killed: false };
		});

		approveExtension(pi);
		const handler = pi.registerCommand.mock.calls[0]![1].handler;

		await handler("/some/project", ctx);

		const gitDirCall = execCalls.find(
			(c) => c.cmd === "git" && c.args[0] === "rev-parse",
		);
		expect(gitDirCall).toBeDefined();
		expect(gitDirCall!.opts).toEqual({ cwd: "/some/project" });
	});

	it("does not pass cwd when no source directory is provided", async () => {
		const { pi, execCalls } = createMockPi();
		const ctx = createMockCtx();

		pi.exec = vi.fn(async (cmd: string, args: string[], opts?: Record<string, unknown>) => {
			execCalls.push({ cmd, args, opts });
			if (cmd === "git" && args[0] === "rev-parse") {
				return { stdout: ".git", stderr: "", code: 0, killed: false };
			}
			return { stdout: "", stderr: "", code: 0, killed: false };
		});

		approveExtension(pi);
		const handler = pi.registerCommand.mock.calls[0]![1].handler;

		await handler("", ctx);

		const gitDirCall = execCalls.find(
			(c) => c.cmd === "git" && c.args[0] === "rev-parse",
		);
		expect(gitDirCall).toBeDefined();
		expect(gitDirCall!.opts).toBeUndefined();
	});
});
