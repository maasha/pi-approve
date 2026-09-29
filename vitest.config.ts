import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@earendil-works/pi-coding-agent":
        "/usr/local/share/npm-global/lib/node_modules/@earendil-works/pi-coding-agent",
      "@earendil-works/pi-tui":
        "/usr/local/share/npm-global/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-tui",
    },
  },
  test: {
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    environment: "node",
  },
});
