// MCP Apps dev-host spike (throwaway, spike-labeled). Isolated config so the
// regular visual suite run is unaffected.
import path from "path"

import { defineConfig } from "@playwright/test"

export default defineConfig({
	testDir: "./src/spike",
	testMatch: "*.spike.ts",
	outputDir: path.resolve(__dirname, "test-results-spike"),
	fullyParallel: false,
	workers: 1,
	repeatEach: 1,
	timeout: 10 * 60_000,
	expect: {
		timeout: 90_000,
	},
	use: {
		trace: "retain-on-failure",
	},
	reporter: [["list"]],
})
