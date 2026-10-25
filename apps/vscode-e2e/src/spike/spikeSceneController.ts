// MCP Apps dev-host spike (throwaway, spike-labeled; see
// docs/superpowers/plans/spike-results-mcp-apps.md). Runs as the VS Code
// extensionTestsPath inside the real Electron host: it wires the real `uicard`
// stdio MCP server (shared fixture with the smoke suite), enables the feature
// flag, waits for Playwright to arm its webview message probe, then starts the
// MCP_APPS_SMOKE task so the sandbox proxy + srcdoc app actually mount.
import fs from "fs/promises"
import * as path from "path"
import * as vscode from "vscode"

import { providerIdentifiers, RooCodeEventName, type ClineMessage, type RooCodeTestAPI } from "@roo-code/types"

import { isCompletedAsk } from "../suite/utils"

const POLL_INTERVAL_MS = 100
const READY_TIMEOUT_MS = 90_000
const SERVER_READY_TIMEOUT_MS = 30_000
const ARM_TIMEOUT_MS = 60_000
const UI_READ_TIMEOUT_MS = 90_000
// The done-poll starts at ui-read-served, while Playwright's post-arm assertion
// budget is probe(150s) + srcdoc(60s) + landmark(90s); keep the controller alive
// past that worst case so a slow webview-side witness can't close the window.
const DONE_TIMEOUT_MS = 600_000

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function fileExists(filePath: string): Promise<boolean> {
	try {
		await fs.access(filePath)
		return true
	} catch {
		return false
	}
}

async function pollFile(filePath: string, description: string, timeoutMs: number): Promise<void> {
	const deadline = Date.now() + timeoutMs
	while (Date.now() < deadline) {
		if (await fileExists(filePath)) return
		await sleep(POLL_INTERVAL_MS)
	}
	throw new Error(`Timed out waiting for ${description}: ${filePath}`)
}

