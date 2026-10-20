# MCP Apps Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render interactive MCP Apps HTML UIs (standardized MCP-UI, `_meta.ui.resourceUri` + `ui://` resources) inside Zoo Code's chat webview in a sandboxed iframe, with a proxied `resources/read`/`tools/call` bridge behind an opt-in feature flag.

**Architecture:** The extension host declares the `io.modelcontextprotocol/ui` client capability and serves app HTML/tool calls over a new correlated `mcpAppRequest`/`mcpAppResponse` webview message pair (reusing the existing `requestId` precedent). The webview runs an `AppBridge(null)` from `@modelcontextprotocol/ext-apps` 1.x and mounts hostile app HTML in a bundled sandbox-proxy document loaded via `asWebviewUri`, whose inner opaque-origin `srcdoc` frame isolates third-party scripts from the webview CSP. Approval is enforced twice: an inline confirm gate in the webview plus host-side re-validation (method allowlist, `ui://`-only reads, size cap, per-server `disableUi`) in the `McpHub` path.

**Tech Stack:** TypeScript, VS Code Extension API webviews, MCP SDK 1.29.0 (`@modelcontextprotocol/sdk`, exact pin), `@modelcontextprotocol/ext-apps@^1.7.5` (webview only), React 18 + Vitest (webview-ui), Vitest (src, packages/types), Zod schemas in `packages/types`, Playwright/Mocha e2e in `apps/vscode-e2e`.

## Global Constraints

- `@modelcontextprotocol/sdk` stays pinned at exactly `1.29.0` in [`src/package.json`](../../../src/package.json:482); never bump it, never add SDK v2.
- Webview dependency is `@modelcontextprotocol/ext-apps@^1.7.5` ONLY (peers `sdk ^1.29.0`). Do NOT use ext-apps 2.x (peer-incompatible). Do NOT add `@mcp-ui/client` unless Task 7's bundling check passes and Task 9's AppBridge wiring fails — decide explicitly, never silently.
- Never weaken the webview `script-src` CSP in either variant of [`ClineProvider.ts`](../../../src/core/webview/ClineProvider.ts:1593) (dev ~line 1593, production ~line 1688). The ONLY CSP change allowed is adding `frame-src ${webview.cspSource}` to both.
- `mcpAppsEnabled` defaults to **false** (`DEFAULT_MCP_APPS_ENABLED = false`); the feature is opt-in because it executes untrusted third-party HTML/JS.
- Fetched `ui://` payloads are capped at 2 MB (`MCP_APP_MAX_RESOURCE_BYTES = 2 * 1024 * 1024`), checked before and after base64 decode; proxied `resources/read` accepts only `ui://` URIs; the message bridge accepts only `resources/read` and `tools/call`.
- UI-initiated links go through a scheme allowlist (`https:`, `http:`, `mailto:`) BEFORE any `openExternal` postMessage — the existing [`openExternal` handler](../../../src/core/webview/webviewMessageHandler.ts:1566) has no validation and must not receive unvalidated app URLs.
- No `.changeset` files, no `CHANGELOG.md` / `src/CHANGELOG.md` edits (AGENTS.md).
- ESLint suppression counts in `src/eslint-suppressions.json` must never increase; after editing any `src` file run `pnpm --dir src exec eslint --prune-suppressions --max-warnings=0 <relative-file>` and confirm the count did not grow. No new `as any` without a justifying comment.
- Run tests from the package directory, never repo root: backend `cd src && npx vitest run path/to/file.spec.ts`; webview `cd webview-ui && npx vitest run src/path/file.spec.ts`; types `cd packages/types && npx vitest run src/__tests__/file.spec.ts`.
- New webview markup uses Tailwind classes (e.g. `text-vscode-descriptionForeground`), not inline style objects; any new VS Code CSS variable must first be registered in [`webview-ui/src/index.css`](../../../webview-ui/src/index.css).
- SettingsView controls bind to local `cachedState` (via `setCachedStateField`), NEVER directly to live `useExtensionState()` (AGENTS.md Settings View Pattern).
- Legacy compat: both `_meta.ui.resourceUri` (preferred) and `_meta["ui/resourceUri"]` (legacy MCP-UI) are accepted, everywhere, via the single extractor helper from Task 2.

---

## File Structure

Files created/modified by this plan, each with a single responsibility:

| File | Action | Responsibility |
|------|--------|----------------|
| `src/core/webview/ClineProvider.ts` | Modify | Add `frame-src ${webview.cspSource}` to both CSP variants; inject `window.MCP_APP_SANDBOX_PROXY_URI` into both HTML templates; add `mcpAppsEnabled` to `getState()` and `getStateToPostToWebview()` |
| `src/assets/mcp-app-sandbox-proxy.html` | Create | Bundled proxy document: own meta-CSP, creates inner opaque-origin `srcdoc` frame, relays JSON-RPC between webview and app frame |
| `src/esbuild.mjs` | Modify | Copy the sandbox-proxy HTML into the bundle (`copyPaths`) |
| `src/.vscodeignore` | Modify | Allow-list the sandbox-proxy HTML for vsix packaging |
| `packages/types/src/mcp.ts` | Modify | `McpTool._meta` typed; `getMcpToolUiResourceUri()` (both keys, nested precedence); `isMcpServerUiDisabled()` |
| `packages/types/src/__tests__/mcp.spec.ts` | Create | Unit tests for extractor precedence + UI-disabled helper |
| `packages/types/src/global-settings.ts` | Modify | `mcpAppsEnabled: z.boolean().optional()` + `DEFAULT_MCP_APPS_ENABLED = false` |
| `packages/types/src/vscode-extension-host.ts` | Modify | `ExtensionState.mcpAppsEnabled`; `WebviewMessage` type `"mcpAppRequest"` + `mcpAppMethod`/`mcpAppParams`; `ExtensionMessage` type `"mcpAppResponse"` + `mcpAppResponse` payload |
| `src/services/mcp/McpHub.ts` | Modify | Capability declaration in `new Client(...)`; `handleMcpAppRequest()`; `toggleServerUi()`; `disableUi` in `BaseConfigSchema` |
| `src/services/mcp/mcp-app-bridge.ts` | Create | Pure validator: method allowlist, `ui://` restriction, size-cap estimator, JSON-RPC-style error codes |
| `src/services/mcp/__tests__/mcp-app-bridge.spec.ts` | Create | Unit tests for every rejection path of the validator |
| `src/core/webview/webviewMessageHandler.ts` | Modify | `mcpAppRequest` case → `McpHub.handleMcpAppRequest`; `toggleMcpServerUi` case; `mcpAppsEnabled` branch in `updateSettings` (refresh connections) |
| `src/core/webview/__tests__/ClineProvider.spec.ts` | Modify | CSP `frame-src` assertion; `mcpAppsEnabled` state round-trip assertions |
| `src/core/webview/__tests__/webviewMessageHandler.spec.ts` | Modify | `mcpAppRequest` routing tests; `mcpAppsEnabled` refresh test |
| `src/services/mcp/__tests__/McpHub.spec.ts` | Modify | Capability presence/absence tests; `handleMcpAppRequest` integration tests; `toggleServerUi` test |
| `webview-ui/package.json` | Modify | Add `@modelcontextprotocol/ext-apps@^1.7.5` |
| `webview-ui/src/services/mcp-app/useMcpAppBridge.ts` | Create | `requestMcpApp()` — postMessage request/response correlation by `requestId` with timeout |
| `webview-ui/src/services/mcp-app/__tests__/useMcpAppBridge.spec.ts` | Create | Bridge client tests against a mocked message bus |
| `webview-ui/src/components/chat/McpAppFrame.tsx` | Create | Render gate + HTML fetch + iframe mount + size handling + approval banner |
| `webview-ui/src/components/chat/mcpAppBridgeSession.ts` | Create | `AppBridge(null)` session: manual handlers → `requestMcpApp`; capability field set |
| `webview-ui/src/components/chat/__tests__/McpAppFrame.spec.tsx` | Create | Component tests: gate off/on, fetch failure, approval allow/deny, size message |
| `webview-ui/src/components/chat/ChatRow.tsx` | Modify | Mount `McpAppFrame` in the `use_mcp_tool` branch (~line 1666) |
| `webview-ui/src/components/mcp/McpAppsToggle.tsx` | Create | Global enable checkbox (mirrors `McpEnabledToggle`) |
| `webview-ui/src/components/mcp/McpView.tsx` | Modify | Render `McpAppsToggle`; per-server "Disable UI" toggle posting `toggleMcpServerUi` |
| `webview-ui/src/components/mcp/__tests__/McpAppsToggle.spec.tsx` | Create | Toggle posts `updateSettings` payload test |
| `webview-ui/src/context/ExtensionStateContext.tsx` | Modify | Default `mcpAppsEnabled: false` + `setMcpAppsEnabled` setter |
| `webview-ui/src/components/settings/SettingsView.tsx` | Modify | `cachedState` wiring for `mcpAppsEnabled` |
| `webview-ui/src/i18n/locales/en/mcp.json` | Modify | `appsToggle.*` and `serverRow.disableUi` strings (other locales fall back to en via i18next `fallbackLng`) |
| `apps/vscode-e2e/src/suite/tools/fixtures/mcp-ui-server.ts` | Create | Stdio fixture MCP server exposing a UI tool + `ui://` resource, writes marker file on `resources/read` |
| `apps/vscode-e2e/src/fixtures/mcp-apps.ts` | Create | aimock fixtures for the smoke task |
| `apps/vscode-e2e/src/suite/tools/mcp-apps.test.ts` | Create | Smoke e2e: flag on → tool ask → marker file appears (proves host bridge served app HTML) |
| `docs/superpowers/plans/spike-results-mcp-apps.md` | Create | Task 1 spike findings + fallback decision record |

---

### Task 1: CSP `frame-src` + sandbox-proxy nested-frame spike

**Files:**
- Modify: `src/core/webview/ClineProvider.ts` (dev CSP array ~lines 1593–1601; production CSP meta ~line 1688)
- Create: `docs/superpowers/plans/spike-results-mcp-apps.md`
- Test: `src/core/webview/__tests__/ClineProvider.spec.ts` (append a new `test(...)` inside the existing top-level `describe`)

**Interfaces:**
- Consumes: nothing (first task).
- Produces: webview CSP that permits iframes from `${webview.cspSource}`; a recorded decision on whether an opaque-origin nested `srcdoc` frame executes inline scripts inside VS Code webviews (fallback per architecture doc: render app HTML into the proxy document itself — weaker isolation, requires re-review before Task 9 proceeds).

- [ ] **Step 1: Write the failing CSP test**

Append to `src/core/webview/__tests__/ClineProvider.spec.ts`, inside the existing top-level `describe("ClineProvider", ...)` block (the file already defines a `mockWebviewView` whose `webview.cspSource` is `"vscode-webview://test-csp-source"` — see the mock at ~line 526; reuse the same setup pattern as the existing test `"handles mcpEnabled setting correctly"` at ~line 2261, which calls `provider.resolveWebviewView(mockWebviewView)`):

```typescript
		test("includes frame-src in the production webview CSP", async () => {
			await provider.resolveWebviewView(mockWebviewView)

			const setHtmlCall = (mockWebviewView.webview as any).html ?? mockWebviewView.webview.setHtml.mock?.calls?.[0]?.[0]
			const html: string = typeof setHtmlCall === "string" ? setHtmlCall : String(setHtmlCall)

			expect(html).toContain("frame-src vscode-webview://test-csp-source")
			// Must not weaken script-src: production keeps nonce + strict-dynamic, no unsafe-inline.
			expect(html).toContain("'strict-dynamic'")
			expect(html).not.toContain("script-src 'unsafe-inline'")
		})
```

