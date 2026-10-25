// MCP Apps dev-host spike (throwaway, spike-labeled; see
// docs/superpowers/plans/spike-results-mcp-apps.md). Automates the four PASS
// criteria of the manual F5 dev-host spike inside the real VS Code Electron
// webview and writes a machine-checkable evidence package to out/spike-evidence/.
// Re-scoped for the render-into-proxy fallback model: the app HTML renders
// INSIDE the blob-mounted sandbox proxy document (no nested srcdoc app frame),
// and app inline scripts re-execute there via dynamic insertion, admitted by
// strict-dynamic propagation from the hash-admitted relay script.
import fs from "fs/promises"
import { readFileSync } from "fs"
import os from "os"
import path from "path"

import { LLMock } from "@copilotkit/aimock"
import { downloadAndUnzipVSCode } from "@vscode/test-electron"
import {
	_electron,
	expect,
	test,
	type ConsoleMessage,
	type ElectronApplication,
	type Frame,
	type Page,
	type TestInfo,
} from "@playwright/test"
import { glob } from "glob"

import { addMcpAppsFixtures } from "../fixtures/mcp-apps"

const packageRoot = path.resolve(__dirname, "../..")
const repositoryRoot = path.resolve(packageRoot, "../..")
const extensionDevelopmentPath = path.join(repositoryRoot, "src")
const extensionTestsPath = path.join(packageRoot, "out", "spike", "spikeSceneController")
const evidenceDir = path.join(packageRoot, "out", "spike-evidence")
const packageJson = JSON.parse(readFileSync(path.join(packageRoot, "package.json"), "utf8")) as {
	devDependencies: Record<string, string>
}
const vscodeVersion = packageJson.devDependencies["@types/vscode"]!

const SPIKE_NONCE = "spike-relay-probe-001"
const PROXY_READY_PING = "mcp-app-sandbox-proxy-ready"
const RELAY_PROBE = "SPIKE_RELAY_PROBE"

interface ProbeMessage {
	type: string
	nonce?: string
	sourceIsProxyFrame: boolean
	ts: number
}

interface ProbeState {
	installedAt: number
	messages: ProbeMessage[]
}

