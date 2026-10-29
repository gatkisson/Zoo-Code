import { AppBridge, PostMessageTransport } from "@modelcontextprotocol/ext-apps/app-bridge"

import { requestMcpApp, type McpAppMethod } from "@src/services/mcp-app/useMcpAppBridge"
import { vscode } from "@src/utils/vscode"

const SAFE_APP_URL_SCHEMES = new Set(["https:", "http:", "mailto:"])

export function isSafeAppUrl(raw: string): boolean {
	try {
		return SAFE_APP_URL_SCHEMES.has(new URL(raw).protocol)
	} catch {
		return false
	}
}

export type McpAppBridgeSession = {
	start: (iframeWindow: Window) => void
	dispose: () => void
	// Exposes the AppBridge so tests can drive the registered handlers directly
	// (Task 9 review T9-I2, deviation D13); production code uses start/dispose only.
	bridge: AppBridge
}

// Handler result types are derived from the installed AppBridge setter signatures
// (@modelcontextprotocol/ext-apps 1.7.5) instead of importing SDK types directly,
// because requestMcpApp returns untyped JSON-RPC results and the SDK is only a
// transitive (peer) dependency of ext-apps, not declared by webview-ui.
type ReadResourceHandler = NonNullable<AppBridge["onreadresource"]>
type CallToolHandler = NonNullable<AppBridge["oncalltool"]>

/**
 * Host-side bridge session for one mounted app frame. AppBridge runs in
 * null-client mode (the real MCP Client lives in the extension host); every
 * proxied request is forwarded over the mcpAppRequest message pair (Task 6).
 *
 * Verified against the installed ext-apps 1.7.5 typings: handlers are
 * lowercase setter properties (`onreadresource` / `oncalltool`), the transport
 * is `PostMessageTransport(iframeWindow, iframeWindow)`, and AppBridge's
 * capability assertions are no-ops in null-client mode, so manual handlers
 * work without an MCP Client. App scripts run in the proxy document itself
 * (render-into-proxy, Task 8/9); AppBridge traffic posted to window.parent (the
 * webview window) arrives with `event.source` set to the frame's contentWindow,
 * which satisfies PostMessageTransport's source validation.
 */
export function createMcpAppBridgeSession(opts: {
	serverName: string
	source?: "global" | "project"
	onToolCall?: (toolName: string, args: Record<string, unknown>) => Promise<boolean> // approval gate; false = deny
}): McpAppBridgeSession {
	const proxy = async (method: McpAppMethod, params: Record<string, unknown>) =>
		requestMcpApp({ serverName: opts.serverName, source: opts.source, method, params })

	// All three advertised capabilities now have handlers (openLinks wired in Task 10).
	const bridge = new AppBridge(
		null,
		{ name: "Zoo Code", version: "1.0.0" },
		{ openLinks: {}, serverTools: {}, serverResources: {} },
	)

	bridge.onreadresource = async (params) =>
		(await proxy("resources/read", { uri: params.uri })) as Awaited<ReturnType<ReadResourceHandler>>

	bridge.oncalltool = async (params) => {
		if (opts.onToolCall && !(await opts.onToolCall(params.name, params.arguments ?? {}))) {
			throw new Error("User denied the tool call")
		}
		return (await proxy("tools/call", {
			name: params.name,
			arguments: params.arguments ?? {},
		})) as Awaited<ReturnType<CallToolHandler>>
	}

	// ui/open-link: scheme-allowlisted external links only; unsafe URLs are dropped
	// silently (isError tells the app the host refused, per McpUiOpenLinkResult).
	bridge.onopenlink = async ({ url }) => {
		if (!isSafeAppUrl(url)) {
			console.log("[mcp-apps] Blocked open-link request for unsafe URL:", url)
			return { isError: true }
		}
		vscode.postMessage({ type: "openExternal", url })
		return {}
	}

	// ui/message: user-visible draft into the chat textarea; the user presses send
	// (architecture decision: no silent injection). Non-text blocks are dropped.
	bridge.onmessage = async ({ content }) => {
		const text = content.flatMap((block) => (block.type === "text" ? [block.text] : []))
		if (text.length > 0) {
			vscode.postMessage({ type: "insertTextIntoTextarea", text: text.join("\n") })
		}
		return {}
	}

	return {
		start: (iframeWindow) => {
			const transport = new PostMessageTransport(iframeWindow, iframeWindow)
			void bridge.connect(transport).catch((error: unknown) => {
				console.error("[mcp-apps] App bridge connection failed:", error)
			})
		},
		dispose: () => {
			bridge.close()
		},
		bridge,
	}
}
