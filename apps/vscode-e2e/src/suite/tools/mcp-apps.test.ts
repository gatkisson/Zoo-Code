import * as assert from "assert"
import * as fs from "fs/promises"
import * as path from "path"
import * as vscode from "vscode"

import { waitFor } from "../utils"
import { setDefaultSuiteTimeout } from "../test-utils"

const UI_SERVER_NAME = "uicard"
const TEST_DIR_NAME = "mcp-apps-fixture"
const TEST_CONFIG_RELATIVE_PATH = ".roo/mcp.json"
const READY_RELATIVE_PATH = `${TEST_DIR_NAME}/server-ready`
const UI_READ_RELATIVE_PATH = `${TEST_DIR_NAME}/server-ready.ui-read`

suite("Roo Code MCP Apps smoke", function () {
	setDefaultSuiteTimeout(this)

	let workspaceDir: string
	let fixtureDir: string
	let mcpConfigPath: string
	let readyPath: string
	let uiReadPath: string

	async function resetFixtureWorkspace() {
		await fs.rm(fixtureDir, { recursive: true, force: true })
	}

	suiteSetup(async () => {
		const workspaceFolders = vscode.workspace.workspaceFolders
		if (!workspaceFolders || workspaceFolders.length === 0) {
			throw new Error("No workspace folder found")
		}

		workspaceDir = workspaceFolders[0]!.uri.fsPath
		fixtureDir = path.join(workspaceDir, TEST_DIR_NAME)
		mcpConfigPath = path.join(workspaceDir, TEST_CONFIG_RELATIVE_PATH)
		readyPath = path.join(workspaceDir, READY_RELATIVE_PATH)
		uiReadPath = path.join(workspaceDir, UI_READ_RELATIVE_PATH)

		await resetFixtureWorkspace()
		await fs.mkdir(path.join(workspaceDir, ".roo"), { recursive: true })
		await fs.writeFile(
			mcpConfigPath,
			JSON.stringify(
				{
					mcpServers: {
						[UI_SERVER_NAME]: {
							command: process.env.npm_node_execpath ?? "node",
							args: [path.join(__dirname, "fixtures", "mcp-ui-server.js"), fixtureDir],
							env: { MCP_TEST_READY_FILE: readyPath },
							alwaysAllow: ["card"],
						},
					},
				},
				null,
				2,
			),
		)

		await globalThis.api.setConfiguration({ mcpAppsEnabled: true })

		// The ready file is touched by the fixture server on tools/list, proving
		// McpHub connected to the real stdio server.
		await waitFor(
			async () => {
				try {
					await fs.access(readyPath)
					return true
				} catch {
					return false
				}
			},
			{ timeout: 30_000 },
		)
	})

	suiteTeardown(async () => {
		try {
			await globalThis.api.clearCurrentTask()
		} catch {
			// Task might not be running
		}

		await fs.rm(fixtureDir, { recursive: true, force: true })
		await fs.rm(mcpConfigPath, { force: true })
	})

	test("webview fetches the ui:// resource through the host bridge when mcpAppsEnabled is on", async () => {
		const api = globalThis.api

		await api.startNewTask({
			configuration: { mode: "ask", alwaysAllowModeSwitch: true, autoApprovalEnabled: true },
			text: "MCP_APPS_SMOKE: Call the uicard MCP card tool exactly once.",
		})

		// The marker proves the full cross-boundary path: ChatRow gate -> mcpAppRequest ->
		// McpHub.handleMcpAppRequest -> real server resources/read. (Webview must be alive;
		// suite/index.ts focuses the sidebar before tests run.)
		await waitFor(
			async () => {
				try {
					await fs.access(uiReadPath)
					return true
				} catch {
					return false
				}
			},
			{ timeout: 30_000 },
		)

		const markerContents = await fs.readFile(uiReadPath, "utf8")
		assert.strictEqual(markerContents, "ok")
	})
})
