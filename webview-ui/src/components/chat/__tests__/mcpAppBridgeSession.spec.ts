import { type Mock } from "vitest"
import { type AppBridge } from "@modelcontextprotocol/ext-apps/app-bridge"

import { createMcpAppBridgeSession, type McpAppBridgeSession } from "../mcpAppBridgeSession"
import { requestMcpApp } from "@src/services/mcp-app/useMcpAppBridge"
import { vscode } from "@src/utils/vscode"

vi.mock("@src/services/mcp-app/useMcpAppBridge", () => ({ requestMcpApp: vi.fn() }))
vi.mock("@src/utils/vscode", () => ({ vscode: { postMessage: vi.fn() } }))

// The AppBridge handler signatures require a RequestHandlerExtra even though our
// handlers ignore it; this typed double also proves sendRequest is never touched.
type BridgeRequestExtra = Parameters<NonNullable<AppBridge["oncalltool"]>>[1]

const makeExtra = (): BridgeRequestExtra => ({
	signal: new AbortController().signal,
	requestId: "test-request-id",
	sendNotification: async () => {},
	sendRequest: async () => {
		throw new Error("sendRequest must not be used by bridge handlers")
	},
})

// The session exposes its AppBridge so tests can drive the registered handlers
// directly (Task 9 review T9-I2, deviation D13).
const bridgeOf = (session: McpAppBridgeSession): AppBridge => {
	expect(session.bridge).toBeDefined()
	return session.bridge
}

describe("createMcpAppBridgeSession", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("denies the tool call without proxying when onToolCall resolves false", async () => {
		const session = createMcpAppBridgeSession({
			serverName: "demo",
			source: "global",
			onToolCall: async () => false,
		})
		const oncalltool = bridgeOf(session).oncalltool
		expect(oncalltool).toBeDefined()

		await expect(oncalltool!({ name: "do_thing", arguments: { a: 1 } }, makeExtra())).rejects.toThrow(
			"User denied the tool call",
		)
		expect(requestMcpApp).not.toHaveBeenCalled()
	})

	it("proxies tools/call with name and arguments when no approval gate is configured", async () => {
		const proxiedResult = { content: [{ type: "text" as const, text: "done" }] }
		;(requestMcpApp as Mock).mockResolvedValue(proxiedResult)

		const session = createMcpAppBridgeSession({ serverName: "demo", source: "project" })
		const oncalltool = bridgeOf(session).oncalltool
		expect(oncalltool).toBeDefined()

		const result = await oncalltool!({ name: "do_thing", arguments: { a: 1 } }, makeExtra())

		expect(requestMcpApp).toHaveBeenCalledWith({
			serverName: "demo",
			source: "project",
			method: "tools/call",
			params: { name: "do_thing", arguments: { a: 1 } },
		})
		expect(result).toBe(proxiedResult)
	})

	it("forwards resources/read with the requested uri", async () => {
		const proxiedResult = { contents: [{ uri: "ui://demo/card", text: "<html/>" }] }
		;(requestMcpApp as Mock).mockResolvedValue(proxiedResult)

		const session = createMcpAppBridgeSession({ serverName: "demo", source: "global" })
		const onreadresource = bridgeOf(session).onreadresource
		expect(onreadresource).toBeDefined()

		const result = await onreadresource!({ uri: "ui://demo/card" }, makeExtra())

		expect(requestMcpApp).toHaveBeenCalledWith({
			serverName: "demo",
			source: "global",
			method: "resources/read",
			params: { uri: "ui://demo/card" },
		})
		expect(result).toBe(proxiedResult)
	})
})

// Task 10 review T10-I1: the open-link/message handlers are security glue around
// isSafeAppUrl and must be pinned through the D13 bridge seam. Top-level describes
// do not inherit the outer beforeEach (D-10a lesson), so each mirrors its clearing.
describe("open-link handler", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("posts openExternal for a safe URL and returns an empty result", async () => {
		const session = createMcpAppBridgeSession({ serverName: "demo", source: "global" })
		const onopenlink = bridgeOf(session).onopenlink
		expect(onopenlink).toBeDefined()

		await expect(onopenlink!({ url: "https://example.com/x" }, makeExtra())).resolves.toEqual({})
		expect(vscode.postMessage).toHaveBeenCalledWith({ type: "openExternal", url: "https://example.com/x" })
	})

	it("drops an unsafe URL without posting and reports isError", async () => {
		const session = createMcpAppBridgeSession({ serverName: "demo", source: "global" })
		const onopenlink = bridgeOf(session).onopenlink
		expect(onopenlink).toBeDefined()

		await expect(onopenlink!({ url: "vscode://extension/command" }, makeExtra())).resolves.toEqual({
			isError: true,
		})
		expect(vscode.postMessage).not.toHaveBeenCalled()
	})
})

describe("message handler", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("joins text blocks with newlines and posts insertTextIntoTextarea; non-text blocks are dropped", async () => {
		const session = createMcpAppBridgeSession({ serverName: "demo", source: "global" })
		const onmessage = bridgeOf(session).onmessage
		expect(onmessage).toBeDefined()

		await onmessage!(
			{
				role: "user",
				content: [
					{ type: "text", text: "line one" },
					{ type: "image", data: "Zm9v", mimeType: "image/png" },
					{ type: "text", text: "line two" },
				],
			},
			makeExtra(),
		)
		expect(vscode.postMessage).toHaveBeenCalledWith({
			type: "insertTextIntoTextarea",
			text: "line one\nline two",
		})
	})

	it("posts nothing when no text blocks are present", async () => {
		const session = createMcpAppBridgeSession({ serverName: "demo", source: "global" })
		await bridgeOf(session).onmessage!({ role: "user", content: [] }, makeExtra())
		expect(vscode.postMessage).not.toHaveBeenCalled()
	})
})
