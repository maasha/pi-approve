// pi-approve — Review and approve working tree changes before staging
//
// Usage:   pi --extension ./pi-approve/src/index.ts
// Command: /approve

import type {
	ExtensionAPI,
	ExtensionCommandContext,
	Theme,
} from "@earendil-works/pi-coding-agent";
import {
	type Focusable,
	matchesKey,
	stripTerminalSequences,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { readFileSync, unlinkSync } from "fs";
import { resolve } from "path";

/* ──────────────────────────────────────────────────────────
   Types
   ────────────────────────────────────────────────────────── */

interface DiffLine {
	type: "context" | "add" | "del";
	content: string;
}

interface Hunk {
	filePath: string;
	header: string;
	lines: DiffLine[];
	isUntracked: boolean;
	isBinary: boolean;
}

interface HighlightedLine {
	code: string; // ANSI-highlighted code body (no diff prefix)
	type: "context" | "add" | "del";
}

type ReviewAction =
	| "accept"
	| "reject"
	| "revise"
	| "accept_all_file"
	| "reject_all_file"
	| "quit";

/* ──────────────────────────────────────────────────────────
   Constants
   ────────────────────────────────────────────────────────── */

const MAX_DIFF_LINES = 100;
const VISIBLE_LINES = 18;
const OVERLAY_WIDTH = 80;

const LANG_MAP: Record<string, string> = {
	ts: "typescript",
	tsx: "tsx",
	js: "javascript",
	jsx: "jsx",
	py: "python",
	go: "go",
	rs: "rust",
	java: "java",
	kotlin: "kotlin",
	kts: "kotlin",
	rb: "ruby",
	php: "php",
	c: "c",
	cpp: "cpp",
	h: "c",
	cs: "csharp",
	swift: "swift",
	json: "json",
	md: "markdown",
	yml: "yaml",
	yaml: "yaml",
	toml: "toml",
	sh: "bash",
	bash: "bash",
	zsh: "bash",
	html: "html",
	css: "css",
	scss: "scss",
	sass: "sass",
	sql: "sql",
	dockerfile: "dockerfile",
	r: "r",
	scala: "scala",
	clj: "clojure",
	cljs: "clojure",
	ex: "elixir",
	exs: "elixir",
	erb: "erb",
	elm: "elm",
	gql: "graphql",
	graphql: "graphql",
	haskell: "haskell",
	hs: "haskell",
	lua: "lua",
	perl: "perl",
	pl: "perl",
	pm: "perl",
	vim: "vim",
	viml: "vim",
	xml: "xml",
	svg: "xml",
};

/* ──────────────────────────────────────────────────────────
   Diff parser
   ────────────────────────────────────────────────────────── */

function parseDiff(diffOutput: string): Hunk[] {
	const hunks: Hunk[] = [];
	const rawLines = diffOutput.split("\n");

	let currentFile: string | null = null;
	let currentHunk: Hunk | null = null;

	for (const line of rawLines) {
		// New file block
		if (line.startsWith("diff --git ")) {
			flushHunk(hunks, currentHunk);
			currentHunk = null;

			const match = line.match(/diff --git a\/(.+?) b\/(.+)/);
			if (match) {
				currentFile = match[2]!;
			} else {
				const parts = line.split(" ");
				const last = parts[parts.length - 1];
				currentFile = last?.startsWith("b/") ? last.slice(2) : last;
			}
			continue;
		}

		// Rename target
		if (line.startsWith("rename to ")) {
			currentFile = line.slice("rename to ".length);
			continue;
		}

		// New hunk header
		if (line.startsWith("@@")) {
			flushHunk(hunks, currentHunk);
			currentHunk = {
				filePath: currentFile || "unknown",
				header: line,
				lines: [],
				isUntracked: false,
				isBinary: false,
			};
			continue;
		}

		// Binary indicator
		if (
			line.startsWith("Binary files") ||
			line.startsWith("GIT binary patch")
		) {
			flushHunk(hunks, currentHunk);
			currentHunk = {
				filePath: currentFile || "unknown",
				header: "",
				lines: [],
				isUntracked: false,
				isBinary: true,
			};
			continue;
		}

		// Diff content lines: context (' '), add ('+'), del ('-')
		if (
			line.length > 0 &&
			(line.startsWith(" ") || line.startsWith("+") || line.startsWith("-"))
		) {
			if (!currentHunk) {
				currentHunk = {
					filePath: currentFile || "unknown",
					header: "",
					lines: [],
					isUntracked: false,
					isBinary: false,
				};
			}
			const prefix = line[0] as " " | "+" | "-";
			const content = line.slice(1);
			const type: DiffLine["type"] =
				prefix === "+" ? "add" : prefix === "-" ? "del" : "context";
			currentHunk.lines.push({ type, content });
			continue;
		}

		// "\ No newline at end of file" — ignore
		if (line.startsWith("\\ ")) continue;
	}

	flushHunk(hunks, currentHunk);
	return hunks;
}

function flushHunk(hunks: Hunk[], hunk: Hunk | null) {
	if (hunk && (hunk.lines.length > 0 || hunk.isBinary)) {
		hunks.push(hunk);
	}
}

/* ──────────────────────────────────────────────────────────
   Untracked file → pseudo-hunk
   ────────────────────────────────────────────────────────── */

function untrackedToHunk(filePath: string): Hunk {
	let lines: DiffLine[] = [];
	try {
		const content = readFileSync(resolve(process.cwd(), filePath), "utf-8");
		const raw = content.split("\n").slice(0, MAX_DIFF_LINES);
		lines = raw.map((l) => ({ type: "add" as const, content: l }));
		if (content.split("\n").length > MAX_DIFF_LINES) {
			lines.push({ type: "context" as const, content: "... (truncated)" });
		}
	} catch (e: any) {
		lines = [
			{ type: "context" as const, content: `Error reading file: ${e.message}` },
		];
	}

	return {
		filePath,
		header: "",
		lines,
		isUntracked: true,
		isBinary: false,
	};
}

/* ──────────────────────────────────────────────────────────
   Language detection
   ────────────────────────────────────────────────────────── */

function detectLanguage(filePath: string): string {
	const basename = filePath.split("/").pop() || "";
	if (basename.toLowerCase() === "dockerfile") return "dockerfile";
	if (basename.toLowerCase().startsWith("dockerfile.")) return "dockerfile";
	if (basename.toLowerCase() === "makefile") return "makefile";

	const parts = filePath.split(".");
	if (parts.length < 2) return "text";
	const ext = parts.pop()!.toLowerCase();
	return LANG_MAP[ext] || "text";
}

/* ──────────────────────────────────────────────────────────
   Syntax highlighting helpers
   ────────────────────────────────────────────────────────── */

function tokensToAnsi(
	tokens: Array<{ content: string; color?: string; fontStyle?: number }>,
): string {
	return tokens
		.map((t) => {
			if (!t.color) return t.content;
			const r = parseInt(t.color.slice(1, 3), 16);
			const g = parseInt(t.color.slice(3, 5), 16);
			const b = parseInt(t.color.slice(5, 7), 16);
			let prefix = `\x1b[38;2;${r};${g};${b}m`;
			if (t.fontStyle && t.fontStyle & 2) prefix = `\x1b[1m${prefix}`;
			if (t.fontStyle && t.fontStyle & 1) prefix = `\x1b[3m${prefix}`;
			return `${prefix}${t.content}\x1b[0m`;
		})
		.join("");
}

async function highlightHunk(hunk: Hunk): Promise<HighlightedLine[]> {
	if (hunk.isBinary) {
		return [{ code: "[Binary file]", type: "context" }];
	}

	if (hunk.lines.length === 0) {
		return [{ code: "(no content)", type: "context" }];
	}

	const codeLines = hunk.lines.map((l) => l.content);
	const code = codeLines.join("\n");
	const lang = detectLanguage(hunk.filePath);

	try {
		const { codeToTokens } = await import("shiki");
		const { tokens } = await codeToTokens(code, {
			lang,
			theme: "dark-plus",
		});

		return hunk.lines.map((line, i) => {
			const tokenLine = tokens[i] || [];
			return { code: tokensToAnsi(tokenLine), type: line.type };
		});
	} catch {
		return hunk.lines.map((line) => ({ code: line.content, type: line.type }));
	}
}

/* ──────────────────────────────────────────────────────────
   Review overlay component
   ────────────────────────────────────────────────────────── */

class ReviewOverlay implements Focusable {
	focused = false;

	private theme: Theme;
	private done: (action: ReviewAction | undefined) => void;
	private hunk: Hunk;
	private renderedLines: HighlightedLine[];
	private scrollOffset = 0;
	private overlayWidth = OVERLAY_WIDTH;

	constructor(
		theme: Theme,
		done: (action: ReviewAction | undefined) => void,
		hunk: Hunk,
		renderedLines: HighlightedLine[],
	) {
		this.theme = theme;
		this.done = done;
		this.hunk = hunk;
		this.renderedLines = renderedLines;
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "q")) {
			this.done("quit");
			return;
		}
		if (data === "a" || data === "A") {
			this.done("accept");
			return;
		}
		if (data === "r" || data === "R") {
			this.done("reject");
			return;
		}
		if (data === "v" || data === "V") {
			this.done("revise");
			return;
		}
		if (data === "f" || data === "F") {
			this.done("accept_all_file");
			return;
		}
		if (data === "d" || data === "D") {
			this.done("reject_all_file");
			return;
		}
		if (matchesKey(data, "up")) {
			this.scrollOffset = Math.max(0, this.scrollOffset - 1);
		}
		if (matchesKey(data, "down")) {
			const maxScroll = Math.max(
				0,
				this.renderedLines.length - VISIBLE_LINES,
			);
			this.scrollOffset = Math.min(maxScroll, this.scrollOffset + 1);
		}
	}

	render(termWidth: number): string[] {
		const th = this.theme;
		const lines: string[] = [];
		const w = Math.min(this.overlayWidth, termWidth);
		const innerW = w - 2;

		const borderTop = th.fg("border", `╭${"─".repeat(innerW)}╮`);
		const borderBot = th.fg("border", `╰${"─".repeat(innerW)}╯`);
		const row = (s: string) => {
			const safe = truncateToWidth(s, innerW);
			const pad = Math.max(
				0,
				innerW - visibleWidth(stripTerminalSequences(safe)),
			);
			return (
				th.fg("border", "│") +
				safe +
				" ".repeat(pad) +
				th.fg("border", "│")
			);
		};

		lines.push(borderTop);

		// File header
		const icon = this.hunk.isUntracked
			? "🆕"
			: this.hunk.isBinary
				? "📦"
				: "📝";
		lines.push(row(` ${icon} ${th.bold(th.fg("accent", this.hunk.filePath))}`));

		if (this.hunk.header) {
			lines.push(row(` ${th.fg("dim", this.hunk.header)}`));
		}
		if (this.hunk.isUntracked) {
			lines.push(row(` ${th.fg("warning", "[new untracked file]")}`));
		}
		lines.push(row(""));

		// Scrollable diff content
		const start = this.scrollOffset;
		const end = Math.min(start + VISIBLE_LINES, this.renderedLines.length);
		for (let i = start; i < end; i++) {
			const hl = this.renderedLines[i]!;
			const prefix =
				hl.type === "add"
					? th.fg("success", "+ ")
					: hl.type === "del"
						? th.fg("error", "- ")
						: th.fg("dim", "  ");
			lines.push(row(" " + prefix + hl.code));
		}
		for (let i = end - start; i < VISIBLE_LINES; i++) {
			lines.push(row(""));
		}

		if (this.renderedLines.length > VISIBLE_LINES) {
			lines.push(
				row(
					` ${th.fg("dim", `(${start + 1}-${end} of ${this.renderedLines.length})`)}`,
				),
			);
		}

		lines.push(row(th.fg("dim", "─".repeat(innerW))));
		lines.push(
			row(
				` ${th.bold("Actions:")} ${th.fg("success", "[a] Accept")} ${th.fg("error", "[r] Reject")} ${th.fg("warning", "[v] Revise")}`,
			),
		);
		lines.push(
			row(
				` ${th.fg("dim", "[f] A")}${th.fg("success", "ccept all in file")}  ${th.fg("dim", "[d] R")}${th.fg("error", "eject all in file")}`,
			),
		);
		lines.push(row(` ${th.fg("dim", "[↑↓] Scroll  [Esc/q] Quit")}`));
		lines.push(borderBot);

		return lines;
	}

	invalidate(): void {}
	dispose(): void {}
}

