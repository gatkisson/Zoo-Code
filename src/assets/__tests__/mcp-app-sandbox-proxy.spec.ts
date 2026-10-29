import fs from "node:fs"
import path from "node:path"
import vm from "node:vm"
import { fileURLToPath } from "node:url"

/**
 * Behavioral contract tests for the bundled MCP Apps sandbox proxy
 * (render-into-proxy fallback, spike Decision: FALLBACK). The shipped HTML's
 * inline script is executed verbatim in a `node:vm` sandbox with stubbed
 * window/document/DOMParser objects: Chromium inherits the webview CSP into
 * nested srcdoc frames, so the proxy no longer nests — it parses the app HTML,
 * renders non-script nodes into its own document, and re-executes app scripts
 * by creating fresh <script> elements (admitted via strict-dynamic propagation
 * from the hash-admitted relay script). The stubs below cover every
 * parsed-document API the shipped script calls; fixture documents are
 * hand-built per test to keep the exercised surface explicit.
 */

const assetPath = path.resolve(fileURLToPath(import.meta.url), "../../mcp-app-sandbox-proxy.html")

type MockFn = ReturnType<typeof vi.fn>

type MessageListener = (event: { data: unknown; source: unknown }) => void

/** A node of the fake *parsed* document produced by the DOMParser stub. */
type FakeParsedNode = {
	nodeName: string
	textContent: string
	getAttribute: (name: string) => string | null
}

/** A live element produced by document.createElement / document.importNode. */
type FakeElement = {
	tagName: string
	id?: string
	textContent: string
	src: string
	type: string
	style: Record<string, string>
	imported?: FakeParsedNode
	setAttribute: MockFn
	remove: MockFn
	appendChild: MockFn
}

/** Hand-built parsed-document shape the DOMParser stub returns per fixture HTML. */
type ParsedFixture = {
	bodyChildNodes?: FakeParsedNode[]
	bodyScripts?: FakeParsedNode[]
	headScripts?: FakeParsedNode[]
	headStyles?: FakeParsedNode[]
}

function parsedNode(
	nodeName: string,
	attrs: { textContent?: string; src?: string; type?: string } = {},
): FakeParsedNode {
	return {
		nodeName,
		textContent: attrs.textContent ?? "",
		getAttribute: (name: string) => {
			if (name === "src") {
				return attrs.src ?? null
			}
			if (name === "type") {
				return attrs.type ?? null
			}
			return null
		},
	}
}

function loadProxy(fixtures: Record<string, ParsedFixture> = {}) {
	const html = fs.readFileSync(assetPath, "utf8")
	const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1]
	if (!script) {
		throw new Error("Inline <script> not found in sandbox proxy HTML")
	}

	const listeners: MessageListener[] = []
	const parent = { postMessage: vi.fn() }
	const createdElements: FakeElement[] = []
	const importedNodes: FakeElement[] = []

	const makeElement = (tagName: string): FakeElement => {
		const el: FakeElement = {
			tagName,
			textContent: "",
			src: "",
			type: "",
			style: {},
			setAttribute: vi.fn(),
			remove: vi.fn(),
			appendChild: vi.fn(),
		}
		createdElements.push(el)
		return el
	}

	const documentStub = {
		createElement: vi.fn((tag: string) => makeElement(tag)),
		importNode: vi.fn((node: FakeParsedNode) => {
			const copy = makeElement(node.nodeName)
			copy.imported = node
			importedNodes.push(copy)
			return copy
		}),
		body: { appendChild: vi.fn((_node: FakeElement) => {}) },
		head: { appendChild: vi.fn((_node: FakeElement) => {}) },
	}

	class DOMParserStub {
		parseFromString(source: string) {
			const fixture = fixtures[source] ?? {}
			return {
				body: {
					childNodes: fixture.bodyChildNodes ?? [],
					querySelectorAll: (selector: string) => (selector === "script" ? (fixture.bodyScripts ?? []) : []),
				},
				querySelectorAll: (selector: string) => {
					if (selector === "head script") {
						return fixture.headScripts ?? []
					}
					if (selector === "head style, head link[rel='stylesheet']") {
						return fixture.headStyles ?? []
					}
					return []
				},
			}
		}
	}

	const windowStub = {
		parent,
		addEventListener: (_type: string, listener: MessageListener) => listeners.push(listener),
	}

	vm.runInContext(script, vm.createContext({ window: windowStub, document: documentStub, DOMParser: DOMParserStub }))

	return {
		listeners,
		parent,
		createdElements,
		importedNodes,
		createElement: documentStub.createElement,
		importNode: documentStub.importNode,
		bodyAppendChild: documentStub.body.appendChild,
		headAppendChild: documentStub.head.appendChild,
		/** Simulate a `message` event delivered to every registered window listener. */
		dispatch(source: unknown, data: unknown) {
			for (const listener of [...listeners]) {
				listener({ data, source })
			}
		},
	}
}

