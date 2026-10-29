import { vscode } from "@src/utils/vscode"

import { requestMcpApp } from "../useMcpAppBridge"

function respondTo(requestId: string, payload: unknown) {
	window.dispatchEvent(
		new MessageEvent("message", { data: { type: "mcpAppResponse", requestId, mcpAppResponse: payload } }),
	)
}

describe("requestMcpApp", () => {
	afterEach(() => {
		vi.restoreAllMocks()
	})

	it("posts an mcpAppRequest with a unique requestId and resolves the correlated result", async () => {
		const postMessage = vi.spyOn(vscode, "postMessage").mockImplementation(() => undefined)
		const promise = requestMcpApp({ serverName: "srv", method: "resources/read", params: { uri: "ui://a/b" } })

		const posted = postMessage.mock.calls[0][0]
		expect(posted).toMatchObject({
			type: "mcpAppRequest",
			serverName: "srv",
			mcpAppMethod: "resources/read",
			mcpAppParams: { uri: "ui://a/b" },
		})
		expect(typeof posted.requestId).toBe("string")

		respondTo(posted.requestId!, { ok: true, result: { contents: [] } })

		await expect(promise).resolves.toEqual({ contents: [] })
	})

	it("rejects with the host error message on ok:false", async () => {
		const postMessage = vi.spyOn(vscode, "postMessage").mockImplementation(() => undefined)
		const promise = requestMcpApp({ serverName: "srv", method: "tools/call", params: { name: "t" } })
		const posted = postMessage.mock.calls[0][0]

		respondTo(posted.requestId!, { ok: false, error: { code: -32601, message: "Method not allowed" } })

		await expect(promise).rejects.toThrow("Method not allowed")
	})

	it("ignores responses for other requestIds and rejects on timeout", async () => {
		const postMessage = vi.spyOn(vscode, "postMessage").mockImplementation(() => undefined)
		vi.useFakeTimers()
		const promise = requestMcpApp({
			serverName: "srv",
			method: "tools/call",
			params: { name: "t" },
			timeoutMs: 100,
		})

		window.dispatchEvent(
			new MessageEvent("message", {
				data: { type: "mcpAppResponse", requestId: "someone-else", mcpAppResponse: { ok: true, result: 1 } },
			}),
		)

		vi.advanceTimersByTime(101)
		await expect(promise).rejects.toThrow(/timed out/i)
		expect(postMessage).toHaveBeenCalledTimes(1)
		vi.useRealTimers()
	})
})
