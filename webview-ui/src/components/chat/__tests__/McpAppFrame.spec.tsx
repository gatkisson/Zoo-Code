import { type Mock } from "vitest"
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import McpAppFrame from "../McpAppFrame"
import { requestMcpApp } from "@src/services/mcp-app/useMcpAppBridge"

vi.mock("@src/services/mcp-app/useMcpAppBridge", () => ({ requestMcpApp: vi.fn() }))

const state = { mcpAppsEnabled: true }
vi.mock("@src/context/ExtensionStateContext", () => ({
	useExtensionState: () => state,
}))

// importActual keeps isSafeAppUrl real (the scheme-allowlist tests exercise the
// real module); only the session factory stays mocked.
vi.mock("../mcpAppBridgeSession", async () => ({
	...(await vi.importActual("../mcpAppBridgeSession")),
	createMcpAppBridgeSession: vi.fn(() => ({ start: vi.fn(), dispose: vi.fn() })),
}))

// t(key, defaultValue | { defaultValue, ...vars }) -> interpolated default.
vi.mock("react-i18next", () => ({
	useTranslation: () => ({
		t: (key: string, options?: unknown) => {
			if (typeof options === "string") {
				return options
			}
			const opts = (options ?? {}) as Record<string, unknown>
			const template = typeof opts.defaultValue === "string" ? opts.defaultValue : key
			return Object.entries(opts)
				.filter(([k]) => k !== "defaultValue")
				.reduce((acc: string, [k, v]) => acc.replace(new RegExp(`{{${k}}}`, "g"), String(v)), template)
		},
	}),
}))

const baseProps = {
	serverName: "demo",
	source: "global" as const,
	toolName: "card",
	toolMeta: { ui: { resourceUri: "ui://demo/card" } },
	resultMeta: undefined,
	argumentsJson: "{}",
	responseText: "",
	alwaysAllow: false,
	alwaysAllowMcp: false,
}

