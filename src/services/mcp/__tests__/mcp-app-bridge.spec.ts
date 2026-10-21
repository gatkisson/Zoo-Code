import {
	estimateResourceBytes,
	MCP_APP_MAX_RESOURCE_BYTES,
	validateMcpAppRequest,
	type McpAppRequest,
} from "../mcp-app-bridge"

const base: McpAppRequest = {
	requestId: "r1",
	serverName: "srv",
	method: "resources/read",
	params: { uri: "ui://a/b" },
}

describe("validateMcpAppRequest", () => {
	it("accepts the two allowlisted methods", () => {
		expect(validateMcpAppRequest(base, { uiDisabled: false })).toEqual({ ok: true })
		expect(
			validateMcpAppRequest({ ...base, method: "tools/call", params: { name: "t" } }, { uiDisabled: false }),
		).toEqual({ ok: true })
	})

	it("rejects every other method with -32601", () => {
		const result = validateMcpAppRequest({ ...base, method: "prompts/list" }, { uiDisabled: false })
		expect(result).toMatchObject({ ok: false, code: -32601 })
	})

	it("rejects non-ui:// resource reads with -32602", () => {
		for (const uri of ["file:///etc/passwd", "https://evil.test/x", "UI://mixed-case-rejected", ""]) {
			const result = validateMcpAppRequest({ ...base, params: { uri } }, { uiDisabled: false })
			expect(result).toMatchObject({ ok: false, code: -32602 })
		}
	})

	it("rejects tools/call without a tool name with -32602", () => {
		const result = validateMcpAppRequest({ ...base, method: "tools/call", params: {} }, { uiDisabled: false })
		expect(result).toMatchObject({ ok: false, code: -32602 })
	})

	it("rejects when the server opted out (disableUi) with -32004", () => {
		const result = validateMcpAppRequest(base, { uiDisabled: true })
		expect(result).toMatchObject({ ok: false, code: -32004 })
	})
})

describe("estimateResourceBytes", () => {
	it("counts text bytes and decoded base64 blob bytes", () => {
		expect(estimateResourceBytes({ contents: [{ text: "hello" }] })).toBe(5)
		// "aGVsbG8=" decodes to 5 bytes.
		expect(estimateResourceBytes({ contents: [{ blob: "aGVsbG8=" }] })).toBe(5)
		expect(estimateResourceBytes({ contents: [] })).toBe(0)
		expect(estimateResourceBytes({})).toBe(0)
	})

	it("overestimates malformed base64 instead of throwing (fail-closed for the size cap)", () => {
		const bytes = estimateResourceBytes({ contents: [{ blob: "!!!not-base64###" }] })
		expect(bytes).toBeGreaterThanOrEqual(0)
		expect(Number.isFinite(bytes)).toBe(true)
	})

	it("exposes the 2MB cap constant", () => {
		expect(MCP_APP_MAX_RESOURCE_BYTES).toBe(2 * 1024 * 1024)
	})
})
