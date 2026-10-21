import type { McpResourceResponse } from "@roo-code/types"

export const MCP_APP_UI_URI_PREFIX = "ui://"
export const MCP_APP_MAX_RESOURCE_BYTES = 2 * 1024 * 1024

export type McpAppRequest = {
	requestId: string
	serverName: string
	source?: "global" | "project"
	method: string
	params?: Record<string, unknown>
}

export type McpAppResponsePayload =
	| { ok: true; result: unknown }
	| { ok: false; error: { code: number; message: string } }

const ALLOWED_METHODS = new Set(["resources/read", "tools/call"])

/**
 * Host-side re-validation of webview-initiated MCP App requests. Defense in
 * depth: the webview gate already restricts methods, but the host never trusts it.
 */
export function validateMcpAppRequest(
	request: McpAppRequest,
	opts: { uiDisabled: boolean },
): { ok: true } | { ok: false; code: number; message: string } {
	if (!ALLOWED_METHODS.has(request.method)) {
		return { ok: false, code: -32601, message: `Method not allowed for MCP Apps: ${request.method}` }
	}

	if (opts.uiDisabled) {
		return { ok: false, code: -32004, message: `UI is disabled for server "${request.serverName}"` }
	}

	if (request.method === "resources/read") {
		const uri = request.params?.uri
		if (typeof uri !== "string" || !uri.startsWith(MCP_APP_UI_URI_PREFIX)) {
			return { ok: false, code: -32602, message: "Only ui:// resources may be read by an MCP App view" }
		}
	}

	if (request.method === "tools/call") {
		const name = request.params?.name
		if (typeof name !== "string" || name.length === 0) {
			return { ok: false, code: -32602, message: "tools/call requires a tool name" }
		}
	}

	return { ok: true }
}

/**
 * Size estimate for the 2MB cap. Blob payloads are measured after base64
 * decode; when decoding yields nothing for a non-empty blob we fall back to
 * the raw string length so malformed input is never counted as zero bytes.
 */
export function estimateResourceBytes(
	response: Pick<McpResourceResponse, "contents"> | Record<string, unknown>,
): number {
	const contents = (response as McpResourceResponse).contents
	if (!Array.isArray(contents)) {
		return 0
	}

	let bytes = 0
	for (const item of contents) {
		if (typeof item?.text === "string") {
			bytes += Buffer.byteLength(item.text, "utf8")
		}
		if (typeof item?.blob === "string") {
			const decoded = Buffer.from(item.blob, "base64")
			if (decoded.length > 0 || item.blob.length === 0) {
				bytes += decoded.length
			} else {
				// Malformed base64 decodes to nothing; count the raw length so the
				// size cap fails closed instead of treating garbage as free space.
				bytes += item.blob.length
			}
		}
	}
	return bytes
}
