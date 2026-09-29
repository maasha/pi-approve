export function parseArgs(
	args: string,
): { all: boolean; rejectAll: boolean; srcDir: string | null } {
	const tokens = args.trim().split(/\s+/).filter(Boolean);
	let all = false;
	let rejectAll = false;
	let srcDir: string | null = null;

	for (const token of tokens) {
		if (token === "--all") {
			all = true;
		} else if (token === "--reject-all") {
			rejectAll = true;
		} else {
			// Anything that isn't a flag is treated as the source directory
			srcDir = token;
		}
	}

	return { all, rejectAll, srcDir };
}