/* ──────────────────────────────────────────────────────────
   Review a single hunk
   ────────────────────────────────────────────────────────── */

async function reviewHunk(
	ctx: ExtensionCommandContext,
	hunk: Hunk,
): Promise<ReviewAction> {
	const highlighted = await highlightHunk(hunk);

	const result = await ctx.ui.custom<ReviewAction | undefined>(
		(_tui, theme, _keybindings, done) =>
			new ReviewOverlay(theme, done, hunk, highlighted),
		{ overlay: true },
	);

	return result || "quit";
}

/* ──────────────────────────────────────────────────────────
   Main extension
   ────────────────────────────────────────────────────────── */

export default function (pi: ExtensionAPI) {
	pi.registerCommand("approve", {
		description: "Review and approve working tree changes before staging",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			// ── 1. Git repo check ───────────────────────────
			const gitDir = await pi.exec("git", ["rev-parse", "--git-dir"]);
			if (gitDir.exitCode !== 0) {
				ctx.ui.notify(
					"Not a git repository. /approve requires a git repo.",
					"error",
				);
				return;
			}

			// ── 2. Gather diff + untracked ──────────────────
			const diffOut = await pi.exec("git", ["diff"]);
			const untrackedOut = await pi.exec("git", [
				"ls-files",
				"--others",
				"--exclude-standard",
			]);

			const trackedHunks = parseDiff(diffOut.stdout);
			const untrackedPaths = untrackedOut.stdout
				.split("\n")
				.filter(Boolean);
			const untrackedHunks = untrackedPaths.map(untrackedToHunk);

			const allHunks = [...trackedHunks, ...untrackedHunks];

			if (allHunks.length === 0) {
				ctx.ui.notify("No changes to review.", "info");
				return;
			}

			// ── 3. Flags ────────────────────────────────────
			const arg = args.trim();

			if (arg === "--all") {
				ctx.ui.notify(
					`Approved all ${allHunks.length} change(s). Leave unstaged for manual git add.`,
					"success",
				);
				return;
			}

			if (arg === "--reject-all") {
				const trackedFiles = [
					...new Set(trackedHunks.map((h) => h.filePath)),
				];
				for (const f of trackedFiles) {
					await pi.exec("git", ["checkout", "--", f]);
				}
				for (const f of untrackedPaths) {
					try {
						unlinkSync(resolve(process.cwd(), f));
					} catch {
						/* best effort */
					}
				}
				ctx.ui.notify(
					`Rejected ${trackedFiles.length} tracked and ${untrackedPaths.length} untracked change(s).`,
					"info",
				);
				return;
			}

			// ── 4. Interactive review loop ──────────────────
			let queue = [...allHunks];

			while (queue.length > 0) {
				const hunk = queue[0]!;
				const action = await reviewHunk(ctx, hunk);

				queue.shift();

				switch (action) {
					case "accept":
						break;

					case "reject": {
						if (hunk.isUntracked) {
							try {
								unlinkSync(resolve(process.cwd(), hunk.filePath));
							} catch {
								/* ignore */
							}
						} else {
							await pi.exec("git", ["checkout", "--", hunk.filePath]);
						}
						queue = queue.filter((h) => h.filePath !== hunk.filePath);
						break;
					}

					case "accept_all_file":
						queue = queue.filter((h) => h.filePath !== hunk.filePath);
						break;

					case "reject_all_file": {
						if (hunk.isUntracked) {
							try {
								unlinkSync(resolve(process.cwd(), hunk.filePath));
							} catch {
								/* ignore */
							}
						} else {
							await pi.exec("git", ["checkout", "--", hunk.filePath]);
						}
						queue = queue.filter((h) => h.filePath !== hunk.filePath);
						break;
					}

					case "revise": {
						const feedback = await ctx.ui.input(
							`What would you like changed in ${hunk.filePath}?`,
						);
						if (!feedback || feedback.trim() === "") {
							ctx.ui.notify(
								"No feedback provided. Review aborted.",
								"warning",
							);
							return;
						}

						const hunkPreview = hunk.lines
							.map(
								(l) =>
									`${l.type === "add" ? "+" : l.type === "del" ? "-" : " "} ${l.content}`,
							)
							.join("\n");

						await pi.sendUserMessage(
							`Please revise \`${hunk.filePath}\`:\n\n${feedback}\n\nRelevant hunk:\n\`\`\`diff\n${hunkPreview}\n\`\`\``,
						);
						ctx.ui.notify(
							"Revision request sent. Run /approve again after the agent responds.",
							"info",
						);
						return;
					}

					case "quit":
						ctx.ui.notify(
							"Review aborted. Unreviewed changes remain in the working tree.",
							"warning",
						);
						return;
				}
			}

			// ── 5. Done ─────────────────────────────────────
			ctx.ui.notify(
				"Review complete. Approved changes remain unstaged.",
				"success",
			);
		},
	});
}