describe("mcp-app-sandbox-proxy render-into-proxy", () => {
	it("renders app HTML into the proxy document and re-executes scripts as new script elements", () => {
		const html = `<html><body><div id="card"></div><script>evil()</script></body></html>`
		const card = parsedNode("DIV")
		const evil = parsedNode("SCRIPT", { textContent: "evil()" })
		const proxy = loadProxy({ [html]: { bodyChildNodes: [card, evil], bodyScripts: [evil] } })

		proxy.dispatch(proxy.parent, { type: "mcp-app-set-html", html })

		expect(proxy.createElement).toHaveBeenCalledWith("div")
		const container = proxy.createdElements.find((el) => el.tagName === "div")
		expect(container?.id).toBe("mcp-app-root")
		expect(proxy.importNode).toHaveBeenCalledWith(card, true)
		const importedCard = proxy.importedNodes[0]
		expect(importedCard?.imported).toBe(card)
		expect(container?.appendChild).toHaveBeenCalledWith(importedCard)
		expect(proxy.bodyAppendChild).toHaveBeenCalledWith(container)

		const createdScripts = proxy.createdElements.filter((el) => el.tagName === "script")
		expect(createdScripts).toHaveLength(1)
		expect(createdScripts[0].textContent).toBe("evil()")
		expect(proxy.bodyAppendChild).toHaveBeenCalledWith(createdScripts[0])

		// Render-into-proxy: no nested frame is ever created.
		expect(proxy.createElement).not.toHaveBeenCalledWith("iframe")
	})

	it("re-executes external src scripts preserving src and type", () => {
		const html = `<html><body><script src="https://cdn.example/app.js" type="module"></script></body></html>`
		const remote = parsedNode("SCRIPT", { src: "https://cdn.example/app.js", type: "module" })
		const proxy = loadProxy({ [html]: { bodyChildNodes: [remote], bodyScripts: [remote] } })

		proxy.dispatch(proxy.parent, { type: "mcp-app-set-html", html })

		const createdScripts = proxy.createdElements.filter((el) => el.tagName === "script")
		expect(createdScripts).toHaveLength(1)
		expect(createdScripts[0].src).toBe("https://cdn.example/app.js")
		expect(createdScripts[0].type).toBe("module")
		expect(createdScripts[0].textContent).toBe("")
	})

	it("imports head style and link nodes into the proxy head", () => {
		const html = `<html><head><style>body{}</style><link rel="stylesheet" href="https://cdn.example/app.css" /></head><body></body></html>`
		const style = parsedNode("STYLE", { textContent: "body{}" })
		const link = parsedNode("LINK")
		const proxy = loadProxy({ [html]: { headStyles: [style, link] } })

		proxy.dispatch(proxy.parent, { type: "mcp-app-set-html", html })

		expect(proxy.importNode).toHaveBeenCalledWith(style, true)
		expect(proxy.importNode).toHaveBeenCalledWith(link, true)
		expect(proxy.importedNodes).toHaveLength(2)
		for (const copy of proxy.importedNodes) {
			expect(proxy.headAppendChild).toHaveBeenCalledWith(copy)
		}
	})

	it("removes the previous app's nodes on re-mount", () => {
		const htmlA = `<html><body><div id="a"></div><script>a()</script></body></html>`
		const htmlB = `<html><body><span id="b"></span></body></html>`
		const divA = parsedNode("DIV")
		const scriptA = parsedNode("SCRIPT", { textContent: "a()" })
		const spanB = parsedNode("SPAN")
		const proxy = loadProxy({
			[htmlA]: { bodyChildNodes: [divA, scriptA], bodyScripts: [scriptA] },
			[htmlB]: { bodyChildNodes: [spanB] },
		})

		proxy.dispatch(proxy.parent, { type: "mcp-app-set-html", html: htmlA })
		// The injected set is exactly what reached body/head appendChild; the
		// imported body node hangs off the container and goes with it.
		const firstMount = [
			...proxy.bodyAppendChild.mock.calls.map((call) => call[0]),
			...proxy.headAppendChild.mock.calls.map((call) => call[0]),
		]
		expect(firstMount).toHaveLength(2) // container + re-executed script

		proxy.dispatch(proxy.parent, { type: "mcp-app-set-html", html: htmlB })

		for (const node of firstMount) {
			expect(node.remove).toHaveBeenCalled()
		}
	})

	it("drops mcp-app-set-html arriving from non-parent sources", () => {
		const html = `<html><body><div id="card"></div></body></html>`
		const proxy = loadProxy({ [html]: { bodyChildNodes: [parsedNode("DIV")] } })
		const innerAppWindow = { postMessage: vi.fn() }

		proxy.dispatch(innerAppWindow, { type: "mcp-app-set-html", html })

		expect(proxy.createElement).not.toHaveBeenCalledWith("div")
	})

	it("does not echo parent-origin non-control messages back to the parent", () => {
		const proxy = loadProxy()
		proxy.dispatch(proxy.parent, { type: "mcp-app-set-html", html: "<html><body>app</body></html>" })
		proxy.parent.postMessage.mockClear() // drop the parse-time ready ping

		proxy.dispatch(proxy.parent, { jsonrpc: "2.0", method: "ping", id: 1 })

		// No relay listener remains: apps listen in-document, so parent-origin
		// non-control messages are simply ignored (never re-posted anywhere).
		expect(proxy.parent.postMessage).not.toHaveBeenCalled()
	})

	it("pings the parent webview at parse time (ready signal)", () => {
		const proxy = loadProxy()

		expect(proxy.parent.postMessage).toHaveBeenCalledWith({ type: "mcp-app-sandbox-proxy-ready" }, "*")
	})

	it("carries a meta CSP that admits external app scripts under strict-dynamic inheritance", () => {
		const html = fs.readFileSync(assetPath, "utf8")

		expect(html).toContain("script-src 'unsafe-inline' 'unsafe-eval' https: data: blob:")
	})
})