export async function run(): Promise<void> {
	const readyPath = process.env.ROO_CODE_SPIKE_READY_PATH
	const armPath = process.env.ROO_CODE_SPIKE_ARM_PATH
	const donePath = process.env.ROO_CODE_SPIKE_DONE_PATH
	const uiReadPath = process.env.ROO_CODE_SPIKE_UI_READ_PATH
	const logPath = process.env.ROO_CODE_SPIKE_LOG_PATH
	const aimockUrl = process.env.AIMOCK_URL

	if (!readyPath || !armPath || !donePath || !uiReadPath || !logPath) {
		throw new Error("Spike ready/arm/done/ui-read/log paths are all required")
	}
	const log = (message: string) => fs.appendFile(logPath, `${message}\n`, "utf8")

	const workspaceDir = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
	if (!workspaceDir) {
		throw new Error("No workspace folder found for the MCP Apps spike")
	}

	const extension = vscode.extensions.getExtension<RooCodeTestAPI>("ZooCodeOrganization.zoo-code")
	if (!extension) {
		throw new Error("Zoo Code extension not found")
	}
	const api = extension.isActive ? extension.exports : await extension.activate()

	// Point the project MCP config at the compiled fixture server (same stdio
	// server the smoke suite uses; its HTML now carries the relay probe script).
	const fixtureDir = path.join(workspaceDir, "mcp-apps-spike")
	const serverReadyPath = path.join(fixtureDir, "server-ready")
	await fs.mkdir(path.join(workspaceDir, ".roo"), { recursive: true })
	await fs.writeFile(
		path.join(workspaceDir, ".roo", "mcp.json"),
		JSON.stringify(
			{
				mcpServers: {
					uicard: {
						command: process.env.npm_node_execpath ?? "node",
						args: [path.resolve(__dirname, "../suite/tools/fixtures/mcp-ui-server.js"), fixtureDir],
						env: { MCP_TEST_READY_FILE: serverReadyPath },
						alwaysAllow: ["card"],
					},
				},
			},
			null,
			2,
		),
	)

	// A pristine webview shows the "What's New" release-notes modal; it covers
	// the chat UI and would block frame inspection. Set the announcement marker
	// (the visual scene controller's trick) AND settle any already-rendered
	// announcement ask via the secondary button ("Got it").
	await api.setConfiguration({
		lastShownAnnouncementId: api.getLatestAnnouncementId(),
	})

	await api.setConfiguration({
		apiProvider: providerIdentifiers.openrouter,
		openRouterApiKey: "mock-key",
		openRouterModelId: "openai/gpt-4.1",
		...(aimockUrl ? { openRouterBaseUrl: `${aimockUrl}/v1` } : {}),
		telemetrySetting: "disabled",
		mcpAppsEnabled: true,
	})
	await log("configuration-set")

	await vscode.commands.executeCommand("zoo-code.SidebarProvider.focus")
	const readyDeadline = Date.now() + READY_TIMEOUT_MS
	while (!api.isReady()) {
		if (Date.now() > readyDeadline) {
			throw new Error("Timed out waiting for Zoo Code webview activation")
		}
		await sleep(POLL_INTERVAL_MS)
	}
	await log("webview-ready")

	const announcementSettleDeadline = Date.now() + 10_000
	while (Date.now() < announcementSettleDeadline) {
		try {
			await api.pressSecondaryButton()
		} catch {
			// No pending ask yet; the modal may not have rendered.
		}
		await sleep(500)
	}
	await log("announcement-settled")

	// The fixture server touches this on tools/list: proof McpHub connected.
	await pollFile(serverReadyPath, "uicard server ready marker", SERVER_READY_TIMEOUT_MS)
	await log("mcp-server-connected")

	await fs.writeFile(readyPath, `${JSON.stringify({ vscodeVersion: vscode.version }, null, 2)}\n`, "utf8")
	await log("ready-written")

	// Playwright installs the webview message probe before the task starts so
	// the proxy's parse-time ready ping is observed, not missed.
	await pollFile(armPath, "probe-armed signal", ARM_TIMEOUT_MS)
	await log("probe-armed")

	// Approve ONLY the MCP tool approval ask: the project-scope alwaysAllow in
	// .roo/mcp.json did not gate it in this harness. Deliberately NOT approving
	// completion_result asks — approving completion re-prompts the model and the
	// task loops forever (observed in run 3). The completion ask itself is the
	// landmark; the done-file protocol ends the scene.
	api.on(RooCodeEventName.Message, ({ message }: { message: ClineMessage }) => {
		if (isCompletedAsk(message) && message.ask === "use_mcp_server") {
			void api.approveCurrentAsk().catch((error) => {
				void log(`approveCurrentAsk failed: ${String(error)}`)
			})
		}
	})

	await api.startNewTask({
		configuration: { mode: "ask", alwaysAllowModeSwitch: true, autoApprovalEnabled: true },
		text: "MCP_APPS_SMOKE: Call the uicard MCP card tool exactly once.",
	})
	await log("task-started")

	// Bridge activity is observable from the extension host: McpAppFrame's
	// ui:// fetch arrives as an mcpAppRequest message. Log every Message event
	// so the spike evidence shows the task flow, not just its endpoints.
	api.on(RooCodeEventName.Message, ({ message }: { message: ClineMessage }) => {
		void log(
			`message type=${message.type} ask=${message.type === "ask" ? message.ask : ""} say=${message.type === "say" ? message.say : ""} text=${message.text?.slice(0, 160) ?? ""}`,
		)
	})

	// The server touches this on resources/read: the webview bridge fetched the
	// ui:// resource, so McpAppFrame will mount the sandbox proxy iframe. A
	// timeout here is non-fatal: Playwright's probe assertions are authoritative.
	try {
		await pollFile(uiReadPath, "ui-read marker", UI_READ_TIMEOUT_MS)
		await log("ui-read-served")
	} catch (error) {
		await log(`ui-read-wait-failed: ${String(error)}`)
	}

	const doneDeadline = Date.now() + DONE_TIMEOUT_MS
	while (Date.now() < doneDeadline) {
		if (await fileExists(donePath)) {
			await log("done")
			return
		}
		await sleep(250)
	}
	throw new Error("Timed out waiting for the spike completion signal")
}
