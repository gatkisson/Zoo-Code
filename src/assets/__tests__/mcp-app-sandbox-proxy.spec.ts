import fs from "node:fs"
import path from "node:path"
import vm from "node:vm"
import { fileURLToPath } from "node:url"

/**
 * Behavioral contract tests for the bundled MCP Apps sandbox proxy relay
 * (Task 8 review finding I1). The shipped HTML's inline script is executed
 * verbatim in a `node:vm` sandbox with stubbed window/document objects so
 * that nested-frame `event.source` identity semantics can be simulated
 * exactly. jsdom cannot faithfully model two distinct frame windows
 * relaying postMessage (the inner srcdoc frame never loads scripts), so the
 * relay direction is proven here at the artifact level; end-to-end proof in
 * the real dev host remains part of the human F5 spike (Task 9 report).
 */

const assetPath = path.resolve(fileURLToPath(import.meta.url), "../../mcp-app-sandbox-proxy.html")

type PostMessageFn = ReturnType<typeof vi.fn>

type FakeFrame = {
	contentWindow: { postMessage: PostMessageFn }
	setAttribute: PostMessageFn
	style: Record<string, string>
	remove: PostMessageFn
	srcdoc: string
}

type MessageListener = (event: { data: unknown; source: unknown }) => void

function loadProxy() {
	const html = fs.readFileSync(assetPath, "utf8")
	const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1]
	if (!script) {
		throw new Error("Inline <script> not found in sandbox proxy HTML")
	}

	const listeners: MessageListener[] = []
	const parent = { postMessage: vi.fn() }
	const innerContentWindow = { postMessage: vi.fn() }
	const frames: FakeFrame[] = []
	const documentStub = {
		createElement: vi.fn(() => {
			const frame: FakeFrame = {
				contentWindow: innerContentWindow,
				setAttribute: vi.fn(),
				style: {},
				remove: vi.fn(),
				srcdoc: "",
			}
			frames.push(frame)
			return frame
		}),
		body: { appendChild: vi.fn() },
	}
	const windowStub = {
		parent,
		addEventListener: (_type: string, listener: MessageListener) => listeners.push(listener),
	}

	vm.runInContext(script, vm.createContext({ window: windowStub, document: documentStub }))

	return {
		listeners,
		parent,
		innerContentWindow,
		frames,
		createElement: documentStub.createElement,
		appendChild: documentStub.body.appendChild,
		/** Simulate a `message` event delivered to every registered window listener. */
		dispatch(source: unknown, data: unknown) {
			for (const listener of [...listeners]) {
				listener({ data, source })
			}
		},
	}
}

const mountFromParent = (proxy: ReturnType<typeof loadProxy>) => {
	proxy.dispatch(proxy.parent, { type: "mcp-app-set-html", html: "<html><body>app</body></html>" })
}

describe("mcp-app-sandbox-proxy relay direction", () => {
	it("mounts app HTML received from the parent webview", () => {
		const proxy = loadProxy()

		mountFromParent(proxy)

		expect(proxy.createElement).toHaveBeenCalledWith("iframe")
		expect(proxy.frames).toHaveLength(1)
		expect(proxy.frames[0].srcdoc).toBe("<html><body>app</body></html>")
		expect(proxy.appendChild).toHaveBeenCalledWith(proxy.frames[0])
	})

	it("forwards non-control messages from the parent webview into the app frame", () => {
		const proxy = loadProxy()
		mountFromParent(proxy)

		const rpc = { jsonrpc: "2.0", method: "ping", id: 1 }
		proxy.dispatch(proxy.parent, rpc)

		expect(proxy.innerContentWindow.postMessage).toHaveBeenCalledWith(rpc, "*")
	})

	it("relays messages from the app frame verbatim to the parent webview", () => {
		const proxy = loadProxy()
		mountFromParent(proxy)
		proxy.parent.postMessage.mockClear() // drop the parse-time ready ping

		const rpc = { jsonrpc: "2.0", result: {}, id: 1 }
		proxy.dispatch(proxy.innerContentWindow, rpc)

		expect(proxy.parent.postMessage).toHaveBeenCalledWith(rpc, "*")
	})

	it("does not echo webview-origin messages back to the parent webview", () => {
		const proxy = loadProxy()
		mountFromParent(proxy)
		proxy.parent.postMessage.mockClear() // drop the parse-time ready ping

		proxy.dispatch(proxy.parent, { jsonrpc: "2.0", method: "ping", id: 2 })

		expect(proxy.parent.postMessage).not.toHaveBeenCalled()
	})

	it("drops mcp-app-set-html control messages arriving from the app frame", () => {
		const proxy = loadProxy()
		mountFromParent(proxy)
		proxy.parent.postMessage.mockClear() // drop the parse-time ready ping

		proxy.dispatch(proxy.innerContentWindow, { type: "mcp-app-set-html", html: "<script>evil()</script>" })

		expect(proxy.frames).toHaveLength(1) // control is proxy-only: no second mount
		expect(proxy.parent.postMessage).not.toHaveBeenCalled() // and never relayed to the webview
	})

	it("pings the parent webview at parse time (ready signal)", () => {
		const proxy = loadProxy()

		expect(proxy.parent.postMessage).toHaveBeenCalledWith({ type: "mcp-app-sandbox-proxy-ready" }, "*")
	})
})