interface SpikeEvidence {
	vscodeVersion: string
	timestamp: string
	criteria: {
		c1InnerScriptExecuted: boolean
		c2aHostToInnerDelivery: boolean
		c2bInnerToHostRelay: boolean
		c3WebviewAppUnaffected: boolean
		c4HostWindowSeam: boolean
	}
	ping: ProbeMessage | null
	relayProbe: ProbeMessage | null
	probeMessages: ProbeMessage[]
	srcdocCardText: string | null
	completionLandmarkVisible: boolean
	proxyConsoleLines: string[]
	consoleMessageCount: number
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

// Spike collectors: network failures for the proxy resource route and console
// lines from the proxy frame, snapshotted into every diagnostics dump.
const requestFailures: string[] = []
const proxyConsoleLines: string[] = []
const requestFailuresSnapshot = () => [...requestFailures]
const proxyConsoleSnapshot = () => [...proxyConsoleLines]

async function waitForJson<T>(filePath: string, timeoutMs: number): Promise<T> {
	const deadline = Date.now() + timeoutMs
	while (Date.now() < deadline) {
		try {
			return JSON.parse(await fs.readFile(filePath, "utf8")) as T
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT" && !(error instanceof SyntaxError)) throw error
			await sleep(100)
		}
	}
	throw new Error(`Timed out waiting for readiness file: ${filePath}`)
}

async function attachLogs(userDataPath: string, logPath: string, testInfo: TestInfo, persist = false) {
	const sceneLog = await fs.readFile(logPath, "utf8").catch(() => "")
	if (sceneLog) await testInfo.attach("spike-scene.log", { body: sceneLog, contentType: "text/plain" })

	for (const pattern of ["logs/**/exthost.log", "logs/**/renderer.log", "logs/**/*Zoo-Code.log"]) {
		const logs = await glob(pattern, { cwd: userDataPath })
		const latest = logs.at(-1)
		if (!latest) continue
		const contents = await fs.readFile(path.join(userDataPath, latest), "utf8").catch(() => "")
		if (!contents) continue
		await testInfo.attach(`spike-${path.basename(latest)}`, { body: contents, contentType: "text/plain" })
		if (persist) {
			await fs
				.writeFile(path.join(evidenceDir, `failure-${path.basename(latest)}`), contents, "utf8")
				.catch(() => undefined)
		}
	}
	if (sceneLog && persist) {
		await fs.writeFile(path.join(evidenceDir, "failure-spike-scene.log"), sceneLog, "utf8").catch(() => undefined)
	}
}

// Runs inside the live webview content window. Records only spike-relevant
// messages and resolves the sandbox proxy iframe's contentWindow by its src so
// each record carries the event.source identity (criterion 4).
async function installSpikeProbe(): Promise<void> {
	const w = window as unknown as { __spikeProbe?: { installedAt: number; messages: unknown[] } }
	if (w.__spikeProbe) return
	w.__spikeProbe = { installedAt: Date.now(), messages: [] }
	window.addEventListener("message", (event) => {
		const data = event.data as { type?: unknown; nonce?: unknown } | null
		if (!data || typeof data.type !== "string") return
		if (data.type !== "mcp-app-sandbox-proxy-ready" && data.type !== "SPIKE_RELAY_PROBE") return
		const proxyFrames = Array.from(document.querySelectorAll("iframe"))
			.map((frame) => frame as HTMLIFrameElement)
			// The proxy mounts as a blob: URL (primary) or the asWebviewUri route
			// (fallback); match either so sourceIsProxyFrame stays meaningful.
			.filter((frame) => {
				const src = frame.getAttribute("src") ?? ""
				return src.includes("mcp-app-sandbox-proxy.html") || src.startsWith("blob:")
			})
		const proxyWindow = proxyFrames.length > 0 ? proxyFrames[proxyFrames.length - 1]!.contentWindow : null
		w.__spikeProbe!.messages.push({
			type: data.type,
			nonce: typeof data.nonce === "string" ? data.nonce : undefined,
			sourceIsProxyFrame: proxyWindow !== null && event.source === proxyWindow,
			ts: Date.now(),
		})
	})
}

async function readSpikeProbe(frame: Frame): Promise<ProbeState | null> {
	return frame.evaluate(() => {
		const w = window as unknown as { __spikeProbe?: ProbeState }
		return w.__spikeProbe ?? null
	})
}

// Phase-1 diagnostic dump (spike instrumentation): captures the full frame
// tree, the webview DOM's iframe list, and the injected proxy URI so a failing
// run shows WHICH layer is missing its witness (probe window, proxy iframe
// mount, or Playwright frame enumeration).
async function dumpSpikeDiagnostics(
	page: Page,
	parentFrame: Frame,
	contentFrame: Frame,
	tag: string,
	extra: Record<string, unknown>,
	testInfo: TestInfo,
) {
	const diagnostics = {
		tag,
		timestamp: new Date().toISOString(),
		frameUrls: page.frames().map((frame) => frame.url()),
		childFrameUrls: parentFrame.childFrames().map((frame) => frame.url()),
		requestFailures: requestFailuresSnapshot(),
		proxyConsoleLines: proxyConsoleSnapshot(),
		webviewDom: await contentFrame
			.evaluate(() => {
				const w = window as unknown as {
					MCP_APP_SANDBOX_PROXY_URI?: string
					MCP_APP_SANDBOX_PROXY_HTML?: string
				}
				return {
					href: window.location.href,
					proxyUri: w.MCP_APP_SANDBOX_PROXY_URI ?? null,
					injectedProxyHtmlLength: w.MCP_APP_SANDBOX_PROXY_HTML?.length ?? null,
					iframes: Array.from(document.querySelectorAll("iframe")).map((frame) => ({
						src: frame.getAttribute("src"),
						sandbox: frame.getAttribute("sandbox"),
						hasContentWindow: (frame as HTMLIFrameElement).contentWindow !== null,
					})),
				}
			})
			.catch((error: unknown) => ({ error: String(error) })),
		...extra,
	}
	const body = `${JSON.stringify(diagnostics, null, 2)}\n`
	await fs.writeFile(path.join(evidenceDir, `spike-diagnostics-${tag}.json`), body, "utf8").catch(() => undefined)
	await testInfo
		.attach(`spike-diagnostics-${tag}.json`, { body, contentType: "application/json" })
		.catch(() => undefined)
}

test.describe.configure({ mode: "serial" })

let vscodeExecutablePath: string
test.beforeAll(async () => {
	vscodeExecutablePath = await downloadAndUnzipVSCode({ version: vscodeVersion, extensionDevelopmentPath })
})

test("MCP Apps dev-host spike: all four criteria observed in the real webview", async ({
	browserName: _browserName,
}, testInfo) => {
	test.setTimeout(8 * 60_000)

	const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "zoo-code-mcp-apps-spike-"))
	const workspacePath = path.join(temporaryRoot, "workspace")
	const userDataPath = path.join(temporaryRoot, "user-data")
	const extensionsPath = path.join(temporaryRoot, "extensions")
	const readyPath = path.join(temporaryRoot, "ready.json")
	const armPath = path.join(temporaryRoot, "arm")
	const donePath = path.join(temporaryRoot, "done")
	const logPath = path.join(temporaryRoot, "spike-scene.log")
	const uiReadPath = path.join(workspacePath, "mcp-apps-spike", "server-ready.ui-read")
	await Promise.all([fs.mkdir(workspacePath), fs.mkdir(userDataPath), fs.mkdir(extensionsPath)])
	await fs.mkdir(evidenceDir, { recursive: true })