describe("McpAppFrame", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		state.mcpAppsEnabled = true
		;(window as unknown as { MCP_APP_SANDBOX_PROXY_URI?: string }).MCP_APP_SANDBOX_PROXY_URI =
			"vscode-webview://test-csp/assets/mcp-app-sandbox-proxy.html"
		;(requestMcpApp as Mock).mockResolvedValue({
			contents: [
				{ uri: "ui://demo/card", mimeType: "text/html;profile=mcp-app", text: "<html><body>ok</body></html>" },
			],
		})
	})

	it("renders nothing when the feature flag is off", () => {
		state.mcpAppsEnabled = false
		const { container } = render(<McpAppFrame {...baseProps} />)
		expect(container.innerHTML).toBe("")
		expect(requestMcpApp).not.toHaveBeenCalled()
	})

	it("renders nothing when the tool declares no UI resource", () => {
		const { container } = render(<McpAppFrame {...baseProps} toolMeta={undefined} />)
		expect(container.innerHTML).toBe("")
	})

	it("fetches the ui:// resource through the bridge and mounts the sandbox proxy iframe", async () => {
		const { container } = render(<McpAppFrame {...baseProps} />)

		await waitFor(() => expect(requestMcpApp).toHaveBeenCalledTimes(1))
		expect(requestMcpApp).toHaveBeenCalledWith({
			serverName: "demo",
			source: "global",
			method: "resources/read",
			params: { uri: "ui://demo/card" },
		})

		const iframe = container.querySelector("iframe")
		expect(iframe).not.toBeNull()
		expect(iframe!.getAttribute("sandbox")).toBe("allow-scripts allow-forms allow-popups")
		expect((iframe! as HTMLIFrameElement).src).toContain("mcp-app-sandbox-proxy.html")
	})

	it("prefers a result-level _meta UI override over the tool declaration", async () => {
		render(<McpAppFrame {...baseProps} resultMeta={{ ui: { resourceUri: "ui://demo/result-card" } }} />)

		await waitFor(() => expect(requestMcpApp).toHaveBeenCalledTimes(1))
		expect(requestMcpApp).toHaveBeenCalledWith(
			expect.objectContaining({ params: { uri: "ui://demo/result-card" } }),
		)
	})

	it("shows an error state when the fetch fails", async () => {
		;(requestMcpApp as Mock).mockRejectedValue(new Error("server offline"))
		render(<McpAppFrame {...baseProps} />)

		await waitFor(() => expect(screen.getByText(/mcp app ui unavailable/i)).toBeInTheDocument())
		expect(screen.getByText(/server offline/)).toBeInTheDocument()
	})

	it("resizes when the size report comes from this frame's own contentWindow", async () => {
		const { container } = render(<McpAppFrame {...baseProps} />)
		await waitFor(() => expect(container.querySelector("iframe")).not.toBeNull())
		const frame = container.querySelector("iframe") as HTMLIFrameElement
		expect(frame.style.height).toBe("240px")

		act(() => {
			window.dispatchEvent(
				new MessageEvent("message", {
					data: { type: "ui/notifications/size-changed", height: 500 },
					source: frame.contentWindow,
				}),
			)
		})

		expect(frame.style.height).toBe("500px")
	})

	it("ignores size reports whose source is not this frame's contentWindow", async () => {
		const { container } = render(<McpAppFrame {...baseProps} />)
		await waitFor(() => expect(container.querySelector("iframe")).not.toBeNull())
		const frame = container.querySelector("iframe") as HTMLIFrameElement

		// A sibling frame stands in for a hostile grandchild posting straight to
		// the webview top (or another McpAppFrame instance's relay): it must not
		// resize this frame.
		const hostile = document.createElement("iframe")
		document.body.appendChild(hostile)
		act(() => {
			window.dispatchEvent(
				new MessageEvent("message", {
					data: { type: "ui/notifications/size-changed", height: 999 },
					source: hostile.contentWindow,
				}),
			)
		})

		expect(frame.style.height).toBe("240px")
		hostile.remove()
	})

	it("renders nothing when the sandbox proxy URI is unset", async () => {
		;(window as unknown as { MCP_APP_SANDBOX_PROXY_URI?: string }).MCP_APP_SANDBOX_PROXY_URI = ""
		const { container } = render(<McpAppFrame {...baseProps} />)

		await waitFor(() => expect(requestMcpApp).toHaveBeenCalledTimes(1))
		// A buggy build mounts <iframe src=""> once the resource resolves, which
		// self-nests the webview; the fixed build renders nothing at all.
		await waitFor(() => expect(container.innerHTML).toBe(""))
		expect(container.querySelector("iframe")).toBeNull()
	})
})

