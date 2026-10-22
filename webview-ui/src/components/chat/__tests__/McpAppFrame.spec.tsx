import { type Mock } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"

import McpAppFrame from "../McpAppFrame"
import { requestMcpApp } from "@src/services/mcp-app/useMcpAppBridge"

vi.mock("@src/services/mcp-app/useMcpAppBridge", () => ({ requestMcpApp: vi.fn() }))

const state = { mcpAppsEnabled: true }
vi.mock("@src/context/ExtensionStateContext", () => ({
	useExtensionState: () => state,
}))

vi.mock("../mcpAppBridgeSession", () => ({
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
})