If `resolveWebviewView` stores HTML differently than the two accessors above, inspect how existing tests read it (search the spec for `setHtml`) and use that exact accessor — do not delete the assertions.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd src && npx vitest run core/webview/__tests__/ClineProvider.spec.ts -t "includes frame-src"`
Expected: FAIL with `expected ... to contain "frame-src vscode-webview://test-csp-source"`.

- [ ] **Step 3: Add `frame-src` to both CSP variants**

In [`getDevHtmlContent`](../../../src/core/webview/ClineProvider.ts:1593), extend the `csp` array (currently lines 1593–1601) by inserting one entry after `default-src 'none'`:

```typescript
		const csp = [
			"default-src 'none'",
			`frame-src ${webview.cspSource}`,
			`font-src ${webview.cspSource} data:`,
```

In [`getHtmlContent`](../../../src/core/webview/ClineProvider.ts:1688), inside the single-line production meta tag, insert `frame-src ${webview.cspSource}; ` immediately after `default-src 'none'; ` — change only that; do not touch `script-src`:

```
content="default-src 'none'; frame-src ${webview.cspSource}; font-src ${webview.cspSource} data:; style-src ... (rest unchanged)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd src && npx vitest run core/webview/__tests__/ClineProvider.spec.ts`
Expected: PASS (new test + all pre-existing tests).

Verify the dev variant received the same directive (no automated harness exists for the dev template):
Run: `pnpm --dir src exec node -e "const s=require('fs').readFileSync('core/webview/ClineProvider.ts','utf8'); const n=(s.match(/frame-src/g)||[]).length; if(n<2){console.error('frame-src count '+n+' < 2');process.exit(1)}; console.log('OK frame-src x'+n)"`
Expected: `OK frame-src x2`.

- [ ] **Step 5: Nested-frame spike (throwaway, not committed)**

**Step 5 (amended 2026-10-10 — automated scope):** Do NOT edit tracked files for the spike and do NOT attempt to drive an Extension Development Host from automation. Instead: (a) create the spike fixture files (proxy HTML + nested srcdoc test page) under the git-ignored scratch dir `.superpowers/sdd/2026-10-07-mcp-apps-support/spike/`; (b) in `docs/superpowers/plans/spike-results-mcp-apps.md`, record the fixture contents, the three PASS criteria verbatim, and set `Status: AWAITING MANUAL VERIFICATION — run F5 dev-host check per this document before enabling mcpAppsEnabled in production`; (c) do NOT record Decision: PRIMARY vs FALLBACK yet — leave a `Decision: PENDING` line. The CSP change + its unit tests from the earlier steps still land and commit as normal.

Proxy fixture content for item (a) — create `.superpowers/sdd/2026-10-07-mcp-apps-support/spike/proxy.html` with exactly this content:

```html
<!DOCTYPE html>
<html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; frame-src 'self' data:;">
</head><body>
<script>
  const inner = document.createElement("iframe");
  inner.setAttribute("sandbox", "allow-scripts");
  inner.srcdoc = "<!DOCTYPE html><html><body><div id='x'>no</div><script>document.getElementById('x').textContent='ran'<\/script></body></html>";
  document.body.appendChild(inner);
  window.addEventListener("message", (e) => console.log("[proxy] relay:", e.data));
</script>
</body></html>
```

**PASS criteria (all must hold):**
1. The inner frame shows `ran` (inline script executed despite the TOP-LEVEL webview CSP being nonce+strict-dynamic).
2. DevTools console of the outer frame logs `[proxy] relay:` for a message posted from the inner frame (add `parent.postMessage("ping","*")` to the srcdoc to test).
3. The webview itself still loads normally (no CSP violations for the React app).

**FAIL handling:** if criterion 1 fails, record it and adopt the documented fallback: render app HTML directly into the proxy document (no inner frame) — flag in the decision doc that isolation is weaker and requires architecture re-review before Task 9. If criterion 2 fails, the relay must use `MessageChannel` ports instead of direct `postMessage`; note the required change for Task 8.

- [ ] **Step 6: Record results and revert throwaway edits**

Write `docs/superpowers/plans/spike-results-mcp-apps.md`:

```markdown
# MCP Apps spike results (Task 1)

Date: <YYYY-MM-DD>  VS Code version: <help > about>

| Criterion | Result | Notes |
|---|---|---|
| Inner srcdoc inline script executes | PASS/FAIL | |
| proxy↔inner postMessage relay works | PASS/FAIL | |
| Webview app unaffected by frame-src | PASS/FAIL | |

Decision: <nested-frame model CONFIRMED / FALLBACK to render-into-proxy (requires re-review)>
```

Revert the throwaway iframe edit from `getDevHtmlContent` and delete the scratch file.

- [ ] **Step 7: Lint + commit**

Run: `pnpm --dir src exec eslint --prune-suppressions --max-warnings=0 core/webview/ClineProvider.ts`
Expected: exit 0, suppression count for the file unchanged.

```bash
git add src/core/webview/ClineProvider.ts src/core/webview/__tests__/ClineProvider.spec.ts docs/superpowers/plans/spike-results-mcp-apps.md
git commit -m "feat(mcp-apps): allow webview cspSource frames and record nested-frame spike"
```

---

### Task 2: `McpTool._meta`, UI-URI extractor, per-server UI-disabled helper (types)

**Files:**
- Modify: `packages/types/src/mcp.ts` (`McpTool` at line 70; add helpers after `countEnabledMcpTools`)
- Test: `packages/types/src/__tests__/mcp.spec.ts` (Create)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type McpToolUiMeta = { ui?: { resourceUri?: string }; "ui/resourceUri"?: string }`
  - `McpTool._meta?: McpToolUiMeta & Record<string, unknown>`
  - `function getMcpToolUiResourceUri(meta: Record<string, unknown> | undefined): string | undefined` — nested `_meta.ui.resourceUri` wins over legacy `_meta["ui/resourceUri"]`; returns `undefined` when neither is a non-empty string. Accepts either the tool's `_meta` or a result-level `_meta` (result override, architecture risk item).
  - `function isMcpServerUiDisabled(server: { config?: string } | undefined): boolean` — parses the server config JSON string, returns `disableUi === true`; never throws.

- [ ] **Step 1: Write the failing tests**

Create `packages/types/src/__tests__/mcp.spec.ts`:

```typescript
import { getMcpToolUiResourceUri, isMcpServerUiDisabled } from "../mcp"

describe("getMcpToolUiResourceUri", () => {
	it("reads the standard nested key", () => {
		expect(getMcpToolUiResourceUri({ ui: { resourceUri: "ui://demo/card" } })).toBe("ui://demo/card")
	})

	it("falls back to the legacy flat key", () => {
		expect(getMcpToolUiResourceUri({ "ui/resourceUri": "ui://legacy/view" })).toBe("ui://legacy/view")
	})

	it("prefers the nested key when both are present", () => {
		expect(
			getMcpToolUiResourceUri({ ui: { resourceUri: "ui://new" }, "ui/resourceUri": "ui://old" }),
		).toBe("ui://new")
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/types && npx vitest run src/__tests__/mcp.spec.ts`
Expected: FAIL — `getMcpToolUiResourceUri is not exported` (import error).

- [ ] **Step 3: Implement types and helpers**

In [`packages/types/src/mcp.ts`](../../../packages/types/src/mcp.ts:70), replace the `McpTool` type:

```typescript
/**
 * MCP Apps UI metadata. Standard key is `_meta.ui.resourceUri`; legacy MCP-UI
 * servers use the flat key `_meta["ui/resourceUri"]`. See
 * docs/architecture/mcp-apps-ui-support.md.
 */
export type McpToolUiMeta = {
	ui?: { resourceUri?: string }
	"ui/resourceUri"?: string
}

export type McpTool = {
	name: string
	description?: string
	inputSchema?: object
	alwaysAllow?: boolean
	enabledForPrompt?: boolean
	_meta?: McpToolUiMeta & Record<string, unknown>
}
```

Append at the end of the file:

```typescript
/**
 * Extract the MCP Apps UI resource URI from a tool's (or tool result's) `_meta`.
 * Nested `ui.resourceUri` takes precedence over legacy `ui/resourceUri`,
 * mirroring `getToolUiResourceUri` in @modelcontextprotocol/ext-apps 1.x.
 */
export function getMcpToolUiResourceUri(meta: Record<string, unknown> | undefined): string | undefined {
	if (!meta || typeof meta !== "object") {
		return undefined
	}

	const nested = (meta as McpToolUiMeta).ui?.resourceUri
	if (typeof nested === "string" && nested.length > 0) {
		return nested
	}

	const legacy = (meta as McpToolUiMeta)["ui/resourceUri"]
	if (typeof legacy === "string" && legacy.length > 0) {
		return legacy
	}

	return undefined
}

/**
 * Whether an MCP server opted out of UI rendering via `disableUi` in its
 * mcp.json entry. The config arrives as the raw JSON string on McpServer.config.
 */
export function isMcpServerUiDisabled(server: { config?: string } | undefined): boolean {
	if (!server?.config) {
		return false
	}

	try {
		const parsed = JSON.parse(server.config) as { disableUi?: unknown }
		return parsed?.disableUi === true
	} catch {
		return false
	}
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/types && npx vitest run src/__tests__/mcp.spec.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/types/src/mcp.ts packages/types/src/__tests__/mcp.spec.ts
git commit -m "feat(mcp-apps): typed McpTool._meta with UI resource uri extractor helpers"
```

---

### Task 3: `mcpAppsEnabled` full settings round trip

**Files:**
- Modify: `packages/types/src/global-settings.ts` (next to `mcpEnabled` at line 244; default constant near `DEFAULT_DESTRUCTIVE_COMMAND_GUARD_ENABLED` at line 50)
- Modify: `packages/types/src/vscode-extension-host.ts` (`ExtensionState.mcpEnabled: boolean` at line 361)
- Modify: `src/core/webview/ClineProvider.ts` (`getStateToPostToWebview` destructuring ~line 2637 and return ~line 2808; `getState()` return ~line 3044)
- Modify: `src/core/webview/webviewMessageHandler.ts` (`updateSettings` special-case chain, `mcpEnabled` branch at lines 836–842)
- Modify: `webview-ui/src/context/ExtensionStateContext.tsx` (defaults ~line 220; setter pattern ~line 595; interface ~line 100)
- Modify: `webview-ui/src/components/settings/SettingsView.tsx` (destructuring ~line 181, cachedState init ~line 425, McpView props ~line 914)
- Create: `webview-ui/src/components/mcp/McpAppsToggle.tsx`
- Modify: `webview-ui/src/components/mcp/McpView.tsx` (props interface ~lines 31–41, render ~line 67)
- Modify: `webview-ui/src/i18n/locales/en/mcp.json` (inside the top-level object, next to `enableToggle`)
- Test: `src/core/webview/__tests__/ClineProvider.spec.ts`, `src/core/webview/__tests__/webviewMessageHandler.spec.ts`, `webview-ui/src/components/mcp/__tests__/McpAppsToggle.spec.tsx`

**Interfaces:**
- Consumes: nothing from Tasks 1–2.
- Produces: persisted setting `mcpAppsEnabled: boolean` (default `false`) available as `ExtensionState.mcpAppsEnabled`, webview context value `mcpAppsEnabled` + setter `setMcpAppsEnabled(value: boolean)`, exported constant `DEFAULT_MCP_APPS_ENABLED = false` from `@roo-code/types`. Toggling it triggers `McpHub.refreshAllConnections()` so capability negotiation (Task 5) converges without a manual restart.

- [ ] **Step 1: Write the failing host-side tests**

In `src/core/webview/__tests__/webviewMessageHandler.spec.ts`, append (mirroring the existing `describe("webviewMessageHandler - mcpEnabled", ...)` at line 1191, including its `mockMcpHub`/`mockClineProvider` setup — copy that beforeEach into the new describe):

```typescript
describe("webviewMessageHandler - mcpAppsEnabled", () => {
	let mockMcpHub: any

	beforeEach(() => {
		mockMcpHub = {
			handleMcpEnabledChange: vi.fn().mockResolvedValue(undefined),
			refreshAllConnections: vi.fn().mockResolvedValue(undefined),
		}
		;(mockClineProvider as any).getMcpHub = vi.fn().mockReturnValue(mockMcpHub)
	})

	it("refreshes MCP connections when mcpAppsEnabled changes", async () => {
		await webviewMessageHandler(mockClineProvider, {
			type: "updateSettings",
			updatedSettings: { mcpAppsEnabled: true },
		})

		expect(mockMcpHub.refreshAllConnections).toHaveBeenCalledTimes(1)
		expect(mockClineProvider.postStateToWebview).toHaveBeenCalledTimes(1)
	})
})
```

In `src/core/webview/__tests__/ClineProvider.spec.ts`, append inside the existing top-level describe (follow the exact `getState`-mock pattern of `"handles mcpEnabled setting correctly"` at ~line 2261):

```typescript
		test("returns mcpAppsEnabled in state posted to webview, defaulting to false", async () => {
			await provider.resolveWebviewView(mockWebviewView)

			// Same partial-state-mock pattern as the existing "handles mcpEnabled setting correctly" test.
			vi.spyOn(provider, "getState").mockResolvedValueOnce({ mcpAppsEnabled: true } as any)
			let state = await provider.getStateToPostToWebview()
			expect(state.mcpAppsEnabled).toBe(true)

			vi.spyOn(provider, "getState").mockResolvedValueOnce({} as any)
			state = await provider.getStateToPostToWebview()
			expect(state.mcpAppsEnabled).toBe(false)
		})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd src && npx vitest run core/webview/__tests__/webviewMessageHandler.spec.ts -t "mcpAppsEnabled"` — Expected: FAIL (`refreshAllConnections` not called; the settings loop treats it as a generic key).
Run: `cd src && npx vitest run core/webview/__tests__/ClineProvider.spec.ts -t "mcpAppsEnabled"` — Expected: FAIL (`state.mcpAppsEnabled` is `undefined`).

- [ ] **Step 3: Implement schema + ExtensionState + provider round trip**

In [`packages/types/src/global-settings.ts`](../../../packages/types/src/global-settings.ts:244), next to `mcpEnabled`:

```typescript
	mcpEnabled: z.boolean().optional(),
	/**
	 * Opt-in rendering of MCP Apps interactive UIs (untrusted third-party HTML).
	 * @default false
	 */
	mcpAppsEnabled: z.boolean().optional(),
```

Near the other defaults (after `DEFAULT_DESTRUCTIVE_COMMAND_GUARD_ENABLED`, line 50):

```typescript
export const DEFAULT_MCP_APPS_ENABLED = false
```

In [`packages/types/src/vscode-extension-host.ts`](../../../packages/types/src/vscode-extension-host.ts:361), after `mcpEnabled: boolean`:

```typescript
	mcpAppsEnabled: boolean
```

In [`ClineProvider.getStateToPostToWebview`](../../../src/core/webview/ClineProvider.ts:2594): add `mcpAppsEnabled,` to the destructuring list right after `mcpEnabled,` (~line 2637), and in the returned object right after `mcpEnabled: mcpEnabled ?? true,` (~line 2808) add:

```typescript
			mcpAppsEnabled: mcpAppsEnabled ?? DEFAULT_MCP_APPS_ENABLED,
```

Add `DEFAULT_MCP_APPS_ENABLED` to the existing `@roo-code/types` import at the top of `ClineProvider.ts`. In [`getState()`](../../../src/core/webview/ClineProvider.ts:2923)'s returned object, right after `mcpEnabled: stateValues.mcpEnabled ?? true,` (~line 3044) add:

```typescript
			mcpAppsEnabled: stateValues.mcpAppsEnabled ?? DEFAULT_MCP_APPS_ENABLED,
```

In [`webviewMessageHandler.ts`](../../../src/core/webview/webviewMessageHandler.ts:836), extend the `mcpEnabled` branch chain (insert after the `mcpEnabled` block, before `experiments`):

```typescript
					} else if (key === "mcpAppsEnabled") {
						const previousValue = getGlobalState("mcpAppsEnabled") ?? DEFAULT_MCP_APPS_ENABLED
						newValue = value ?? false

						// Capabilities are negotiated at connect time; refresh connections only when
						// the value actually changed so unrelated settings saves don't reconnect servers.
						if (newValue !== previousValue) {
							const mcpHub = provider.getMcpHub()

							if (mcpHub) {
								await mcpHub.refreshAllConnections()
							}
						}
					} else if (key === "experiments") {
```

> **Amendment (2026-10-20, Task 3 review round):** the toggle must follow the `McpEnabledToggle` Save/Discard contract — controlled usage buffers via the setter prop only (no `postMessage`, no live-state write); the handler refreshes connections only when the value actually changed (`terminalProfile` precedent), because `handleSubmit` posts the full settings payload on every save. `mcpEnabled`'s pre-existing unconditional reconnect is out of scope.

- [ ] **Step 4: Run host tests to verify they pass**

Run: `cd src && npx vitest run core/webview/__tests__/webviewMessageHandler.spec.ts core/webview/__tests__/ClineProvider.spec.ts`
Expected: PASS (new + existing).

- [ ] **Step 5: Write the failing webview toggle test**

Create `webview-ui/src/components/mcp/__tests__/McpAppsToggle.spec.tsx`, modeled exactly on the existing [`McpEnabledToggle.spec.tsx`](../../../webview-ui/src/components/mcp/__tests__/McpEnabledToggle.spec.tsx) (copy its `vi.mock("@src/utils/vscode")` and `useExtensionState` mock scaffolding, substituting names):

```tsx
import { render } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import McpAppsToggle from "../McpAppsToggle"
import { vscode } from "@src/utils/vscode"

const contextSetMcpAppsEnabled = vi.fn()

vi.mock("@src/utils/vscode", () => ({
	vscode: { postMessage: vi.fn() },
}))

vi.mock("@src/context/ExtensionStateContext", () => ({
	useExtensionState: () => ({
		mcpAppsEnabled: true,
		setMcpAppsEnabled: contextSetMcpAppsEnabled,
	}),
}))

vi.mock("react-i18next", () => ({
	useTranslation: () => ({ t: (key: string) => key }),
}))

describe("McpAppsToggle", () => {
	it("buffers via the setter prop without persisting before Save when controlled", async () => {
		const setMcpAppsEnabled = vi.fn()
		const { getByRole } = render(<McpAppsToggle mcpAppsEnabled={true} setMcpAppsEnabled={setMcpAppsEnabled} />)

		const checkbox = getByRole("checkbox")
		expect(checkbox).toBeChecked()

		await userEvent.click(checkbox)

		// Controlled (SettingsView) must buffer in cachedState: no persistence, no live-state write.
		expect(setMcpAppsEnabled).toHaveBeenCalledWith(false)
		expect(vscode.postMessage).not.toHaveBeenCalled()
		expect(contextSetMcpAppsEnabled).not.toHaveBeenCalled()
	})
})
```

Run: `cd webview-ui && npx vitest run src/components/mcp/__tests__/McpAppsToggle.spec.tsx`
Expected: FAIL — cannot resolve `../McpAppsToggle`.

- [ ] **Step 6: Implement the webview side**

Create [`webview-ui/src/components/mcp/McpAppsToggle.tsx`](../../../webview-ui/src/components/mcp/McpAppsToggle.tsx) mirroring [`McpEnabledToggle.tsx`](../../../webview-ui/src/components/mcp/McpEnabledToggle.tsx) (props-optional-with-context-fallback pattern; Tailwind classes instead of its inline styles):

```tsx
import { useTranslation } from "react-i18next"

import { useExtensionState } from "@src/context/ExtensionStateContext"
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
	const { t } = useTranslation()

	// SettingsView passes buffered (cachedState) values; fall back to live state when uncontrolled.
	const mcpAppsEnabled = propsMcpAppsEnabled ?? contextMcpAppsEnabled

	const handleChange = (e: Event) => {
		const target = e.target as HTMLInputElement

		if (propsSetMcpAppsEnabled) {
			propsSetMcpAppsEnabled(target.checked)
		} else {
			contextSetMcpAppsEnabled(target.checked)
			vscode.postMessage({ type: "updateSettings", updatedSettings: { mcpAppsEnabled: target.checked } })
		}
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
```

(`VSCodeCheckbox` is a global web component already ambient-typed in the webview — same usage as `McpEnabledToggle.tsx:41`. If `useTranslation` import differs there, copy that file's exact i18n import (`useAppTranslation`) instead.)

In [`ExtensionStateContext.tsx`](../../../webview-ui/src/context/ExtensionStateContext.tsx): add to the context interface near line 100:

```typescript
	mcpAppsEnabled: boolean
	setMcpAppsEnabled: (value: boolean) => void
```

add to the default state object near line 220 (`mcpEnabled: true,`):

```typescript
	mcpAppsEnabled: false,
```

and to the value builder near line 595 (`setMcpEnabled: ...`):

```typescript
		setMcpAppsEnabled: (value) => setState((prevState) => ({ ...prevState, mcpAppsEnabled: value })),
```

In [`McpView.tsx`](../../../webview-ui/src/components/mcp/McpView.tsx:31): extend `McpViewProps` with `mcpAppsEnabled?: boolean` / `setMcpAppsEnabled?: (value: boolean) => void`, destructure them like `propsMcpEnabled` (line 36–41 pattern), and render `<McpAppsToggle mcpAppsEnabled={mcpAppsEnabled} setMcpAppsEnabled={setMcpAppsEnabled} />` directly after the existing `<McpEnabledToggle ... />` (line 67) — but OUTSIDE the `{mcpEnabled && (...)}` block so users can pre-enable it. Import at top: `import McpAppsToggle from "./McpAppsToggle"`.

In [`SettingsView.tsx`](../../../webview-ui/src/components/settings/SettingsView.tsx): add `mcpAppsEnabled,` to the `useExtensionState()` destructuring after `mcpEnabled,` (~line 181); add `mcpAppsEnabled,` to the cachedState initialization object after `mcpEnabled,` (~line 425) — this makes it part of the diff-based `updateSettings` payload from `handleSubmit()` automatically (verified by the existing change-detection pattern in `SettingsView.unsaved-changes.spec.tsx:592`); and extend the `<McpView ...>` usage (~line 914):

```tsx
							<McpView
								mcpEnabled={mcpEnabled}
								setMcpEnabled={(value) => setCachedStateField("mcpEnabled", value)}
								mcpAppsEnabled={mcpAppsEnabled}
								setMcpAppsEnabled={(value) => setCachedStateField("mcpAppsEnabled", value)}
							/>
```

In `webview-ui/src/i18n/locales/en/mcp.json`, after the `enableToggle` object:

```json
	"appsToggle": {
		"title": "Enable MCP Apps UIs",
		"description": "Render interactive tool UIs provided by MCP servers in chat. Runs untrusted HTML from servers in a sandboxed frame."
	},
```

- [ ] **Step 7: Run webview tests + type check**

Run: `cd webview-ui && npx vitest run src/components/mcp/__tests__/McpAppsToggle.spec.tsx src/components/settings/__tests__/SettingsView.unsaved-changes.spec.tsx`
Expected: PASS. (If the unsaved-changes spec's extension-state fixture object needs `mcpAppsEnabled`, add `mcpAppsEnabled: false,` next to its `mcpEnabled: false,` at ~line 285.)
Run: `cd webview-ui && npx tsc --noEmit` — Expected: no errors.

- [ ] **Step 8: Lint + commit**

Run: `pnpm --dir src exec eslint --prune-suppressions --max-warnings=0 core/webview/ClineProvider.ts core/webview/webviewMessageHandler.ts` — Expected: exit 0, counts unchanged.

```bash
git add packages/types/src/global-settings.ts packages/types/src/vscode-extension-host.ts src/core/webview/ClineProvider.ts src/core/webview/webviewMessageHandler.ts src/core/webview/__tests__/ClineProvider.spec.ts src/core/webview/__tests__/webviewMessageHandler.spec.ts webview-ui/src/components/mcp/McpAppsToggle.tsx webview-ui/src/components/mcp/McpView.tsx webview-ui/src/components/mcp/__tests__/McpAppsToggle.spec.tsx webview-ui/src/context/ExtensionStateContext.tsx webview-ui/src/components/settings/SettingsView.tsx webview-ui/src/i18n/locales/en/mcp.json
git commit -m "feat(mcp-apps): mcpAppsEnabled setting with full persistence round trip"
```

---

### Task 4: Per-server `disableUi` config + toggle

**Files:**
- Modify: `src/services/mcp/McpHub.ts` (`BaseConfigSchema` lines 72–78; new `toggleServerUi` method near `toggleServerDisabled` at line 1913)
- Modify: `src/core/webview/webviewMessageHandler.ts` (new case next to `toggleMcpServer` at line 1814)
- Modify: `webview-ui/src/components/mcp/McpView.tsx` (expanded server row section, ~lines 340+)
- Modify: `webview-ui/src/i18n/locales/en/mcp.json` (`serverRow.disableUi`)
- Test: `src/services/mcp/__tests__/McpHub.spec.ts`, `src/core/webview/__tests__/webviewMessageHandler.spec.ts`

**Interfaces:**
- Consumes: `isMcpServerUiDisabled(server)` from Task 2 (webview render gate reads `server.config`).
- Produces: `disableUi?: boolean` accepted in every mcp.json server entry (all three variants via `BaseConfigSchema`); `McpHub.toggleServerUi(serverName: string, source: "global" | "project", enabled: boolean): Promise<void>`; webview message `{ type: "toggleMcpServerUi", serverName, source, isEnabled }`.

- [ ] **Step 1: Write the failing McpHub tests**

Append to `src/services/mcp/__tests__/McpHub.spec.ts` inside the existing `describe("McpHub", ...)`, reusing its `mockProvider` and the same connection-seeding pattern used by the existing `toggleServerDisabled` tests (search the spec for `toggleServerDisabled` and copy that test's setup lines verbatim):

```typescript
		it("accepts disableUi in the server config schema", () => {
			const parsed = ServerConfigSchema.parse({ command: "node", disableUi: true })
			expect(parsed.disableUi).toBe(true)
			expect(ServerConfigSchema.parse({ command: "node" }).disableUi).toBeUndefined()
		})

		it("toggleServerUi persists the inverse of enabled and refreshes in-memory config", async () => {
			// Seed a connected server exactly like the toggleServerDisabled tests do, then:
			await mcpHub.toggleServerUi("test-server", "global", false)

			expect(safeWriteJson).toHaveBeenCalled()
			const written = (safeWriteJson as Mock).mock.calls.at(-1)?.[1] as Record<string, any>
			expect(written.mcpServers["test-server"].disableUi).toBe(true)
		})
```

- [ ] **Step 2: Run to verify failure**

Run: `cd src && npx vitest run services/mcp/__tests__/McpHub.spec.ts -t "disableUi"`
Expected: FAIL — `parsed.disableUi` is `undefined` (schema strips unknown keys) and `mcpHub.toggleServerUi is not a function`.

- [ ] **Step 3: Implement schema + method + message case**

In [`BaseConfigSchema`](../../../src/services/mcp/McpHub.ts:72), after `disabledTools` (line 77):

```typescript
	disabledTools: z.array(z.string()).default([]),
	// Opt this server out of MCP Apps UI rendering (see docs/architecture/mcp-apps-ui-support.md).
	disableUi: z.boolean().optional(),
})
```

Add to `McpHub` (place after [`toggleServerDisabled`](../../../src/services/mcp/McpHub.ts:1913); no reconnect is needed because UI gating is re-checked per request):

```typescript
	/**
	 * Persist the per-server `disableUi` flag and keep the in-memory config
	 * string fresh so host-side re-validation (handleMcpAppRequest) sees it.
	 */
	public async toggleServerUi(serverName: string, source: "global" | "project", enabled: boolean): Promise<void> {
		const connection = this.findConnection(serverName, source)
		if (!connection) {
			throw new Error(`Server ${serverName}${source ? ` with source ${source}` : ""} not found`)
		}

		const serverSource = connection.server.source || "global"
		await this.updateServerConfig(serverName, { disableUi: !enabled }, serverSource)

		try {
			const updatedConfig = await this.readServerConfigFromFile(serverName, serverSource)
			connection.server.config = JSON.stringify(updatedConfig)
		} catch (error) {
			console.error(`Failed to refresh in-memory config for ${serverName}:`, error)
		}

		await this.notifyWebviewOfServerChanges()
	}
```

In [`webviewMessageHandler.ts`](../../../src/core/webview/webviewMessageHandler.ts:1814), after the `toggleMcpServer` case:

```typescript
		case "toggleMcpServerUi": {
			try {
				await provider
					.getMcpHub()
					?.toggleServerUi(
						message.serverName!,
						message.source as "global" | "project",
						Boolean(message.isEnabled),
					)
			} catch (error) {
				provider.log(
					`Failed to toggle UI for MCP server ${message.serverName}: ${JSON.stringify(error, Object.getOwnPropertyNames(error), 2)}`,
				)
			}
			break
		}
```

(`isEnabled` already exists on `WebviewMessage` at [`vscode-extension-host.ts:669`](../../../packages/types/src/vscode-extension-host.ts:669) — no type change needed.)

- [ ] **Step 4: Add the webview toggle UI**

In [`McpView.tsx`](../../../webview-ui/src/components/mcp/McpView.tsx:340)'s expanded server section (the block that starts rendering after `isExpandable ? isExpanded && (`), add a row above the tools panel, importing `isMcpServerUiDisabled` from `@roo-code/types`:

```tsx
								<div className="flex items-center justify-between py-1">
									<span>{t("mcp:serverRow.disableUi")}</span>
									<ToggleSwitch
										checked={!isMcpServerUiDisabled(server)}
										onChange={(e) => {
											const checked = (e.target as HTMLInputElement).checked
											vscode.postMessage({
												type: "toggleMcpServerUi",
												serverName: server.name,
												source: server.source || "global",
												isEnabled: checked,
											})
										}}
										size="medium"
										aria-label={`Toggle UI for ${server.name} server`}
									/>
								</div>
```

In `webview-ui/src/i18n/locales/en/mcp.json`, inside the top-level object:

```json
	"serverRow": {
		"disableUi": "Disable interactive UIs for this server"
	},
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd src && npx vitest run services/mcp/__tests__/McpHub.spec.ts -t "disableUi"` — Expected: PASS.
Run: `cd webview-ui && npx tsc --noEmit` — Expected: no errors.

- [ ] **Step 6: Lint + commit**

Run: `pnpm --dir src exec eslint --prune-suppressions --max-warnings=0 services/mcp/McpHub.ts core/webview/webviewMessageHandler.ts` — Expected: exit 0, counts unchanged.

```bash
git add src/services/mcp/McpHub.ts src/services/mcp/__tests__/McpHub.spec.ts src/core/webview/webviewMessageHandler.ts webview-ui/src/components/mcp/McpView.tsx webview-ui/src/i18n/locales/en/mcp.json
git commit -m "feat(mcp-apps): per-server disableUi config with settings toggle"
```

---

### Task 5: Declare the `io.modelcontextprotocol/ui` client capability

**Files:**
- Modify: `src/services/mcp/McpHub.ts` (`new Client(...)` at lines 718–726; new private `isMcpAppsEnabled()` next to `isMcpEnabled()` at ~line 681)
- Test: `src/services/mcp/__tests__/McpHub.spec.ts`

**Interfaces:**
- Consumes: `mcpAppsEnabled` from provider state (Task 3).
- Produces: when the flag is on, every new MCP connection's `initialize` handshake advertises `capabilities.extensions["io.modelcontextprotocol/ui"] = {}`; when off, `capabilities` stays `{}`. SDK 1.29's `ClientCapabilitiesSchema.extensions` is an open record — no SDK change. Servers only see this at connect time; Task 3's `refreshAllConnections()` on flag change closes the staleness window.

- [ ] **Step 1: Write the failing tests**

Append to `describe("McpHub", ...)` in `src/services/mcp/__tests__/McpHub.spec.ts`. The spec already mocks the SDK `Client` as `vi.fn()` (line 128–130) and seeds `mockProvider.getState`; follow the invocation style of the existing `"should use MCP_DISABLED reason..."` test (line 744) for calling `connectToServer`:

```typescript
		it("declares the io.modelcontextprotocol/ui extension capability when mcpAppsEnabled is true", async () => {
			mockProvider.getState = vi.fn().mockResolvedValue({ mcpEnabled: true, mcpAppsEnabled: true })

			await (mcpHub as any).connectToServer(
				"ui-cap-server",
				{ type: "stdio", command: "node", args: [], alwaysAllow: [], disabledTools: [] },
				"global",
			)

			const Client = (await import("@modelcontextprotocol/sdk/client/index.js")).Client as Mock
			const clientOptions = Client.mock.calls.at(-1)?.[1]
			expect(clientOptions.capabilities.extensions).toEqual({ "io.modelcontextprotocol/ui": {} })
		})

		it("does not declare UI capability when mcpAppsEnabled is false or unset", async () => {
			for (const state of [{ mcpEnabled: true, mcpAppsEnabled: false }, { mcpEnabled: true }]) {
				mockProvider.getState = vi.fn().mockResolvedValue(state)

				await (mcpHub as any).connectToServer(
					"no-ui-cap-server",
					{ type: "stdio", command: "node", args: [], alwaysAllow: [], disabledTools: [] },
					"global",
				)

				const Client = (await import("@modelcontextprotocol/sdk/client/index.js")).Client as Mock
				expect(Client.mock.calls.at(-1)?.[1].capabilities).toEqual({})
			}
		})
```

- [ ] **Step 2: Run to verify failure**

Run: `cd src && npx vitest run services/mcp/__tests__/McpHub.spec.ts -t "io.modelcontextprotocol/ui"`
Expected: FAIL — `expect(clientOptions.capabilities.extensions).toEqual(...)` receives `undefined`.

- [ ] **Step 3: Implement capability declaration**

In [`McpHub.ts`](../../../src/services/mcp/McpHub.ts:681), after `isMcpEnabled`:

```typescript
	private async isMcpAppsEnabled(): Promise<boolean> {
		const provider = this.providerRef.deref()
		if (!provider) {
			return false
		}
		const state = await provider.getState()
		return state.mcpAppsEnabled ?? false
	}
```

Replace the [`new Client(...)` call](../../../src/services/mcp/McpHub.ts:718):

```typescript
			const mcpAppsEnabled = await this.isMcpAppsEnabled()
			const client = new Client(
				{
					name: "Roo Code",
					version: this.providerRef.deref()?.context.extension?.packageJSON?.version ?? "1.0.0",
				},
				{
					capabilities: mcpAppsEnabled ? { extensions: { "io.modelcontextprotocol/ui": {} } } : {},
				},
			)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd src && npx vitest run services/mcp/__tests__/McpHub.spec.ts`
Expected: PASS (new + all pre-existing — the flag defaults false, so existing capability expectations are unaffected).

- [ ] **Step 5: Lint + commit**

Run: `pnpm --dir src exec eslint --prune-suppressions --max-warnings=0 services/mcp/McpHub.ts` — Expected: exit 0, count unchanged.

```bash
git add src/services/mcp/McpHub.ts src/services/mcp/__tests__/McpHub.spec.ts
git commit -m "feat(mcp-apps): declare ui extension capability behind mcpAppsEnabled"
```

---

### Task 6: Extension-host bridge — `mcpAppRequest` handler with re-validation

**Files:**
- Modify: `packages/types/src/vscode-extension-host.ts` (`ExtensionMessage` type union ends `"themeFixtureProbeRequest"` at line 110; `WebviewMessage` type union ends `"themeFixtureProbeResponse"` at line 648)
- Create: `src/services/mcp/mcp-app-bridge.ts`
- Modify: `src/services/mcp/McpHub.ts` (new public `handleMcpAppRequest`, place after [`callTool`](../../../src/services/mcp/McpHub.ts:2213))
- Modify: `src/core/webview/webviewMessageHandler.ts` (new case next to the MCP cases at ~line 1834)
- Test: `src/services/mcp/__tests__/mcp-app-bridge.spec.ts`, `src/services/mcp/__tests__/McpHub.spec.ts`, `src/core/webview/__tests__/webviewMessageHandler.spec.ts`

**Interfaces:**
- Consumes: `McpHub.readResource` (line 2194), `McpHub.callTool` (line 2213), `isMcpServerUiDisabled` (Task 2), `mcpAppsEnabled` state (Task 3).
- Produces (exact names later tasks rely on):
  - `WebviewMessage`: `type: "mcpAppRequest"` with existing `requestId`, `serverName`, `source` and new fields `mcpAppMethod?: string`, `mcpAppParams?: Record<string, unknown>`.
  - `ExtensionMessage`: `type: "mcpAppResponse"` with existing `requestId` (line 157) and new field `mcpAppResponse?: { ok: true; result: unknown } | { ok: false; error: { code: number; message: string } }`.
  - `src/services/mcp/mcp-app-bridge.ts`: `MCP_APP_UI_URI_PREFIX = "ui://"`, `MCP_APP_MAX_RESOURCE_BYTES = 2 * 1024 * 1024`, `type McpAppRequest = { requestId: string; serverName: string; source?: "global" | "project"; method: string; params?: Record<string, unknown> }`, `type McpAppResponsePayload = { ok: true; result: unknown } | { ok: false; error: { code: number; message: string } }`, `function validateMcpAppRequest(request: McpAppRequest, opts: { uiDisabled: boolean }): { ok: true } | { ok: false; code: number; message: string }`, `function estimateResourceBytes(response: { contents?: Array<{ text?: string; blob?: string }> }): number`.
  - `McpHub.handleMcpAppRequest(request: McpAppRequest): Promise<McpAppResponsePayload>`.
  - Error codes: `-32601` unknown method, `-32602` invalid params (missing uri / non-`ui://`), `-32004` UI disabled for server or feature off, `-32001` payload too large, `-32603` execution error.

- [ ] **Step 1: Write the failing validator tests**

Create `src/services/mcp/__tests__/mcp-app-bridge.spec.ts`:

```typescript
import {
	estimateResourceBytes,
	MCP_APP_MAX_RESOURCE_BYTES,
	validateMcpAppRequest,
	type McpAppRequest,
} from "../mcp-app-bridge"

const base: McpAppRequest = { requestId: "r1", serverName: "srv", method: "resources/read", params: { uri: "ui://a/b" } }

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
```

- [ ] **Step 2: Run to verify failure**

Run: `cd src && npx vitest run services/mcp/__tests__/mcp-app-bridge.spec.ts`
Expected: FAIL — module `../mcp-app-bridge` does not exist.

- [ ] **Step 3: Implement the validator module**

Create `src/services/mcp/mcp-app-bridge.ts`:

```typescript
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
export function estimateResourceBytes(response: Pick<McpResourceResponse, "contents"> | Record<string, unknown>): number {
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
			bytes += decoded.length > 0 || item.blob.length === 0 ? decoded.length : item.blob.length
		}
	}
	return bytes
}
```

- [ ] **Step 4: Run validator tests to verify they pass**

Run: `cd src && npx vitest run services/mcp/__tests__/mcp-app-bridge.spec.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Write the failing McpHub + message-handler tests**

Append to `describe("McpHub", ...)` in `src/services/mcp/__tests__/McpHub.spec.ts` (seed connections exactly as existing `readResource`/`callTool` tests do — search the spec for `readResource` and copy that seeding block):

```typescript
		it("handleMcpAppRequest routes resources/read to readResource", async () => {
			// Seed a connected "test-server" exactly like the readResource tests, then:
			mockProvider.getState = vi.fn().mockResolvedValue({ mcpEnabled: true, mcpAppsEnabled: true })
			const readSpy = vi.spyOn(mcpHub, "readResource").mockResolvedValue({
				contents: [{ uri: "ui://demo/card", mimeType: "text/html;profile=mcp-app", text: "<html></html>" }],
			})

			const response = await mcpHub.handleMcpAppRequest({
				requestId: "r1",
				serverName: "test-server",
				method: "resources/read",
				params: { uri: "ui://demo/card" },
			})

			expect(readSpy).toHaveBeenCalledWith("test-server", "ui://demo/card", undefined)
			expect(response.ok).toBe(true)
		})

		it("handleMcpAppRequest rejects oversized payloads with -32001 without returning content", async () => {
			mockProvider.getState = vi.fn().mockResolvedValue({ mcpEnabled: true, mcpAppsEnabled: true })
			vi.spyOn(mcpHub, "readResource").mockResolvedValue({
				contents: [{ uri: "ui://demo/big", text: "x".repeat(3 * 1024 * 1024) }],
			})

			const response = await mcpHub.handleMcpAppRequest({
				requestId: "r2",
				serverName: "test-server",
				method: "resources/read",
				params: { uri: "ui://demo/big" },
			})

			expect(response).toMatchObject({ ok: false, error: { code: -32001 } })
		})

		it("handleMcpAppRequest rejects when the server config sets disableUi", async () => {
			// Seed a connected server whose server.config JSON contains {"disableUi":true}:
			mockProvider.getState = vi.fn().mockResolvedValue({ mcpEnabled: true, mcpAppsEnabled: true })
			const response = await mcpHub.handleMcpAppRequest({
				requestId: "r3",
				serverName: "ui-disabled-server",
				method: "tools/call",
				params: { name: "anything" },
			})

			expect(response).toMatchObject({ ok: false, error: { code: -32004 } })
		})

		it("handleMcpAppRequest converts execution failures to -32603 responses", async () => {
			mockProvider.getState = vi.fn().mockResolvedValue({ mcpEnabled: true, mcpAppsEnabled: true })
			vi.spyOn(mcpHub, "callTool").mockRejectedValue(new Error("boom"))

			const response = await mcpHub.handleMcpAppRequest({
				requestId: "r4",
				serverName: "test-server",
				method: "tools/call",
				params: { name: "flaky" },
			})

			expect(response).toMatchObject({ ok: false, error: { code: -32603, message: "boom" } })
		})
```

Append to `src/core/webview/__tests__/webviewMessageHandler.spec.ts` (reuse the file's `mockClineProvider`; give its `getMcpHub()` a hub exposing `handleMcpAppRequest`):

```typescript
describe("webviewMessageHandler - mcpAppRequest", () => {
	it("routes the request to McpHub and posts a correlated mcpAppResponse", async () => {
		const handleMcpAppRequest = vi.fn().mockResolvedValue({ ok: true, result: { contents: [] } })
		;(mockClineProvider as any).getMcpHub = vi.fn().mockReturnValue({ handleMcpAppRequest })

		await webviewMessageHandler(mockClineProvider, {
			type: "mcpAppRequest",
			requestId: "req-42",
			serverName: "srv",
			mcpAppMethod: "resources/read",
			mcpAppParams: { uri: "ui://demo/card" },
		})

		expect(handleMcpAppRequest).toHaveBeenCalledWith({
			requestId: "req-42",
			serverName: "srv",
			source: undefined,
			method: "resources/read",
			params: { uri: "ui://demo/card" },
		})
		expect(mockClineProvider.postMessageToWebview).toHaveBeenCalledWith({
			type: "mcpAppResponse",
			requestId: "req-42",
			mcpAppResponse: { ok: true, result: { contents: [] } },
		})
	})

	it("ignores requests without a requestId or serverName", async () => {
		const handleMcpAppRequest = vi.fn()
		;(mockClineProvider as any).getMcpHub = vi.fn().mockReturnValue({ handleMcpAppRequest })

		await webviewMessageHandler(mockClineProvider, { type: "mcpAppRequest", mcpAppMethod: "tools/call" })

		expect(handleMcpAppRequest).not.toHaveBeenCalled()
		expect(mockClineProvider.postMessageToWebview).not.toHaveBeenCalled()
	})
})
```

Run: `cd src && npx vitest run services/mcp/__tests__/McpHub.spec.ts -t "handleMcpAppRequest"` — Expected: FAIL (`handleMcpAppRequest` not a function).

- [ ] **Step 6: Implement message types, hub method, handler case**

In [`packages/types/src/vscode-extension-host.ts`](../../../packages/types/src/vscode-extension-host.ts:110), add to the `ExtensionMessage` type union after `"themeFixtureProbeRequest"`:

```typescript
		| "mcpAppResponse"
```

and after its `requestId?: string` (line 157):

```typescript
	mcpAppResponse?: { ok: true; result: unknown } | { ok: false; error: { code: number; message: string } }
```

In the same file, add to the `WebviewMessage` type union after `"themeFixtureProbeResponse"` (line 648):

```typescript
		| "mcpAppRequest"
```

and after its `requestId?: string` (line 694):

```typescript
	mcpAppMethod?: string // For mcpAppRequest: proxied MCP method ("resources/read" | "tools/call")
	mcpAppParams?: Record<string, unknown> // For mcpAppRequest: JSON-RPC params
```

In [`McpHub.ts`](../../../src/services/mcp/McpHub.ts:2213), after `callTool`, add (imports: `validateMcpAppRequest`, `estimateResourceBytes`, `McpAppRequest`, `McpAppResponsePayload` from `./mcp-app-bridge`; `isMcpServerUiDisabled` from `@roo-code/types`):

```typescript
	/**
	 * Serve a webview-initiated MCP Apps request (Flow 1/2 in
	 * docs/architecture/mcp-apps-ui-support.md). Re-validates everything the
	 * webview gate already checked; readResource/callTool additionally enforce
	 * connection + server-disabled state.
	 */
	async handleMcpAppRequest(request: McpAppRequest): Promise<McpAppResponsePayload> {
		try {
			const connection = this.findConnection(request.serverName, request.source)
			const uiDisabled = isMcpServerUiDisabled(connection?.server) || !(await this.isMcpAppsEnabled())

			const validation = validateMcpAppRequest(request, { uiDisabled })
			if (!validation.ok) {
				return { ok: false, error: { code: validation.code, message: validation.message } }
			}

			if (request.method === "resources/read") {
				const uri = String(request.params?.uri ?? "")
				const result = await this.readResource(request.serverName, uri, request.source)

				if (estimateResourceBytes(result) > MCP_APP_MAX_RESOURCE_BYTES) {
					return { ok: false, error: { code: -32001, message: "UI resource exceeds the 2MB size cap" } }
				}

				return { ok: true, result }
			}

			const result = await this.callTool(
				request.serverName,
				String(request.params?.name ?? ""),
				request.params?.arguments as Record<string, unknown> | undefined,
				request.source,
			)
			return { ok: true, result }
		} catch (error) {
			return {
				ok: false,
				error: { code: -32603, message: error instanceof Error ? error.message : String(error) },
			}
		}
	}
```

(Also add `MCP_APP_MAX_RESOURCE_BYTES` to the `./mcp-app-bridge` import.)

In [`webviewMessageHandler.ts`](../../../src/core/webview/webviewMessageHandler.ts:1834), next to `refreshAllMcpServers`:

```typescript
		case "mcpAppRequest": {
			const mcpHub = provider.getMcpHub()

			if (mcpHub && message.requestId && message.serverName && message.mcpAppMethod) {
				const response = await mcpHub.handleMcpAppRequest({
					requestId: message.requestId,
					serverName: message.serverName,
					source: message.source as "global" | "project" | undefined,
					method: message.mcpAppMethod,
					params: message.mcpAppParams,
				})

				await provider.postMessageToWebview({
					type: "mcpAppResponse",
					requestId: message.requestId,
					mcpAppResponse: response,
				})
			}

			break
		}
```

- [ ] **Step 7: Run all affected tests to verify they pass**

Run: `cd src && npx vitest run services/mcp/__tests__/mcp-app-bridge.spec.ts services/mcp/__tests__/McpHub.spec.ts core/webview/__tests__/webviewMessageHandler.spec.ts`
Expected: PASS (new + existing).

- [ ] **Step 8: Lint + commit**

Run: `pnpm --dir src exec eslint --prune-suppressions --max-warnings=0 services/mcp/mcp-app-bridge.ts services/mcp/McpHub.ts core/webview/webviewMessageHandler.ts` — Expected: exit 0, counts unchanged (new files must contribute zero).

```bash
git add packages/types/src/vscode-extension-host.ts src/services/mcp/mcp-app-bridge.ts src/services/mcp/__tests__/mcp-app-bridge.spec.ts src/services/mcp/McpHub.ts src/services/mcp/__tests__/McpHub.spec.ts src/core/webview/webviewMessageHandler.ts src/core/webview/__tests__/webviewMessageHandler.spec.ts
git commit -m "feat(mcp-apps): host-side mcpAppRequest bridge with ui:// restriction and size cap"
```

---

### Task 7: Webview dependency install + correlated bridge client (`requestMcpApp`)

**Files:**
- Modify: `webview-ui/package.json` (via pnpm)
- Create: `webview-ui/src/services/mcp-app/useMcpAppBridge.ts`
- Test: `webview-ui/src/services/mcp-app/__tests__/useMcpAppBridge.spec.ts`

**Interfaces:**
- Consumes: message pair from Task 6 (`mcpAppRequest` fields `requestId`/`serverName`/`source`/`mcpAppMethod`/`mcpAppParams`; `mcpAppResponse` with `requestId` + `mcpAppResponse`).
- Produces: `type McpAppMethod = "resources/read" | "tools/call"`; `function requestMcpApp(args: { serverName: string; source?: "global" | "project"; method: McpAppMethod; params: Record<string, unknown>; timeoutMs?: number }): Promise<unknown>` — rejects with `Error(message)` on `{ ok: false }` responses and after `timeoutMs` (default 60_000). Also resolves the duplicate-SDK-bundling risk decision for Task 9.

- [ ] **Step 1: Install ext-apps and audit SDK copies**

Run: `pnpm --dir webview-ui add "@modelcontextprotocol/ext-apps@^1.7.5"`
Expected: install succeeds; `webview-ui/package.json` dependencies gain `"@modelcontextprotocol/ext-apps": "^1.7.5"`.

Run: `pnpm --dir webview-ui why @modelcontextprotocol/sdk`
**Decision criteria (record the output in the commit body):** exactly one SDK version (1.29.0) reachable from ext-apps' peer → proceed. If pnpm nested a second SDK copy at a different version, add to root [`package.json`](../../../package.json:62) `pnpm.overrides`: `"@modelcontextprotocol/sdk": "1.29.0"` and re-run install + this check until one version remains. Do NOT add `@mcp-ui/client` in this task under any circumstances (architecture decision c: raw AppBridge preferred).

- [ ] **Step 2: Write the failing bridge-client tests**

Create `webview-ui/src/services/mcp-app/__tests__/useMcpAppBridge.spec.ts` (message-bus mocking pattern from [`useThemeFixtureProbe.test.ts`](../../../webview-ui/src/utils/__tests__/useThemeFixtureProbe.test.ts)):

```typescript
import { requestMcpApp } from "../useMcpAppBridge"
import { vscode } from "@src/utils/vscode"

vi.mock("@src/utils/vscode", () => ({ vscode: { postMessage: vi.fn() } }))

function respondTo(requestId: string, payload: unknown) {
	const posted = (vscode.postMessage as Mock).mock.calls.at(-1)?.[0]
	window.dispatchEvent(
		new MessageEvent("message", { data: { type: "mcpAppResponse", requestId, mcpAppResponse: payload } }),
	)
	void posted
}

describe("requestMcpApp", () => {
	beforeEach(() => vi.clearAllMocks())

	it("posts an mcpAppRequest with a unique requestId and resolves the correlated result", async () => {
		const promise = requestMcpApp({ serverName: "srv", method: "resources/read", params: { uri: "ui://a/b" } })

		const posted = (vscode.postMessage as Mock).mock.calls[0][0]
		expect(posted).toMatchObject({
			type: "mcpAppRequest",
			serverName: "srv",
			mcpAppMethod: "resources/read",
			mcpAppParams: { uri: "ui://a/b" },
		})
		expect(typeof posted.requestId).toBe("string")

		respondTo(posted.requestId, { ok: true, result: { contents: [] } })

		await expect(promise).resolves.toEqual({ contents: [] })
	})

	it("rejects with the host error message on ok:false", async () => {
		const promise = requestMcpApp({ serverName: "srv", method: "tools/call", params: { name: "t" } })
		const posted = (vscode.postMessage as Mock).mock.calls[0][0]

		respondTo(posted.requestId, { ok: false, error: { code: -32601, message: "Method not allowed" } })

		await expect(promise).rejects.toThrow("Method not allowed")
	})

	it("ignores responses for other requestIds and rejects on timeout", async () => {
		vi.useFakeTimers()
		const promise = requestMcpApp({ serverName: "srv", method: "tools/call", params: { name: "t" }, timeoutMs: 100 })
		const posted = (vscode.postMessage as Mock).mock.calls[0][0]

		window.dispatchEvent(
			new MessageEvent("message", {
				data: { type: "mcpAppResponse", requestId: "someone-else", mcpAppResponse: { ok: true, result: 1 } },
			}),
		)

		vi.advanceTimersByTime(101)
		await expect(promise).rejects.toThrow(/timed out/i)
		void posted
		vi.useRealTimers()
	})
})
```

Run: `cd webview-ui && npx vitest run src/services/mcp-app/__tests__/useMcpAppBridge.spec.ts`
Expected: FAIL — cannot resolve `../useMcpAppBridge`.

- [ ] **Step 3: Implement the bridge client**

Create `webview-ui/src/services/mcp-app/useMcpAppBridge.ts`:

```typescript
import type { ExtensionMessage } from "@roo/ExtensionMessage"

import { vscode } from "@src/utils/vscode"

export type McpAppMethod = "resources/read" | "tools/call"

type PendingEntry = { resolve: (value: unknown) => void; reject: (reason: Error) => void; timer: ReturnType<typeof setTimeout> }

const pending = new Map<string, PendingEntry>()
let listenerInstalled = false

function onResponseMessage(event: MessageEvent<ExtensionMessage>) {
	const message = event.data
	if (message?.type !== "mcpAppResponse" || !message.requestId) {
		return
	}

	const entry = pending.get(message.requestId)
	if (!entry) {
		return
	}

	pending.delete(message.requestId)
	clearTimeout(entry.timer)

	const payload = message.mcpAppResponse
	if (payload?.ok) {
		entry.resolve(payload.result)
	} else {
		entry.reject(new Error(payload?.error?.message ?? "MCP App request failed"))
	}
}

/**
 * Fire a proxied MCP Apps request at the extension host and await the
 * correlated response. Correlation follows the requestId precedent used by
 * themeFixtureProbe (src/core/webview/ClineProvider.ts).
 */
export function requestMcpApp(args: {
	serverName: string
	source?: "global" | "project"
	method: McpAppMethod
	params: Record<string, unknown>
	timeoutMs?: number
}): Promise<unknown> {
	if (!listenerInstalled) {
		window.addEventListener("message", onResponseMessage)
		listenerInstalled = true
	}

	const requestId = crypto.randomUUID()

	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			pending.delete(requestId)
			reject(new Error(`MCP App ${args.method} request timed out after ${args.timeoutMs ?? 60_000}ms`))
		}, args.timeoutMs ?? 60_000)

		pending.set(requestId, { resolve, reject, timer })

		vscode.postMessage({
			type: "mcpAppRequest",
			requestId,
			serverName: args.serverName,
			source: args.source,
			mcpAppMethod: args.method,
			mcpAppParams: args.params,
		})
	})
}
```

(If `@roo/ExtensionMessage` is not an existing alias, import `ExtensionMessage` from `@roo-code/types` — check how [`McpExecution.tsx`](../../../webview-ui/src/components/chat/McpExecution.tsx:136) imports it and copy that import.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd webview-ui && npx vitest run src/services/mcp-app/__tests__/useMcpAppBridge.spec.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add webview-ui/package.json pnpm-lock.yaml webview-ui/src/services/mcp-app/useMcpAppBridge.ts webview-ui/src/services/mcp-app/__tests__/useMcpAppBridge.spec.ts
git commit -m "feat(mcp-apps): ext-apps 1.7.5 dep and requestId-correlated bridge client"
```

---

### Task 8: Sandbox-proxy document + URI injection

**Files:**
- Create: `src/assets/mcp-app-sandbox-proxy.html`
- Modify: `src/esbuild.mjs` (`copyPaths` list, lines 72–84)
- Modify: `src/.vscodeignore` (asset allow-list, ~line 30)
- Modify: `src/core/webview/ClineProvider.ts` (both templates' `window.*_URI` script blocks: dev ~lines 1612–1616, prod ~lines 1691–1695; URI computation near each method's other `getUri` calls)
- Test: `src/core/webview/__tests__/ClineProvider.spec.ts`

**Interfaces:**
- Consumes: `frame-src ${webview.cspSource}` from Task 1 (the proxy loads as a `vscode-webview://` URL covered by it); Task 1 spike decision for relay mechanics.
- Produces: bundled file at extension-relative path `assets/mcp-app-sandbox-proxy.html`; webview global `window.MCP_APP_SANDBOX_PROXY_URI: string`. Proxy postMessage protocol (used by Task 9): webview→proxy `{ jsonrpc: "2.0", ... }` and control messages `{ type: "mcp-app-set-html", html: string }`; proxy→webview any message received from the inner frame, verbatim.

- [ ] **Step 1: Write the failing injection test**

Append to `describe("ClineProvider", ...)` in `src/core/webview/__tests__/ClineProvider.spec.ts` (same resolveWebviewView pattern as Task 1's test):

```typescript
		test("injects the sandbox proxy URI into the production webview HTML", async () => {
			await provider.resolveWebviewView(mockWebviewView)

			const html: string = (mockWebviewView.webview as any).html ?? mockWebviewView.webview.setHtml.mock?.calls?.[0]?.[0]

			expect(String(html)).toContain("window.MCP_APP_SANDBOX_PROXY_URI =")
			expect(String(html)).toContain("mcp-app-sandbox-proxy.html")
		})
```

Run: `cd src && npx vitest run core/webview/__tests__/ClineProvider.spec.ts -t "sandbox proxy URI"` — Expected: FAIL (string not found).

- [ ] **Step 2: Create the proxy document**

Create `src/assets/mcp-app-sandbox-proxy.html`:

```html
<!DOCTYPE html>
<html lang="en">
	<head>
		<meta charset="utf-8" />
		<!--
			Sandbox proxy for MCP Apps (docs/architecture/mcp-apps-ui-support.md, decision a).
			This document is trusted and bundled; the APP HTML it hosts is hostile.
			Its own meta-CSP governs the inner srcdoc frame (srcdoc inherits the
			embedding document's policy), so app inline scripts run while the
			top-level webview CSP stays untouched apart from frame-src.
		-->
		<meta
			http-equiv="Content-Security-Policy"
			content="default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; style-src 'unsafe-inline'; img-src data: blob: https:; font-src data:; connect-src *; frame-src 'self';" />
	</head>
	<body>
		<script>
			"use strict"
			let inner = null

			function mountApp(html) {
				if (inner) {
					inner.remove()
				}
				// Opaque origin: no allow-same-origin -> no access to webview DOM,
				// vscode API, or extension state.
				inner = document.createElement("iframe")
				inner.setAttribute("sandbox", "allow-scripts allow-forms allow-popups")
				inner.style.border = "0"
				inner.style.width = "100%"
				inner.style.height = "100%"
				inner.srcdoc = html
				document.body.appendChild(inner)
			}

			window.addEventListener("message", (event) => {
				const data = event.data
				if (data && data.type === "mcp-app-set-html" && typeof data.html === "string") {
					mountApp(data.html)
					return
				}
				// JSON-RPC from the webview bridge -> forward into the app frame.
				if (inner && inner.contentWindow) {
					inner.contentWindow.postMessage(data, "*")
				}
			})

			// Anything from the app frame -> relay verbatim to the embedding webview.
			window.addEventListener("message", (event) => {
				if (event.source === window.parent) {
					const data = event.data
					if (data && data.type !== "mcp-app-set-html") {
						window.parent.postMessage(data, "*")
					}
				}
			})

			window.parent.postMessage({ type: "mcp-app-sandbox-proxy-ready" }, "*")
		</script>
	</body>
</html>
```

(If Task 1's spike recorded the MessageChannel fallback, adapt the two relay listeners accordingly — that note is in `docs/superpowers/plans/spike-results-mcp-apps.md`.)

- [ ] **Step 3: Bundle + package the asset**

In [`src/esbuild.mjs`](../../../src/esbuild.mjs:72), add to the `copyPaths` array (mirroring the marketplace entry):

```javascript
							["assets/mcp-app-sandbox-proxy.html", "dist/assets/mcp-app-sandbox-proxy.html"],
```

In [`src/.vscodeignore`](../../../src/.vscodeignore:30), after `!assets/codicons/**`:

```
!assets/mcp-app-sandbox-proxy.html
```

- [ ] **Step 4: Inject the URI into both templates**

In [`getHtmlContent`](../../../src/core/webview/ClineProvider.ts:1639), next to the other `getUri(...)` calls (~line 1658):

```typescript
		const mcpAppSandboxProxyUri = getUri(webview, this.contextProxy.extensionUri, [
			"assets",
			"mcp-app-sandbox-proxy.html",
		])
```

and inside the prod template's nonce script block (lines 1691–1695) after `window.MATERIAL_ICONS_BASE_URI = ...`:

```typescript
				window.MCP_APP_SANDBOX_PROXY_URI = "${mcpAppSandboxProxyUri}"
```

In [`getDevHtmlContent`](../../../src/core/webview/ClineProvider.ts:1603), add the same computation using that method's existing `getUri`-equivalent helper (the dev template already resolves `imagesUri` etc. at its top — copy that exact call shape with segments `["assets", "mcp-app-sandbox-proxy.html"]`) and add the same `window.MCP_APP_SANDBOX_PROXY_URI = "${mcpAppSandboxProxyUri}"` line to its script block (lines 1612–1616).

- [ ] **Step 5: Run tests + bundle check**

Run: `cd src && npx vitest run core/webview/__tests__/ClineProvider.spec.ts -t "sandbox proxy URI"` — Expected: PASS.
Run: `pnpm --dir src run bundle` (script name per [`src/package.json`](../../../src/package.json) scripts; if it is `build`, use that) then confirm the file exists at `src/dist/assets/mcp-app-sandbox-proxy.html`.

- [ ] **Step 6: Lint + commit**

Run: `pnpm --dir src exec eslint --prune-suppressions --max-warnings=0 core/webview/ClineProvider.ts esbuild.mjs` — Expected: exit 0, counts unchanged.

```bash
git add src/assets/mcp-app-sandbox-proxy.html src/esbuild.mjs src/.vscodeignore src/core/webview/ClineProvider.ts src/core/webview/__tests__/ClineProvider.spec.ts
git commit -m "feat(mcp-apps): bundled sandbox proxy document with webview URI injection"
```

---

### Task 9: `McpAppFrame` renderer + AppBridge session + ChatRow mount

**Files:**
- Create: `webview-ui/src/components/chat/mcpAppBridgeSession.ts`
- Create: `webview-ui/src/components/chat/McpAppFrame.tsx`
- Modify: `webview-ui/src/components/chat/ChatRow.tsx` (`use_mcp_tool` branch, lines 1666–1677)
- Test: `webview-ui/src/components/chat/__tests__/McpAppFrame.spec.tsx`

**Interfaces:**
- Consumes: `getMcpToolUiResourceUri`, `isMcpServerUiDisabled` (Task 2); `mcpAppsEnabled` context value (Task 3); `requestMcpApp` (Task 7); `window.MCP_APP_SANDBOX_PROXY_URI` (Task 8).
- Produces: `<McpAppFrame serverName toolName toolMeta resultMeta argumentsJson responseText alwaysAllow alwaysAllowMcp />`; `createMcpAppBridgeSession(opts)` returning `{ start(iframeWindow: Window): void; dispose(): void }` where the session wires `@modelcontextprotocol/ext-apps/app-bridge`'s `AppBridge(null, hostInfo, capabilities)` manual handlers (`onreadresource`, `oncalltool`) onto `requestMcpApp`.

- [ ] **Step 1: Verify the installed ext-apps API surface (gate before coding)**

Run: `pnpm --dir webview-ui exec node -e "const p=require.resolve('@modelcontextprotocol/ext-apps/package.json'); console.log(p)"`
Then open the printed package's `dist/app-bridge.d.ts` (or the path its `exports["./app-bridge"]` maps to) and confirm: constructor `(client | null, hostInfo, capabilities, options?)`, manual handler registration names (`oncalltool` / `onreadresource` or their documented equivalents), and the exact `McpUiHostCapabilities` field set (architecture risk item — record which of `openLinks`, `serverTools`, `logging` exist). **Decision criteria:** if the d.ts matches the architecture doc's description, implement Step 3 as written with the confirmed names. If handler names differ, use the d.ts names and note them in the commit message. If `AppBridge(null)` cannot serve manual handlers at all, STOP and escalate — fallback is a hand-rolled JSON-RPC relay over the proxy protocol from Task 8 (same file layout; only `mcpAppBridgeSession.ts` internals change).

- [ ] **Step 2: Write the failing component tests**

Create `webview-ui/src/components/chat/__tests__/McpAppFrame.spec.tsx`:

```tsx
import { render, screen, waitFor } from "@testing-library/react"

import McpAppFrame from "../McpAppFrame"
import { requestMcpApp } from "@src/services/mcp-app/useMcpAppBridge"

vi.mock("@src/services/mcp-app/useMcpAppBridge", () => ({ requestMcpApp: vi.fn() }))

const state = { mcpAppsEnabled: true }
vi.mock("@src/context/ExtensionStateContext", () => ({
	useExtensionState: () => state,
}))

vi.mock("../mcpAppBridgeSession", () => ({
	createMcpAppBridgeSession: vi.fn(() => ({ start: vi.fn(), dispose: vi.fn() })),
}))

// t(key, defaultValue | { defaultValue, ...vars }) -> interpolated default.
vi.mock("react-i18next", () => ({
	useTranslation: () => ({
		t: (key: string, options?: unknown) => {
			if (typeof options === "string") {
				return options
			}
			const opts = (options ?? {}) as Record<string, unknown>
			const template = typeof opts.defaultValue === "string" ? opts.defaultValue : key
			return Object.entries(opts)
				.filter(([k]) => k !== "defaultValue")
				.reduce((acc: string, [k, v]) => acc.replace(new RegExp(`{{${k}}}`, "g"), String(v)), template)
		},
	}),
}))

const baseProps = {
	serverName: "demo",
	source: "global" as const,
	toolName: "card",
	toolMeta: { ui: { resourceUri: "ui://demo/card" } },
	resultMeta: undefined,
	argumentsJson: "{}",
	responseText: "",
	alwaysAllow: false,
	alwaysAllowMcp: false,
}

describe("McpAppFrame", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		state.mcpAppsEnabled = true
		;(window as unknown as { MCP_APP_SANDBOX_PROXY_URI?: string }).MCP_APP_SANDBOX_PROXY_URI =
			"vscode-webview://test-csp/assets/mcp-app-sandbox-proxy.html"
		;(requestMcpApp as Mock).mockResolvedValue({
			contents: [{ uri: "ui://demo/card", mimeType: "text/html;profile=mcp-app", text: "<html><body>ok</body></html>" }],
		})
	})

	it("renders nothing when the feature flag is off", () => {
		state.mcpAppsEnabled = false
		const { container } = render(<McpAppFrame {...baseProps} />)
		expect(container.innerHTML).toBe("")
		expect(requestMcpApp).not.toHaveBeenCalled()
	})

	it("renders nothing when the tool declares no UI resource", () => {
		const { container } = render(<McpAppFrame {...baseProps} toolMeta={undefined} />)
		expect(container.innerHTML).toBe("")
	})

	it("fetches the ui:// resource through the bridge and mounts the sandbox proxy iframe", async () => {
		const { container } = render(<McpAppFrame {...baseProps} />)

		await waitFor(() => expect(requestMcpApp).toHaveBeenCalledTimes(1))
		expect(requestMcpApp).toHaveBeenCalledWith({
			serverName: "demo",
			source: "global",
			method: "resources/read",
			params: { uri: "ui://demo/card" },
		})

		const iframe = container.querySelector("iframe")
		expect(iframe).not.toBeNull()
		expect(iframe!.getAttribute("sandbox")).toBe("allow-scripts allow-forms allow-popups")
		expect((iframe! as HTMLIFrameElement).src).toContain("mcp-app-sandbox-proxy.html")
	})

	it("prefers a result-level _meta UI override over the tool declaration", async () => {
		render(
			<McpAppFrame {...baseProps} resultMeta={{ ui: { resourceUri: "ui://demo/result-card" } }} />,
		)

		await waitFor(() => expect(requestMcpApp).toHaveBeenCalledTimes(1))
		expect(requestMcpApp).toHaveBeenCalledWith(expect.objectContaining({ params: { uri: "ui://demo/result-card" } }))
	})

	it("shows an error state when the fetch fails", async () => {
		;(requestMcpApp as Mock).mockRejectedValue(new Error("server offline"))
		render(<McpAppFrame {...baseProps} />)

		await waitFor(() => expect(screen.getByText(/mcp app ui unavailable/i)).toBeInTheDocument())
		expect(screen.getByText(/server offline/)).toBeInTheDocument()
	})
})
```

Run: `cd webview-ui && npx vitest run src/components/chat/__tests__/McpAppFrame.spec.tsx`
Expected: FAIL — cannot resolve `../McpAppFrame`.

- [ ] **Step 3: Implement the session module and component**

Create `webview-ui/src/components/chat/mcpAppBridgeSession.ts` (constructor/handler names per Step 1's verified d.ts; the shape below reflects the architecture doc's description of ext-apps 1.7.5):

```typescript
import { AppBridge } from "@modelcontextprotocol/ext-apps/app-bridge"

import { requestMcpApp, type McpAppMethod } from "@src/services/mcp-app/useMcpAppBridge"

export type McpAppBridgeSession = { start: (iframeWindow: Window) => void; dispose: () => void }

/**
 * Host-side bridge session for one mounted app frame. AppBridge runs in
 * null-client mode (the real MCP Client lives in the extension host); every
 * proxied request is forwarded over the mcpAppRequest message pair (Task 6).
 */
export function createMcpAppBridgeSession(opts: {
	serverName: string
	source?: "global" | "project"
	onToolCall?: (toolName: string, args: Record<string, unknown>) => Promise<boolean> // approval gate; false = deny
}): McpAppBridgeSession {
	const proxy = async (method: McpAppMethod, params: Record<string, unknown>) =>
		requestMcpApp({ serverName: opts.serverName, source: opts.source, method, params })

	const bridge = new AppBridge(null, { name: "Zoo Code", version: "1.0.0" }, { openLinks: {} }, {})

	bridge.onreadresource(async (params: { uri: string }) => proxy("resources/read", { uri: params.uri }))

	bridge.oncalltool(async (params: { name: string; arguments?: Record<string, unknown> }) => {
		if (opts.onToolCall && !(await opts.onToolCall(params.name, params.arguments ?? {}))) {
			throw new Error("User denied the tool call")
		}
		return proxy("tools/call", { name: params.name, arguments: params.arguments ?? {} })
	})

	return {
		start: (iframeWindow) => bridge.start(iframeWindow as never),
		dispose: () => bridge.close?.(),
	}
}
```

Create `webview-ui/src/components/chat/McpAppFrame.tsx`:

```tsx
import { useCallback, useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"

import { getMcpToolUiResourceUri, isMcpServerUiDisabled, type McpServer } from "@roo-code/types"

import { useExtensionState } from "@src/context/ExtensionStateContext"
import { requestMcpApp } from "@src/services/mcp-app/useMcpAppBridge"

import { createMcpAppBridgeSession } from "./mcpAppBridgeSession"

interface McpAppFrameProps {
	serverName: string
	source?: "global" | "project"
	toolName: string
	toolMeta?: Record<string, unknown>
	resultMeta?: Record<string, unknown>
	argumentsJson?: string
	responseText?: string
	alwaysAllow?: boolean
	alwaysAllowMcp?: boolean
	server?: McpServer
}

function getSandboxProxyUri(): string {
	return (window as unknown as { MCP_APP_SANDBOX_PROXY_URI?: string }).MCP_APP_SANDBOX_PROXY_URI ?? ""
}

export const McpAppFrame = ({
	serverName,
	source,
	toolName,
	toolMeta,
	resultMeta,
	argumentsJson,
	responseText,
	alwaysAllow,
	alwaysAllowMcp,
	server,
}: McpAppFrameProps) => {
	const { mcpAppsEnabled } = useExtensionState()
	const { t } = useTranslation()
	const iframeRef = useRef<HTMLIFrameElement>(null)
	const [html, setHtml] = useState<string | null>(null)
	const [error, setError] = useState<string | null>(null)
	const [height, setHeight] = useState(240)

	// Result-level _meta override first (architecture risk item), then the tool declaration.
	const uiUri = getMcpToolUiResourceUri(resultMeta) ?? getMcpToolUiResourceUri(toolMeta)
	const enabled = mcpAppsEnabled && !!uiUri && !isMcpServerUiDisabled(server ?? { config: undefined })

	useEffect(() => {
		if (!enabled || !uiUri) {
			return
		}

		let cancelled = false
		requestMcpApp({ serverName, source, method: "resources/read", params: { uri: uiUri } })
			.then((result) => {
				const contents = (result as { contents?: Array<{ text?: string; blob?: string }> }).contents ?? []
				const first = contents[0]
				const appHtml =
					first?.text ?? (first?.blob ? new TextDecoder().decode(Buffer.from(first.blob, "base64")) : null)
				if (!appHtml) {
					throw new Error("UI resource contained no HTML")
				}
				if (!cancelled) {
					setHtml(appHtml)
				}
			})
			.catch((err: unknown) => {
				if (!cancelled) {
					setError(err instanceof Error ? err.message : String(err))
				}
			})

		return () => {
			cancelled = true
		}
	}, [enabled, uiUri, serverName, source])

	const disposeRef = useRef<{ dispose: () => void } | null>(null)

	useEffect(() => {
		return () => {
			disposeRef.current?.dispose()
			disposeRef.current = null
		}
	}, [])

	const onIframeLoad = useCallback(() => {
		const frameWindow = iframeRef.current?.contentWindow
		if (!frameWindow || !html) {
			return
		}

		frameWindow.postMessage({ type: "mcp-app-set-html", html }, "*")

		disposeRef.current?.dispose()
		const session = createMcpAppBridgeSession({ serverName, source })
		disposeRef.current = session
		session.start(frameWindow)
	}, [html, serverName, source])

	useEffect(() => {
		const onMessage = (event: MessageEvent) => {
			const data = event.data as { type?: string; height?: number } | undefined
			if (data?.type === "ui/notifications/size-changed" && typeof data.height === "number") {
				setHeight(Math.min(Math.max(data.height, 40), 2000))
			}
		}
		window.addEventListener("message", onMessage)
		return () => window.removeEventListener("message", onMessage)
	}, [])

	if (!enabled) {
		return null
	}

	if (error) {
		return (
			<div className="mt-2 text-xs text-vscode-errorForeground">
				{t("mcp:appFrame.error", "MCP App UI unavailable")}: {error}
			</div>
		)
	}

	if (!html) {
		return <div className="mt-2 text-xs text-vscode-descriptionForeground">{t("mcp:appFrame.loading", "Loading UI…")}</div>
	}

	return (
		<iframe
			ref={iframeRef}
			title={`MCP App: ${serverName}/${toolName}`}
			src={getSandboxProxyUri()}
			sandbox="allow-scripts allow-forms allow-popups"
			style={{ height }}
			className="w-full border border-vscode-border rounded-xs mt-2 bg-vscode-editor-background"
			onLoad={onIframeLoad}
		/>
	)
}

export default McpAppFrame
```

(`Buffer` is available in the webview via Vite's node polyfill config used elsewhere; if `npx tsc --noEmit` flags it, replace with `atob`-based decoding: `new TextDecoder().decode(Uint8Array.from(atob(first.blob), (c) => c.charCodeAt(0)))`. The `argumentsJson`/`responseText`/approval props are consumed in Task 10; keep them on the interface now so ChatRow's call site is final.)

- [ ] **Step 4: Mount in ChatRow**

In [`ChatRow.tsx`](../../../webview-ui/src/components/chat/ChatRow.tsx:1666), inside the `useMcpServer.type === "use_mcp_tool"` fragment (after `<McpExecution ... />`, still inside the same wrapper div), add — and pull `mcpAppsEnabled` into this component from its existing `useExtensionState()` destructure (same place it already reads `mcpServers`/`alwaysAllowMcp`):

```tsx
									<McpAppFrame
										serverName={useMcpServer.serverName}
										source={server?.source ?? "global"}
										toolName={useMcpServer.toolName ?? ""}
										toolMeta={server?.tools?.find((tool) => tool.name === useMcpServer.toolName)?._meta}
										resultMeta={undefined}
										argumentsJson={useMcpServer.arguments}
										responseText={useMcpServer.response}
										alwaysAllow={server?.tools?.find((tool) => tool.name === useMcpServer.toolName)?.alwaysAllow}
										alwaysAllowMcp={alwaysAllowMcp}
										server={server}
									/>
```

Add the import: `import McpAppFrame from "./McpAppFrame"`. (Result-level `_meta` plumbing: `mcpExecutionStatus` responses carry text only today; wiring result `_meta` end-to-end is explicitly out of scope for v1 — the extractor already accepts it, and `resultMeta` stays `undefined` until a follow-up extends `UseMcpToolTool`'s status payload. Recorded here so reviewers do not flag an omission.)

- [ ] **Step 5: Run component tests + type check**

Run: `cd webview-ui && npx vitest run src/components/chat/__tests__/McpAppFrame.spec.tsx`
Expected: PASS (5 tests).
Run: `cd webview-ui && npx tsc --noEmit` — Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add webview-ui/src/components/chat/mcpAppBridgeSession.ts webview-ui/src/components/chat/McpAppFrame.tsx webview-ui/src/components/chat/ChatRow.tsx webview-ui/src/components/chat/__tests__/McpAppFrame.spec.tsx
git commit -m "feat(mcp-apps): McpAppFrame sandbox renderer mounted in chat rows"
```

---

### Task 10: UI-initiated tool-call approval gate + link/message safety

**Files:**
- Modify: `webview-ui/src/components/chat/McpAppFrame.tsx` (approval banner; wire `onToolCall` into `createMcpAppBridgeSession`)
- Modify: `webview-ui/src/components/chat/mcpAppBridgeSession.ts` (forward `ui/open-link` and `ui/message` bridge events)
- Modify: `webview-ui/src/i18n/locales/en/mcp.json` (`appFrame.*`, `approval.*`)
- Test: extend `webview-ui/src/components/chat/__tests__/McpAppFrame.spec.tsx`

**Interfaces:**
- Consumes: `alwaysAllow` / `alwaysAllowMcp` props (Task 9), same semantics as [`isMcpToolAlwaysAllowed`](../../../src/core/auto-approval/mcp.ts:3); `vscode.postMessage` for `openExternal` and `insertTextIntoTextarea`.
- Produces: `function isSafeAppUrl(raw: string): boolean` exported from `mcpAppBridgeSession.ts` (allowlist `https:`, `http:`, `mailto:`); approval promise flow `requestApproval(toolName, args): Promise<boolean>` internal to McpAppFrame; deny → the session's `oncalltool` throws `"User denied the tool call"` (already implemented in Task 9 — this task supplies the real gate).

- [ ] **Step 1: Write the failing tests**

Append to `McpAppFrame.spec.tsx`:

```tsx
describe("McpAppFrame approval gate", () => {
	it("asks for confirmation when the tool is not always-allowed and resolves on Allow", async () => {
		const { createMcpAppBridgeSession } = await import("../mcpAppBridgeSession")
		let capturedOnToolCall: ((name: string, args: Record<string, unknown>) => Promise<boolean>) | undefined
		;(createMcpAppBridgeSession as Mock).mockImplementation((opts) => {
			capturedOnToolCall = opts.onToolCall
			return { start: vi.fn(), dispose: vi.fn() }
		})

		const { getByRole, findByText, container } = render(<McpAppFrame {...baseProps} alwaysAllow={false} />)
		// jsdom never loads the iframe's src, so fire load() manually once the HTML has
		// been fetched and the iframe is mounted (onIframeLoad then creates the session).
		await waitFor(() => expect(container.querySelector("iframe")).not.toBeNull())
		fireEvent.load(container.querySelector("iframe")!)
		await waitFor(() => expect(createMcpAppBridgeSession).toHaveBeenCalled())

		const denyPromise = capturedOnToolCall!("dangerous", {})
		const prompt = await findByText(/run demo\/dangerous/i)
		expect(prompt).toBeInTheDocument()

		await userEvent.click(getByRole("button", { name: /deny/i }))
		await expect(denyPromise).resolves.toBe(false)
	})

	it("auto-approves when alwaysAllow is set on the tool", async () => {
		const { createMcpAppBridgeSession } = await import("../mcpAppBridgeSession")
		let capturedOnToolCall: ((name: string, args: Record<string, unknown>) => Promise<boolean>) | undefined
		;(createMcpAppBridgeSession as Mock).mockImplementation((opts) => {
			capturedOnToolCall = opts.onToolCall
			return { start: vi.fn(), dispose: vi.fn() }
		})

		const { container } = render(<McpAppFrame {...baseProps} alwaysAllow />)
		await waitFor(() => expect(container.querySelector("iframe")).not.toBeNull())
		fireEvent.load(container.querySelector("iframe")!)
		await waitFor(() => expect(createMcpAppBridgeSession).toHaveBeenCalled())

		await expect(capturedOnToolCall!("safe", {})).resolves.toBe(true)
	})
})

describe("isSafeAppUrl", () => {
	it("allows only https, http and mailto schemes", async () => {
		const { isSafeAppUrl } = await import("../mcpAppBridgeSession")
		expect(isSafeAppUrl("https://example.com")).toBe(true)
		expect(isSafeAppUrl("http://localhost:3000/x")).toBe(true)
		expect(isSafeAppUrl("mailto:someone@example.com")).toBe(true)
		expect(isSafeAppUrl("vscode://extension/command")).toBe(false)
		expect(isSafeAppUrl("javascript:alert(1)")).toBe(false)
		expect(isSafeAppUrl("not a url")).toBe(false)
	})
})
```

Add imports at the top of the spec: extend the existing `@testing-library/react` import with `fireEvent`, and add `import userEvent from "@testing-library/user-event"`. Also extend the mocked session module factory so `isSafeAppUrl` is real (add `vi.importActual` passthrough for it): keep `createMcpAppBridgeSession` mocked but re-export the rest via `{ ...(await vi.importActual("../mcpAppBridgeSession")), createMcpAppBridgeSession: vi.fn(...) }` inside the existing `vi.mock` factory.

Run: `cd webview-ui && npx vitest run src/components/chat/__tests__/McpAppFrame.spec.tsx -t "approval gate"` — Expected: FAIL (no confirm prompt rendered; `isSafeAppUrl` not exported).

- [ ] **Step 2: Implement the approval banner in McpAppFrame**

In `McpAppFrame.tsx`, add state and a gate callback, then pass it into the session created in `onIframeLoad`:

```tsx
	const [pendingApproval, setPendingApproval] = useState<{
		toolName: string
		resolve: (approved: boolean) => void
	} | null>(null)

	const requestApproval = useCallback(
		(toolName: string): Promise<boolean> => {
			if (alwaysAllow || alwaysAllowMcp) {
				return Promise.resolve(true)
			}
			return new Promise((resolve) => setPendingApproval({ toolName, resolve }))
		},
		[alwaysAllow, alwaysAllowMcp],
	)
```

In `onIframeLoad`, replace `createMcpAppBridgeSession({ serverName, source })` with:

```typescript
		const session = createMcpAppBridgeSession({
			serverName,
			source,
			onToolCall: async (name) => requestApproval(name),
		})
```

and add `requestApproval` to the callback's dependency array. Render the banner above the iframe when `pendingApproval` is set (Tailwind only):

```tsx
			{pendingApproval && (
				<div className="flex items-center justify-between gap-2 mt-2 p-2 border border-vscode-input-border rounded-xs bg-vscode-editor-background">
					<span className="text-xs text-vscode-foreground">
						{t("mcp:approval.runTool", {
							defaultValue: "Run {{server}}/{{tool}}?",
							server: serverName,
							tool: pendingApproval.toolName,
						})}
					</span>
					<div className="flex gap-2">
						<button
							className="text-xs px-2 py-1 rounded-xs bg-vscode-button-background text-vscode-button-foreground"
							onClick={() => {
								pendingApproval.resolve(true)
								setPendingApproval(null)
							}}>
							{t("mcp:approval.allow", "Allow")}
						</button>
						<button
							className="text-xs px-2 py-1 rounded-xs border border-vscode-button-border"
							onClick={() => {
								pendingApproval.resolve(false)
								setPendingApproval(null)
							}}>
							{t("mcp:approval.deny", "Deny")}
						</button>
					</div>
				</div>
			)}
```

- [ ] **Step 3: Implement link + message safety in the session**

In `mcpAppBridgeSession.ts`, add (and wire to the AppBridge events confirmed in Task 9 Step 1 — `openLinks` capability was already advertised there):

```typescript
import { vscode } from "@src/utils/vscode"

const SAFE_APP_URL_SCHEMES = new Set(["https:", "http:", "mailto:"])

export function isSafeAppUrl(raw: string): boolean {
	try {
		return SAFE_APP_URL_SCHEMES.has(new URL(raw).protocol)
	} catch {
		return false
	}
}
```

(Use whichever accessor the installed `URL` typings expose — `.protocol` in DOM lib; keep the Set membership check. The test in Step 1 pins behavior.) Inside `createMcpAppBridgeSession`, register the remaining bridge events per the verified d.ts: on open-link → `if (isSafeAppUrl(url)) vscode.postMessage({ type: "openExternal", url })` else drop silently and log; on `ui/message` → `vscode.postMessage({ type: "insertTextIntoTextarea", text })` (user-visible, user presses send — no silent injection, per architecture decision).

- [ ] **Step 4: Add i18n strings**

In `webview-ui/src/i18n/locales/en/mcp.json`, inside the top-level object:

```json
	"appFrame": {
		"loading": "Loading UI…",
		"error": "MCP App UI unavailable"
	},
	"approval": {
		"runTool": "Run {{server}}/{{tool}}?",
		"allow": "Allow",
		"deny": "Deny"
	},
```

- [ ] **Step 5: Run tests + type check**

Run: `cd webview-ui && npx vitest run src/components/chat/__tests__/McpAppFrame.spec.tsx`
Expected: PASS (all frame tests including approval gate + isSafeAppUrl).
Run: `cd webview-ui && npx tsc --noEmit` — Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add webview-ui/src/components/chat/McpAppFrame.tsx webview-ui/src/components/chat/mcpAppBridgeSession.ts webview-ui/src/components/chat/__tests__/McpAppFrame.spec.tsx webview-ui/src/i18n/locales/en/mcp.json
git commit -m "feat(mcp-apps): inline approval gate and scheme-allowlisted app links"
```

---

### Task 11: e2e smoke test (real extension host + fixture UI server)

**Files:**
- Create: `apps/vscode-e2e/src/suite/tools/fixtures/mcp-ui-server.ts`
- Create: `apps/vscode-e2e/src/fixtures/mcp-apps.ts`
- Create: `apps/vscode-e2e/src/suite/tools/mcp-apps.test.ts`

**Interfaces:**
- Consumes: everything above. The smoke asserts the cross-boundary path lower-level tests cannot prove: webview render gate → `mcpAppRequest` → `McpHub.handleMcpAppRequest` → real MCP server `resources/read`. It proves delivery by having the fixture server write a marker file when it serves the `ui://` read (same ready-file pattern as [`filesystem-mcp-server.ts`](../../../apps/vscode-e2e/src/suite/tools/fixtures/filesystem-mcp-server.ts:16)).
- Produces: nothing consumed later.

- [ ] **Step 1: Create the fixture UI MCP server**

Create `apps/vscode-e2e/src/suite/tools/fixtures/mcp-ui-server.ts`, modeled line-for-line on [`filesystem-mcp-server.ts`](../../../apps/vscode-e2e/src/suite/tools/fixtures/filesystem-mcp-server.ts) (same stdio JSON-RPC framing), with these differences:

```typescript
// tools/list response:
sendResult(message.id, {
	tools: [
		{
			name: "card",
			description: "Renders a demo UI card",
			inputSchema: { type: "object", properties: {} },
			_meta: { ui: { resourceUri: "ui://demo/card" } },
		},
	],
})

// resources/read handler (add case): on any read of "ui://demo/card",
// write the marker file, then respond with the app HTML.
case "resources/read":
	await fs.writeFile(readyFile + ".ui-read", "ok")
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

// tools/call handler for "card": sendResult(message.id, { content: [{ type: "text", text: "card ok" }] })
```

Keep `MCP_TEST_READY_FILE` semantics (touch ready file on `tools/list`) exactly like the filesystem fixture.

- [ ] **Step 2: Create aimock fixtures**

Create `apps/vscode-e2e/src/fixtures/mcp-apps.ts`:

```typescript
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
		match: { predicate: (req) => JSON.stringify(req).includes("call_mcp_apps_card_001") },
		response: { toolCalls: [{ name: "attempt_completion", arguments: JSON.stringify({ result: "Card rendered." }), id: "call_mcp_apps_done_002" }] },
	})
}
```

Register it where `addUseMcpToolResultFixtures` is registered: run `pnpm --dir apps/vscode-e2e exec node -e "const {execSync}=require('child_process');console.log(execSync('grep -rn addUseMcpToolResultFixtures src',{encoding:'utf8'}))"` (or use VS Code search) and add the parallel `addMcpAppsFixtures(mock)` call in that same setup file.

- [ ] **Step 3: Write the smoke test**

Create `apps/vscode-e2e/src/suite/tools/mcp-apps.test.ts`, following [`use-mcp-tool.test.ts`](../../../apps/vscode-e2e/src/suite/tools/use-mcp-tool.test.ts) structure (workspace `.roo/mcp.json` write, ready-file wait, task run):

```typescript
import * as assert from "assert"
import * as fs from "fs/promises"
import * as path from "path"

import { waitFor } from "../utils"
import { setDefaultSuiteTimeout } from "../test-utils"

const UI_SERVER_NAME = "uicard"
const TEST_CONFIG_RELATIVE_PATH = ".roo/mcp.json"
const READY_RELATIVE_PATH = "mcp-apps-fixture/server-ready"
const UI_READ_RELATIVE_PATH = "mcp-apps-fixture/server-ready.ui-read"

suite("Roo Code MCP Apps smoke", function () {
	setDefaultSuiteTimeout(this)

	test("webview fetches the ui:// resource through the host bridge when mcpAppsEnabled is on", async () => {
		const api = globalThis.api
		const workspaceDir = (await import("../utils")).getWorkspaceDir?.() ?? process.env.E2E_WORKSPACE_DIR!
		const rooDir = path.join(workspaceDir, ".roo")
		const fixtureDir = path.join(workspaceDir, "mcp-apps-fixture")

		await fs.mkdir(rooDir, { recursive: true })
		await fs.mkdir(fixtureDir, { recursive: true })
		await fs.writeFile(
			path.join(workspaceDir, TEST_CONFIG_RELATIVE_PATH),
			JSON.stringify(
				{
					mcpServers: {
						[UI_SERVER_NAME]: {
							command: process.env.npm_node_execpath ?? "node",
							args: [path.join(__dirname, "fixtures", "mcp-ui-server.js"), fixtureDir],
							env: { MCP_TEST_READY_FILE: path.join(workspaceDir, READY_RELATIVE_PATH) },
							alwaysAllow: ["card"],
						},
					},
				},
				null,
				2,
			),
		)

		await api.setConfiguration({ mcpAppsEnabled: true })

		await waitFor(async () => { try { await fs.access(path.join(workspaceDir, READY_RELATIVE_PATH)); return true } catch { return false } }, { timeout: 30_000 })

		await api.startNewTask({
			configuration: { mode: "ask", alwaysAllowModeSwitch: true, autoApprovalEnabled: true },
			text: "MCP_APPS_SMOKE: Call the uicard MCP card tool exactly once.",
		})

		// The marker proves the full cross-boundary path: ChatRow gate -> mcpAppRequest ->
		// McpHub.handleMcpAppRequest -> real server resources/read. (Webview must be alive;
		// suite/index.ts focuses the sidebar before tests run.)
		await waitFor(async () => { try { await fs.access(path.join(workspaceDir, UI_READ_RELATIVE_PATH)); return true } catch { return false } }, { timeout: 30_000 })

		const markerContents = await fs.readFile(path.join(workspaceDir, UI_READ_RELATIVE_PATH), "utf8")
		assert.strictEqual(markerContents, "ok")
	})
})
```

Resolve the workspace-dir accessor by copying exactly how [`use-mcp-tool.test.ts`](../../../apps/vscode-e2e/src/suite/tools/use-mcp-tool.test.ts:53) obtains `workspaceDir` in its `suiteSetup` (it uses a suite-level variable set from the harness — replicate that mechanism instead of the env-var fallback above if it differs).

- [ ] **Step 4: Run the smoke test**

Run: `pnpm --dir apps/vscode-e2e run test:ci:mock` with the e2e runner filtered to this suite (the harness honors `TEST_GREP` per [`suite/index.ts`](../../../apps/vscode-e2e/src/suite/index.ts:60)): set `TEST_GREP="MCP Apps smoke"` for the run.
Expected: PASS. If the marker never appears, check in order: (1) webview alive (`suite/index.ts` focuses sidebar), (2) `mcpAppsEnabled` reached state (log from `getStateToPostToWebview`), (3) capability/handshake logs in the extension host console.

- [ ] **Step 5: Run the full focused suites + commit**

Run: `cd src && npx vitest run services/mcp core/webview` — Expected: PASS.
Run: `cd webview-ui && npx vitest run src/components/chat src/services/mcp-app src/components/mcp` — Expected: PASS.

```bash
git add apps/vscode-e2e/src/suite/tools/fixtures/mcp-ui-server.ts apps/vscode-e2e/src/fixtures/mcp-apps.ts apps/vscode-e2e/src/suite/tools/mcp-apps.test.ts
git commit -m "test(mcp-apps): e2e smoke for ui:// resource fetch through host bridge"
```

---

## Requirement → Task traceability

| Architecture requirement | Task(s) |
|---|---|
| `frame-src` on both CSP variants, script-src untouched | 1 |
| Bundled sandbox-proxy via `asWebviewUri`, opaque-origin inner srcdoc | 1 (spike), 8 |
| `mcpAppRequest`/`mcpAppResponse` pair with `requestId` correlation + timeout | 6, 7 |
| v1 methods only `resources/read` (`ui://`-only) + `tools/call` | 6 |
| Approval gate: webview inline confirm + host re-validation | 6 (host), 10 (webview) |
| Capability `extensions["io.modelcontextprotocol/ui"]`, flag-gated, connect-time + refresh | 3 (refresh), 5 |
| ext-apps 1.7.5 only; duplicate-SDK check | 7 |
| `mcpAppsEnabled` default false, full checklist round trip | 3 |
| Per-server `disableUi` mirroring `disabledTools`, both gates honor it | 4 (config+host), 6 (re-validation), 9 (render gate) |
| Legacy `_meta["ui/resourceUri"]` + nested precedence via single helper | 2, 9 |
| `McpTool._meta` type + regression test | 2 |
| 2 MB size cap pre/post decode | 6 |
| URL-scheme allowlist before `openExternal` | 10 |
| `ui/message` → textarea insertion (no silent injection) | 10 |
| `ui/update-model-context` NOT advertised | 9 (capability set excludes it; Step 1 gate confirms field names) |
| Size-change notifications adjust frame height | 9 |
| Result-level `_meta` UI override | 2 (extractor), 9 (prefers resultMeta; end-to-end plumbing documented as deferred) |
| e2e smoke in `apps/vscode-e2e` | 11 |
