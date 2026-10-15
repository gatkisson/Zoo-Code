import { FormEvent } from "react"

import { VSCodeCheckbox } from "@vscode/webview-ui-toolkit/react"

import { useExtensionState } from "@src/context/ExtensionStateContext"
import { useAppTranslation } from "@src/i18n/TranslationContext"
import { vscode } from "@src/utils/vscode"

interface McpAppsToggleProps {
	mcpAppsEnabled?: boolean
	setMcpAppsEnabled?: (value: boolean) => void
}

const McpAppsToggle = ({
	mcpAppsEnabled: propsMcpAppsEnabled,
	setMcpAppsEnabled: propsSetMcpAppsEnabled,
}: McpAppsToggleProps = {}) => {
	const { mcpAppsEnabled: contextMcpAppsEnabled, setMcpAppsEnabled: contextSetMcpAppsEnabled } = useExtensionState()
	const { t } = useAppTranslation()

	// SettingsView passes buffered (cachedState) values; fall back to live state when uncontrolled.
	const mcpAppsEnabled = propsMcpAppsEnabled ?? contextMcpAppsEnabled

	const handleChange = (e: Event | FormEvent<HTMLElement>) => {
		const target = ("target" in e ? e.target : null) as HTMLInputElement | null

		if (!target) {
			return
		}

		propsSetMcpAppsEnabled?.(target.checked)
		contextSetMcpAppsEnabled(target.checked)
		vscode.postMessage({ type: "updateSettings", updatedSettings: { mcpAppsEnabled: target.checked } })
	}

	return (
		<div className="mb-5">
			<VSCodeCheckbox checked={mcpAppsEnabled} onChange={handleChange}>
				<span className="font-medium">{t("mcp:appsToggle.title")}</span>
			</VSCodeCheckbox>
			<p className="text-xs text-vscode-descriptionForeground mt-1 ml-6">{t("mcp:appsToggle.description")}</p>
		</div>
	)
}

export default McpAppsToggle
