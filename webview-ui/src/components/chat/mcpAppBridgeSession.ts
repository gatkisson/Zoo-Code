import { AppBridge, PostMessageTransport } from "@modelcontextprotocol/ext-apps/app-bridge"

import { requestMcpApp, type McpAppMethod } from "@src/services/mcp-app/useMcpAppBridge"

export type McpAppBridgeSession = { start: (iframeWindow: Window) => void; dispose: () => void }

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
 * work without an MCP Client. The proxy document (Task 8/9 Step 0) relays
 * inner-frame messages with itself as `event.source`, which satisfies
 * PostMessageTransport's source validation.
 */
export function createMcpAppBridgeSession(opts: {
	serverName: string
	source?: "global" | "project"
	onToolCall?: (toolName: string, args: Record<string, unknown>) => Promise<boolean> // approval gate; false = deny
}): McpAppBridgeSession {
	const proxy = async (method: McpAppMethod, params: Record<string, unknown>) =>
		requestMcpApp({ serverName: opts.serverName, source: opts.source, method, params })

	// serverTools/serverResources advertise the two proxied methods; openLinks is
	// advertised now and wired to a handler in Task 10 (plan Step 4 of that task).
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
	}
}
