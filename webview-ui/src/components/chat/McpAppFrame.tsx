import { useCallback, useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"

import { getMcpToolUiResourceUri, isMcpServerUiDisabled, type McpServer } from "@roo-code/types"

import { useExtensionState } from "@src/context/ExtensionStateContext"
import { requestMcpApp } from "@src/services/mcp-app/useMcpAppBridge"

import { createMcpAppBridgeSession } from "./mcpAppBridgeSession"

interface McpAppFrameProps {
	serverName: string
	source?: "global" | "project"
	toolName: string
	toolMeta?: Record<string, unknown>
	resultMeta?: Record<string, unknown>
	argumentsJson?: string
	responseText?: string
	alwaysAllow?: boolean
	alwaysAllowMcp?: boolean
	server?: McpServer
}

function getSandboxProxyUri(): string {
	return (window as unknown as { MCP_APP_SANDBOX_PROXY_URI?: string }).MCP_APP_SANDBOX_PROXY_URI ?? ""
}

// argumentsJson/responseText/alwaysAllow/alwaysAllowMcp stay on the props interface
// (ChatRow's call site is final; Task 10 wires the approval gate) but are not
// destructured yet to satisfy no-unused-vars.
export const McpAppFrame = ({ serverName, source, toolName, toolMeta, resultMeta, server }: McpAppFrameProps) => {
	const { mcpAppsEnabled } = useExtensionState()
	const { t } = useTranslation()
	const iframeRef = useRef<HTMLIFrameElement>(null)
	const [html, setHtml] = useState<string | null>(null)
	const [error, setError] = useState<string | null>(null)
	const [height, setHeight] = useState(240)

	// Result-level _meta override first (architecture risk item), then the tool declaration.
	const uiUri = getMcpToolUiResourceUri(resultMeta) ?? getMcpToolUiResourceUri(toolMeta)
	const enabled = mcpAppsEnabled && !!uiUri && !isMcpServerUiDisabled(server ?? { config: undefined })

	useEffect(() => {
		if (!enabled || !uiUri) {
			return
		}

		let cancelled = false
		requestMcpApp({ serverName, source, method: "resources/read", params: { uri: uiUri } })
			.then((result) => {
				const contents = (result as { contents?: Array<{ text?: string; blob?: string }> }).contents ?? []
				const first = contents[0]
				// Browser-safe base64 decode: webview-ui has no Node Buffer polyfill.
				const appHtml =
					first?.text ??
					(first?.blob
						? new TextDecoder().decode(Uint8Array.from(atob(first.blob), (c) => c.charCodeAt(0)))
						: null)
				if (!appHtml) {
					throw new Error("UI resource contained no HTML")
				}
				if (!cancelled) {
					setHtml(appHtml)
				}
			})
			.catch((err: unknown) => {
				if (!cancelled) {
					setError(err instanceof Error ? err.message : String(err))
				}
			})

		return () => {
			cancelled = true
		}
	}, [enabled, uiUri, serverName, source])

	const disposeRef = useRef<{ dispose: () => void } | null>(null)

	useEffect(() => {
		return () => {
			disposeRef.current?.dispose()
			disposeRef.current = null
		}
	}, [])

	const onIframeLoad = useCallback(() => {
		const frameWindow = iframeRef.current?.contentWindow
		if (!frameWindow || !html) {
			return
		}

		frameWindow.postMessage({ type: "mcp-app-set-html", html }, "*")

		disposeRef.current?.dispose()
		const session = createMcpAppBridgeSession({ serverName, source })
		disposeRef.current = session
		session.start(frameWindow)
	}, [html, serverName, source])

	useEffect(() => {
		const onMessage = (event: MessageEvent) => {
			// Apps report size via the JSON-RPC notification `method` field relayed
			// verbatim by the sandbox proxy; `type` is accepted for tolerance.
			const data = event.data as
				| { type?: string; method?: string; height?: number; params?: { height?: number } }
				| undefined
			if (!data) {
				return
			}
			const reportedHeight =
				data.type === "ui/notifications/size-changed"
					? data.height
					: data.method === "ui/notifications/size-changed"
						? data.params?.height
						: undefined
			if (typeof reportedHeight === "number") {
				setHeight(Math.min(Math.max(reportedHeight, 40), 2000))
			}
		}
		window.addEventListener("message", onMessage)
		return () => window.removeEventListener("message", onMessage)
	}, [])

	if (!enabled) {
		return null
	}

	if (error) {
		return (
			<div className="mt-2 text-xs text-vscode-errorForeground">
				{t("mcp:appFrame.error", "MCP App UI unavailable")}: {error}
			</div>
		)
	}

	if (!html) {
		return (
			<div className="mt-2 text-xs text-vscode-descriptionForeground">
				{t("mcp:appFrame.loading", "Loading UI…")}
			</div>
		)
	}

	return (
		<iframe
			ref={iframeRef}
			title={`MCP App: ${serverName}/${toolName}`}
			src={getSandboxProxyUri()}
			sandbox="allow-scripts allow-forms allow-popups"
			style={{ height }} // dynamic px value; not expressible as a Tailwind class
			className="w-full border border-vscode-border rounded-xs mt-2 bg-vscode-editor-background"
			onLoad={onIframeLoad}
		/>
	)
}

export default McpAppFrame
