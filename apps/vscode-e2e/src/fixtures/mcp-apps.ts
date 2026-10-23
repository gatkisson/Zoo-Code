import { LLMock } from "@copilotkit/aimock"

export function addMcpAppsFixtures(mock: InstanceType<typeof LLMock>) {
	mock.addFixture({
		match: { userMessage: /MCP_APPS_SMOKE/ },
		response: {
			toolCalls: [
				{
					name: "mcp--uicard--card",
					arguments: "{}",
					id: "call_mcp_apps_card_001",
				},
			],
		},
	})

	mock.addFixture({
		match: {
			predicate: (req) => JSON.stringify(req).includes("call_mcp_apps_card_001"),
		},
		response: {
			toolCalls: [
				{
					name: "attempt_completion",
					arguments: JSON.stringify({ result: "Card rendered." }),
					id: "call_mcp_apps_done_002",
				},
			],
		},
	})
}