	let app: ElectronApplication | undefined
	let mock: InstanceType<typeof LLMock> | undefined
	let page: Page | undefined
	let parentFrame: Frame | undefined
	let contentFrame: Frame | undefined
	let probeState: ProbeState | null = null
	let contentFrameIsFallback = false
	let consoleMessageCount = 0

	try {
		mock = new LLMock({ port: 0 })
		addMcpAppsFixtures(mock)
		await mock.start()

		app = await _electron.launch({
			executablePath: vscodeExecutablePath,
			args: [
				workspacePath,
				`--extensionDevelopmentPath=${extensionDevelopmentPath}`,
				`--extensionTestsPath=${extensionTestsPath}`,
				`--user-data-dir=${userDataPath}`,
				`--extensions-dir=${extensionsPath}`,
				"--disable-workspace-trust",
				"--skip-welcome",
				"--skip-release-notes",
				"--disable-updates",
				"--disable-gpu",
				"--force-device-scale-factor=1",
			],
			env: {
				...process.env,
				AIMOCK_URL: mock.url ?? "",
				ROO_CODE_SPIKE_READY_PATH: readyPath,
				ROO_CODE_SPIKE_ARM_PATH: armPath,
				ROO_CODE_SPIKE_DONE_PATH: donePath,
				ROO_CODE_SPIKE_UI_READ_PATH: uiReadPath,
				ROO_CODE_SPIKE_LOG_PATH: logPath,
			},
			locale: "en-US",
			timeout: 90_000,
			timezoneId: "UTC",
		})
		await app.context().tracing.start({ screenshots: true, snapshots: true, sources: true })
		page = await app.firstWindow({ timeout: 90_000 })
		await app.evaluate(({ BrowserWindow }) => {
			const window = BrowserWindow.getAllWindows()[0]
			window?.setBounds({ x: 0, y: 0, width: 1400, height: 900 })
			window?.focus()
		})
		page.on("console", (msg: ConsoleMessage) => {
			consoleMessageCount += 1
			const frameUrl = msg.location().url
			const text = msg.text()
			if (
				frameUrl.includes("mcp-app-sandbox-proxy") ||
				frameUrl.startsWith("blob:") ||
				// Sandboxed srcdoc frames report an empty location URL (or
				// about:srcdoc) in this Electron build; capture their CSP
				// verdicts as c1 evidence.
				((frameUrl === "" || frameUrl === "about:srcdoc") && text.includes("Content Security Policy")) ||
				text.includes("[proxy] relay:")
			) {
				proxyConsoleLines.push(`${msg.type()} [${frameUrl.slice(0, 120)}] ${text.slice(0, 300)}`)
				if (proxyConsoleLines.length > 200) proxyConsoleLines.shift()
			}
		})
		page.on("requestfailed", (request) => {
			const url = request.url()
			if (url.includes("vscode-cdn.net") || url.includes("mcp-app-sandbox")) {
				requestFailures.push(`${url.slice(0, 160)} :: ${request.failure()?.errorText ?? "unknown"}`)
				if (requestFailures.length > 200) requestFailures.shift()
			}
		})

		await waitForJson<{ vscodeVersion: string }>(readyPath, 180_000)

		// Locate the Zoo Code webview content frame (same frame model as the
		// visual harness): outer extension iframe -> inner content iframe.
		await expect
			.poll(
				() => page!.frames().some((frame) => frame.url().includes("extensionId=ZooCodeOrganization.zoo-code")),
				{ timeout: 90_000 },
			)
			.toBe(true)
		parentFrame = page!.frames().find((frame) => frame.url().includes("extensionId=ZooCodeOrganization.zoo-code"))!
		contentFrame = parentFrame.childFrames().find((frame) => frame.url().includes("/fake.html"))
		if (!contentFrame) {
			// Tolerate frame-layout drift: fall back to the extension frame itself.
			contentFrame = parentFrame
			contentFrameIsFallback = true
		}

		// Arm the probe BEFORE the task starts so the proxy's parse-time ready
		// ping is observed, then release the scene controller.
		await contentFrame.evaluate(installSpikeProbe)
		await fs.writeFile(armPath, "armed\n", "utf8")

		// Poll for both spike messages at the webview window. c1: app inline script
		// executed inside the proxy document (strict-dynamic re-execution), witnessed
		// as the relay probe arriving at the host window; c2b: that same relay probe
		// is the inner->host witness; c4 rides its source identity (see below).
		const probeDeadline = Date.now() + 150_000
		for (;;) {
			probeState = await readSpikeProbe(contentFrame)
			const ping = probeState?.messages.find((message) => message.type === PROXY_READY_PING)
			const relay = probeState?.messages.find(
				(message) => message.type === RELAY_PROBE && message.nonce === SPIKE_NONCE,
			)
			if (ping && relay) break
			if (Date.now() > probeDeadline) break
			await sleep(500)
		}
		const ping = probeState?.messages.find((message) => message.type === PROXY_READY_PING) ?? null
		const relayProbe =
			probeState?.messages.find((message) => message.type === RELAY_PROBE && message.nonce === SPIKE_NONCE) ??
			null

		// Hypothesis witness: fetch the proxy resource from the TOP webview frame
		// (service-worker-served). If this succeeds while the sandboxed proxy
		// iframe shows chrome-error, the root cause is sandboxed frames bypassing
		// the webview service worker for the vscode-resource CDN route.
		const proxyFetch = await contentFrame
			.evaluate(async () => {
				const w = window as unknown as { MCP_APP_SANDBOX_PROXY_URI?: string }
				if (!w.MCP_APP_SANDBOX_PROXY_URI) return { error: "proxy uri unset" }
				try {
					const res = await fetch(w.MCP_APP_SANDBOX_PROXY_URI)
					return { status: res.status, ok: res.ok, head: (await res.text()).slice(0, 120) }
				} catch (error) {
					return { error: String(error) }
				}
			})
			.catch((error: unknown) => ({ evaluateFailed: String(error) }))

		// Checkpoint diagnostic: shows the frame tree, webview iframes, and probe
		// state at the moment the relay/ping witnesses were (not) observed.
		await dumpSpikeDiagnostics(
			page!,
			parentFrame,
			contentFrame,
			"post-probe",
			{ contentFrameIsFallback, probeState, proxyFetch },
			testInfo,
		)

		// Render-into-proxy fallback: the app renders INSIDE the blob-mounted proxy
		// document (no nested srcdoc frame). The card text is the c2a artifact.
		const proxyFrame = page!.frames().find((frame) => frame.url().startsWith("blob:"))
		await expect
			.poll(() => page!.frames().some((frame) => frame.url().startsWith("blob:")), { timeout: 60_000 })
			.toBe(true)
		const srcdocCardText = await proxyFrame!.locator("#card").textContent()

		// Criterion 3: the webview app itself is healthy end to end (the task
		// ran through completion and its result renders in the chat UI).
		await contentFrame
			.getByText("Card rendered.", { exact: false })
			.first()
			.waitFor({ state: "visible", timeout: 90_000 })

		const evidence: SpikeEvidence = {
			vscodeVersion: vscodeVersion,
			timestamp: new Date().toISOString(),
			criteria: {
				c1InnerScriptExecuted: relayProbe !== null,
				c2aHostToInnerDelivery: srcdocCardText === "hello-mcp-app",
				c2bInnerToHostRelay: relayProbe !== null,
				c3WebviewAppUnaffected: srcdocCardText === "hello-mcp-app",
				c4HostWindowSeam: ping?.sourceIsProxyFrame === true && relayProbe?.sourceIsProxyFrame === true,
			},
			ping,
			relayProbe,
			probeMessages: probeState?.messages ?? [],
			srcdocCardText,
			completionLandmarkVisible: true,
			proxyConsoleLines,
			consoleMessageCount,
		}

		await page.screenshot({ path: path.join(evidenceDir, "workbench.png") })
		const webviewLocator = page!.locator('iframe[src*="extensionId=ZooCodeOrganization.zoo-code"]')
		await expect(webviewLocator).toHaveCount(1)
		await webviewLocator.screenshot({ path: path.join(evidenceDir, "webview.png") }).catch(() => undefined)
		const evidenceJson = `${JSON.stringify(evidence, null, 2)}\n`
		await fs.writeFile(path.join(evidenceDir, "spike-evidence.json"), evidenceJson, "utf8")
		await testInfo.attach("spike-evidence.json", { body: evidenceJson, contentType: "application/json" })
		await attachLogs(userDataPath, logPath, testInfo)

		// The four PASS criteria, machine-verified.
		expect(evidence.criteria.c1InnerScriptExecuted).toBe(true)
		expect(evidence.criteria.c2aHostToInnerDelivery).toBe(true)
		expect(evidence.criteria.c2bInnerToHostRelay).toBe(true)
		expect(evidence.criteria.c3WebviewAppUnaffected).toBe(true)
		expect(evidence.criteria.c4HostWindowSeam).toBe(true)
		expect(ping?.sourceIsProxyFrame).toBe(true)
		expect(relayProbe?.nonce).toBe(SPIKE_NONCE)
	} catch (error) {
		if (page) await page.screenshot({ path: testInfo.outputPath("spike-workbench.png") }).catch(() => undefined)
		if (page && parentFrame && contentFrame) {
			await dumpSpikeDiagnostics(
				page,
				parentFrame,
				contentFrame,
				"failure",
				{ contentFrameIsFallback, probeState },
				testInfo,
			).catch(() => undefined)
		}
		await attachLogs(userDataPath, logPath, testInfo, true)
		await fs.writeFile(donePath, "done\n", "utf8").catch(() => undefined)
		if (app) {
			await app
				.context()
				.tracing.stop({ path: testInfo.outputPath("spike-trace.zip") })
				.catch(() => undefined)
		}
		throw error
	} finally {
		await fs.writeFile(donePath, "done\n", "utf8").catch(() => undefined)
		if (app) {
			await app
				.context()
				.tracing.stop({ path: testInfo.outputPath("spike-trace.zip") })
				.catch(() => undefined)
			await app.close().catch(() => undefined)
		}
		await mock?.stop().catch(() => undefined)
		await fs.rm(temporaryRoot, { recursive: true, force: true })
	}
})
