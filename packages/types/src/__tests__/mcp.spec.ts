import { getMcpToolUiResourceUri, isMcpServerUiDisabled } from "../mcp.js"

describe("getMcpToolUiResourceUri", () => {
	it("reads the standard nested key", () => {
		expect(getMcpToolUiResourceUri({ ui: { resourceUri: "ui://demo/card" } })).toBe("ui://demo/card")
	})

	it("falls back to the legacy flat key", () => {
		expect(getMcpToolUiResourceUri({ "ui/resourceUri": "ui://legacy/view" })).toBe("ui://legacy/view")
	})

	it("prefers the nested key when both are present", () => {
		expect(getMcpToolUiResourceUri({ ui: { resourceUri: "ui://new" }, "ui/resourceUri": "ui://old" })).toBe(
			"ui://new",
		)
	})

	it("returns undefined for missing, empty, or non-string values", () => {
		expect(getMcpToolUiResourceUri(undefined)).toBeUndefined()
		expect(getMcpToolUiResourceUri({})).toBeUndefined()
		expect(getMcpToolUiResourceUri({ ui: {} })).toBeUndefined()
		expect(getMcpToolUiResourceUri({ ui: { resourceUri: "" } })).toBeUndefined()
		expect(getMcpToolUiResourceUri({ "ui/resourceUri": 42 as unknown as string })).toBeUndefined()
	})
})

describe("isMcpServerUiDisabled", () => {
	it("returns true only when disableUi is exactly true", () => {
		expect(isMcpServerUiDisabled({ config: JSON.stringify({ disableUi: true }) })).toBe(true)
		expect(isMcpServerUiDisabled({ config: JSON.stringify({ disableUi: false }) })).toBe(false)
		expect(isMcpServerUiDisabled({ config: JSON.stringify({}) })).toBe(false)
	})

	it("never throws on missing or malformed config", () => {
		expect(isMcpServerUiDisabled(undefined)).toBe(false)
		expect(isMcpServerUiDisabled({})).toBe(false)
		expect(isMcpServerUiDisabled({ config: "not-json" })).toBe(false)
	})
})
