import type { ExtensionMessage } from "@roo-code/types"

import { vscode } from "@src/utils/vscode"

export type McpAppMethod = "resources/read" | "tools/call"

type PendingEntry = {
	resolve: (value: unknown) => void
	reject: (reason: Error) => void
	timer: ReturnType<typeof setTimeout>
}

const pending = new Map<string, PendingEntry>()
let listenerInstalled = false

function onResponseMessage(event: MessageEvent<ExtensionMessage>) {
	const message = event.data
	if (message?.type !== "mcpAppResponse" || !message.requestId) {
		return
	}

	const entry = pending.get(message.requestId)
	if (!entry) {
		return
	}

	pending.delete(message.requestId)
	clearTimeout(entry.timer)

	const payload = message.mcpAppResponse
	if (payload?.ok) {
		entry.resolve(payload.result)
	} else {
		entry.reject(new Error(payload?.error?.message ?? "MCP App request failed"))
	}
}

/**
 * Fire a proxied MCP Apps request at the extension host and await the
 * correlated response. Correlation follows the requestId precedent used by
 * themeFixtureProbe (src/core/webview/ClineProvider.ts).
 */
export function requestMcpApp(args: {
	serverName: string
	source?: "global" | "project"
	method: McpAppMethod
	params: Record<string, unknown>
	timeoutMs?: number
}): Promise<unknown> {
	if (!listenerInstalled) {
		window.addEventListener("message", onResponseMessage)
		listenerInstalled = true
	}

	const requestId = crypto.randomUUID()

	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			pending.delete(requestId)
			reject(new Error(`MCP App ${args.method} request timed out after ${args.timeoutMs ?? 60_000}ms`))
		}, args.timeoutMs ?? 60_000)

		pending.set(requestId, { resolve, reject, timer })

		vscode.postMessage({
			type: "mcpAppRequest",
			requestId,
			serverName: args.serverName,
			source: args.source,
			mcpAppMethod: args.method,
			mcpAppParams: args.params,
		})
	})
}
