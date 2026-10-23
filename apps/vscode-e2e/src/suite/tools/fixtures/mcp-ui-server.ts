import * as fs from "fs/promises"
import * as path from "path"
import { stdin, stdout, stderr } from "process"

type JsonRpcMessage = {
	jsonrpc: "2.0"
	id?: string | number
	method?: string
	params?: {
		name?: string
		arguments?: Record<string, unknown>
		uri?: string
	}
}

const workspaceDir = process.argv[2]
const readyFile = process.env.MCP_TEST_READY_FILE

if (!workspaceDir) {
	stderr.write("Missing workspace directory argument\n")
	process.exit(1)
}

let buffer = ""

stdin.setEncoding("utf8")
stdin.on("data", (chunk) => {
	buffer += chunk
	processBuffer().catch((error) => {
		stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`)
	})
})

async function processBuffer() {
	let newlineIndex = buffer.indexOf("\n")
	while (newlineIndex !== -1) {
		const line = buffer.slice(0, newlineIndex).trim()
		buffer = buffer.slice(newlineIndex + 1)

		if (line) {
			await handleMessage(JSON.parse(line) as JsonRpcMessage)
		}

		newlineIndex = buffer.indexOf("\n")
	}
}

async function handleMessage(message: JsonRpcMessage) {
	if (message.id === undefined) {
		return
	}

	try {
		switch (message.method) {
			case "initialize":
				sendResult(message.id, {
					protocolVersion: "2024-11-05",
					capabilities: { tools: {}, resources: {} },
					serverInfo: { name: "test-mcp-ui-server", version: "1.0.0" },
				})
				break
			case "tools/list":
				await markReady()
				sendResult(message.id, { tools: getTools() })
				break
			case "resources/list":
				sendResult(message.id, { resources: [] })
				break
			case "resources/templates/list":
				sendResult(message.id, { resourceTemplates: [] })
				break
			case "resources/read":
				// Marker file first, then the response: its presence proves the real
				// server served the ui:// read through McpHub.handleMcpAppRequest.
				await markUiRead()
				sendResult(message.id, {
					contents: [
						{
							uri: "ui://demo/card",
							mimeType: "text/html;profile=mcp-app",
							text: "<!DOCTYPE html><html><body><div id='card'>hello-mcp-app</div></body></html>",
						},
					],
				})
				break
			case "tools/call":
				sendResult(message.id, await callTool(message.params?.name))
				break
			default:
				sendResult(message.id, {})
		}
	} catch (error) {
		sendError(message.id, error instanceof Error ? error.message : String(error))
	}
}

function sendResult(id: string | number, result: unknown) {
	stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`)
}

function sendError(id: string | number, message: string) {
	stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32603, message } })}\n`)
}

async function markReady() {
	if (!readyFile) {
		return
	}

	await fs.mkdir(path.dirname(readyFile), { recursive: true })
	await fs.writeFile(readyFile, "ready")
}

async function markUiRead() {
	if (!readyFile) {
		return
	}

	await fs.mkdir(path.dirname(readyFile), { recursive: true })
	await fs.writeFile(`${readyFile}.ui-read`, "ok")
}

function getTools() {
	return [
		{
			name: "card",
			description: "Renders a demo UI card",
			inputSchema: { type: "object", properties: {} },
			_meta: { ui: { resourceUri: "ui://demo/card" } },
		},
	]
}

async function callTool(name: string | undefined) {
	switch (name) {
		case "card":
			return textResult("card ok")
		default:
			throw new Error(`Unknown tool: ${name}`)
	}
}

function textResult(text: string) {
	return {
		content: [{ type: "text", text }],
	}
}
