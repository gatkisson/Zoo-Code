import { useCallback, useEffect, useMemo, useRef, useState } from "react"
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

function getInjectedProxyHtml(): string {
	return (window as unknown as { MCP_APP_SANDBOX_PROXY_HTML?: string }).MCP_APP_SANDBOX_PROXY_HTML ?? ""
}

// argumentsJson/responseText stay on the props interface (ChatRow's call site is
// final; they are reserved for future app context seeding) but are not
// destructured yet to satisfy no-unused-vars. alwaysAllow/alwaysAllowMcp feed the
// Task 10 approval gate below.
export const McpAppFrame = ({
	serverName,
	source,
	toolName,
	toolMeta,
	resultMeta,
	alwaysAllow,
	alwaysAllowMcp,
	server,
}: McpAppFrameProps) => {
	const { mcpAppsEnabled } = useExtensionState()
	const { t } = useTranslation()
	const iframeRef = useRef<HTMLIFrameElement>(null)
	const [html, setHtml] = useState<string | null>(null)
	const [error, setError] = useState<string | null>(null)
	const [height, setHeight] = useState(240)
	const [pendingApproval, setPendingApproval] = useState<{
		toolName: string
		resolve: (approved: boolean) => void
	} | null>(null)

	// Result-level _meta override first (architecture risk item), then the tool declaration.
	const uiUri = getMcpToolUiResourceUri(resultMeta) ?? getMcpToolUiResourceUri(toolMeta)
	const enabled = mcpAppsEnabled && !!uiUri && !isMcpServerUiDisabled(server ?? { config: undefined })
	// Primary proxy source: the bundled proxy HTML injected by the extension host,
	// mounted as a blob: URL. In desktop VS Code, iframe navigations to
	// asWebviewUri routes are not served by the webview service worker (dev-host
	// spike runs 1–6), so a network-URL proxy never loads; blob: sidesteps the
	// network entirely. The blob document inherits the webview CSP, which admits
	// the proxy's trusted relay script via its sha256 hash (ClineProvider).
	const injectedProxyHtml = useMemo(() => getInjectedProxyHtml(), [])
	const proxyBlobUrl = useMemo(() => {
		if (!injectedProxyHtml) {
			return ""
		}
		return URL.createObjectURL(new Blob([injectedProxyHtml], { type: "text/html" }))
	}, [injectedProxyHtml])
	useEffect(() => {
		return () => {
			if (proxyBlobUrl) {
				URL.revokeObjectURL(proxyBlobUrl)
			}
		}
	}, [proxyBlobUrl])
	// Fallback: the asWebviewUri route (works in webviews that do serve it, e.g.
	// vscode.dev). An unset proxy source must disable the frame entirely:
	// <iframe src=""> resolves to the webview document itself and would
	// self-nest it (Task 9 M1).
	const proxySource = proxyBlobUrl || getSandboxProxyUri()

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

	// Mirror of the pending approval resolver in a ref so teardown paths can settle
	// it without reading state (Task 10 review T10-M1: an unsettled promise hangs
	// the app-side callTool until the bridge times out; deny-on-teardown is the
	// fail-safe direction).
	const pendingApprovalRef = useRef<{ toolName: string; resolve: (approved: boolean) => void } | null>(null)

	const settlePendingApproval = useCallback((approved: boolean) => {
		pendingApprovalRef.current?.resolve(approved)
		pendingApprovalRef.current = null
		setPendingApproval(null)
	}, [])

	useEffect(() => {
		return () => {
			// Unmount with a prompt still open: deny it (T10-M1).
			settlePendingApproval(false)
			disposeRef.current?.dispose()
			disposeRef.current = null
		}
	}, [settlePendingApproval])

	const requestApproval = useCallback(
		(toolName: string): Promise<boolean> => {
			if (alwaysAllow || alwaysAllowMcp) {
				return Promise.resolve(true)
			}
			return new Promise((resolve) => {
				const approval = { toolName, resolve }
				pendingApprovalRef.current = approval
				setPendingApproval(approval)
			})
		},
		[alwaysAllow, alwaysAllowMcp],
	)

	// Ref indirection so the session's gate reads the CURRENT flags at call time
	// instead of the iframe-load-time closure (Task 10 review T10-M2: revoking
	// always-allow mid-session must take effect without a remount).
	const requestApprovalRef = useRef(requestApproval)
	useEffect(() => {
		requestApprovalRef.current = requestApproval
	}, [requestApproval])

	const onIframeLoad = useCallback(() => {
		const frameWindow = iframeRef.current?.contentWindow
		if (!frameWindow || !html) {
			return
		}

		frameWindow.postMessage({ type: "mcp-app-set-html", html }, "*")

		// Replacing the session: settle any approval pending on the old one (T10-M1).
		settlePendingApproval(false)
		disposeRef.current?.dispose()
		const session = createMcpAppBridgeSession({
			serverName,
			source,
			onToolCall: async (name) => requestApprovalRef.current(name),
		})
		disposeRef.current = session
		session.start(frameWindow)
	}, [html, serverName, source, settlePendingApproval])

	useEffect(() => {
		const onMessage = (event: MessageEvent) => {
			if (!iframeRef.current || event.source !== iframeRef.current.contentWindow) {
				return // only size reports relayed by THIS frame's proxy document
			}
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

	if (!enabled || !proxySource) {
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
		<>
			{pendingApproval && (
				<div className="flex items-center justify-between gap-2 mt-2 p-2 border border-vscode-input-border rounded-xs bg-vscode-editor-background">
					<span className="text-xs text-vscode-foreground">
						{t("mcp:approval.runTool", {
							defaultValue: "Run {{server}}/{{tool}}?",
							server: serverName,
							tool: pendingApproval.toolName,
						})}
					</span>
					<div className="flex gap-2">
						<button
							className="text-xs px-2 py-1 rounded-xs bg-vscode-button-background text-vscode-button-foreground"
							onClick={() => settlePendingApproval(true)}>
							{t("mcp:approval.allow", "Allow")}
						</button>
						<button
							className="text-xs px-2 py-1 rounded-xs border border-vscode-button-border"
							onClick={() => settlePendingApproval(false)}>
							{t("mcp:approval.deny", "Deny")}
						</button>
					</div>
				</div>
			)}
			<iframe
				key={uiUri} // remount (and refire onLoad) when the UI resource changes (Task 9 M2)
				ref={iframeRef}
				title={`MCP App: ${serverName}/${toolName}`}
				// Render-into-proxy (spike Decision: FALLBACK): app HTML renders
				// INTO the proxy document, so hostile app code executes in this
				// frame and isolation moves here. sandbox WITHOUT
				// allow-same-origin gives the frame an opaque origin, blocking
				// webview DOM and acquireVsCodeApi access; the blob: URL is
				// same-origin as the webview when unsandboxed, so this attribute
				// is what provides isolation on the primary route. The relay
				// script stays admitted via its sha256 hash in the inherited CSP
				// and strict-dynamic propagates to app scripts (Task 1 asset).
				// The blob: primary route sidesteps the service-worker limitation
				// that only affected the URI fallback.
				sandbox="allow-scripts allow-forms allow-popups"
				src={proxySource}
				style={{ height }} // dynamic px value; not expressible as a Tailwind class
				className="w-full border border-vscode-border rounded-xs mt-2 bg-vscode-editor-background"
				onLoad={onIframeLoad}
			/>
		</>
	)
}

export default McpAppFrame
