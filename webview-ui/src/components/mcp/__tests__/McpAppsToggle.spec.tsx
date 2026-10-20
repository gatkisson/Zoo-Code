// npx vitest src/components/mcp/__tests__/McpAppsToggle.spec.tsx

import userEvent from "@testing-library/user-event"

import { render, screen } from "@/utils/test-utils"

import McpAppsToggle from "../McpAppsToggle"
import { vscode } from "@src/utils/vscode"

vi.mock("@src/utils/vscode", () => ({
	vscode: {
		postMessage: vi.fn(),
	},
}))

vi.mock("@src/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({ t: (key: string) => key }),
}))

const contextSetMcpAppsEnabled = vi.fn()
vi.mock("@src/context/ExtensionStateContext", () => ({
	useExtensionState: () => ({
		mcpAppsEnabled: true,
		setMcpAppsEnabled: contextSetMcpAppsEnabled,
	}),
}))

const getCheckbox = () => screen.getByRole("checkbox")

describe("McpAppsToggle - Save/Discard contract", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	// Controlled (inside SettingsView) must buffer in cachedState, not persist before Save.
	it("buffers via the setter prop without persisting before Save when controlled", async () => {
		const setMcpAppsEnabled = vi.fn()
		render(<McpAppsToggle mcpAppsEnabled={true} setMcpAppsEnabled={setMcpAppsEnabled} />)

		const checkbox = getCheckbox()
		expect(checkbox).toBeChecked()

		await userEvent.click(checkbox)

		expect(setMcpAppsEnabled).toHaveBeenCalledWith(false)
		expect(vscode.postMessage).not.toHaveBeenCalled()
		// Must not touch live extension state either.
		expect(contextSetMcpAppsEnabled).not.toHaveBeenCalled()
	})

	it("persists immediately via live state when used uncontrolled", async () => {
		render(<McpAppsToggle />)

		await userEvent.click(getCheckbox())

		expect(contextSetMcpAppsEnabled).toHaveBeenCalledWith(false)
		expect(vscode.postMessage).toHaveBeenCalledWith({
			type: "updateSettings",
			updatedSettings: { mcpAppsEnabled: false },
		})
	})
})