describe("McpAppFrame approval gate", () => {
	// Top-level describes do not inherit the outer beforeEach, so mirror its
	// setup here (plan ruling: verbatim test bodies need the mocks primed).
	beforeEach(() => {
		vi.clearAllMocks()
		state.mcpAppsEnabled = true
		;(window as unknown as { MCP_APP_SANDBOX_PROXY_URI?: string }).MCP_APP_SANDBOX_PROXY_URI =
			"vscode-webview://test-csp/assets/mcp-app-sandbox-proxy.html"
		;(requestMcpApp as Mock).mockResolvedValue({
			contents: [
				{ uri: "ui://demo/card", mimeType: "text/html;profile=mcp-app", text: "<html><body>ok</body></html>" },
			],
		})
	})

	it("asks for confirmation when the tool is not always-allowed and resolves on Allow", async () => {
		const { createMcpAppBridgeSession } = await import("../mcpAppBridgeSession")
		let capturedOnToolCall: ((name: string, args: Record<string, unknown>) => Promise<boolean>) | undefined
		;(createMcpAppBridgeSession as Mock).mockImplementation((opts) => {
			capturedOnToolCall = opts.onToolCall
			return { start: vi.fn(), dispose: vi.fn() }
		})

		const { getByRole, findByText, container } = render(<McpAppFrame {...baseProps} alwaysAllow={false} />)
		// jsdom never loads the iframe's src, so fire load() manually once the HTML has
		// been fetched and the iframe is mounted (onIframeLoad then creates the session).
		await waitFor(() => expect(container.querySelector("iframe")).not.toBeNull())
		fireEvent.load(container.querySelector("iframe")!)
		await waitFor(() => expect(createMcpAppBridgeSession).toHaveBeenCalled())

		const denyPromise = capturedOnToolCall!("dangerous", {})
		const prompt = await findByText(/run demo\/dangerous/i)
		expect(prompt).toBeInTheDocument()

		await userEvent.click(getByRole("button", { name: /deny/i }))
		await expect(denyPromise).resolves.toBe(false)
	})

	it("auto-approves when alwaysAllow is set on the tool", async () => {
		const { createMcpAppBridgeSession } = await import("../mcpAppBridgeSession")
		let capturedOnToolCall: ((name: string, args: Record<string, unknown>) => Promise<boolean>) | undefined
		;(createMcpAppBridgeSession as Mock).mockImplementation((opts) => {
			capturedOnToolCall = opts.onToolCall
			return { start: vi.fn(), dispose: vi.fn() }
		})

		const { container } = render(<McpAppFrame {...baseProps} alwaysAllow />)
		await waitFor(() => expect(container.querySelector("iframe")).not.toBeNull())
		fireEvent.load(container.querySelector("iframe")!)
		await waitFor(() => expect(createMcpAppBridgeSession).toHaveBeenCalled())

		await expect(capturedOnToolCall!("safe", {})).resolves.toBe(true)
	})

	it("settles a pending approval as denied when the frame unmounts", async () => {
		const { createMcpAppBridgeSession } = await import("../mcpAppBridgeSession")
		let capturedOnToolCall: ((name: string, args: Record<string, unknown>) => Promise<boolean>) | undefined
		;(createMcpAppBridgeSession as Mock).mockImplementation((opts) => {
			capturedOnToolCall = opts.onToolCall
			return { start: vi.fn(), dispose: vi.fn() }
		})

		const { container, unmount, findByText } = render(<McpAppFrame {...baseProps} alwaysAllow={false} />)
		await waitFor(() => expect(container.querySelector("iframe")).not.toBeNull())
		fireEvent.load(container.querySelector("iframe")!)
		await waitFor(() => expect(createMcpAppBridgeSession).toHaveBeenCalled())

		const pending = capturedOnToolCall!("dangerous", {})
		await findByText(/run demo\/dangerous/i)

		// T10-M1: teardown must settle the open prompt (deny-on-teardown) rather
		// than leaving the app-side callTool hanging.
		unmount()
		await expect(pending).resolves.toBe(false)
	})

	it("reads the approval flags at call time, not iframe-load time", async () => {
		const { createMcpAppBridgeSession } = await import("../mcpAppBridgeSession")
		let capturedOnToolCall: ((name: string, args: Record<string, unknown>) => Promise<boolean>) | undefined
		;(createMcpAppBridgeSession as Mock).mockImplementation((opts) => {
			capturedOnToolCall = opts.onToolCall
			return { start: vi.fn(), dispose: vi.fn() }
		})

		const { container, findByText, getByRole, rerender } = render(
			<McpAppFrame {...baseProps} alwaysAllow={false} />,
		)
		await waitFor(() => expect(container.querySelector("iframe")).not.toBeNull())
		fireEvent.load(container.querySelector("iframe")!)
		await waitFor(() => expect(createMcpAppBridgeSession).toHaveBeenCalled())

		// Gate created while alwaysAllow was false; settle the first prompt.
		const gated = capturedOnToolCall!("late", {})
		await findByText(/run demo\/late/i)
		fireEvent.click(getByRole("button", { name: /deny/i }))
		await expect(gated).resolves.toBe(false)

		// T10-M2: the flag flips AFTER session creation; the next call must see it.
		rerender(<McpAppFrame {...baseProps} alwaysAllow />)
		await expect(capturedOnToolCall!("late", {})).resolves.toBe(true)
	})
})

describe("isSafeAppUrl", () => {
	it("allows only https, http and mailto schemes", async () => {
		const { isSafeAppUrl } = await import("../mcpAppBridgeSession")
		expect(isSafeAppUrl("https://example.com")).toBe(true)
		expect(isSafeAppUrl("http://localhost:3000/x")).toBe(true)
		expect(isSafeAppUrl("mailto:someone@example.com")).toBe(true)
		expect(isSafeAppUrl("vscode://extension/command")).toBe(false)
		expect(isSafeAppUrl("javascript:alert(1)")).toBe(false)
		expect(isSafeAppUrl("not a url")).toBe(false)
	})
})
