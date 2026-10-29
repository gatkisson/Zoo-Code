# MCP Apps spike results (Task 1)

Date: 2026-10-11 (authored) · machine-verified 2026-10-24 · VS Code version: 1.100.0 (automated dev-host spike, `apps/vscode-e2e/src/spike/mcp-apps.spike.ts`)

Status: FALLBACK MACHINE-VERIFIED — render-into-proxy live in dev host. Automated dev-host spike drove a real VS Code 1.100.0 Extension Development Host (Playwright `_electron`, `extensionDevelopmentPath=src`). Evidence: `apps/vscode-e2e/out/spike-evidence/spike-evidence.json` + `spike-diagnostics-post-probe.json` (nested-frame run of 2026-10-24T10:51Z; fallback re-verification run of 2026-10-25T15:39Z — see Results).

Decision: FALLBACK — criterion 1 FAILED; per the FAIL handling below, adopt render-into-proxy (app HTML rendered directly into the proxy document, no inner srcdoc frame). Isolation is weaker than the nested-frame model and **requires architecture re-review before Task 9**. `mcpAppsEnabled` stays default-off (enablement gate closed) until the fallback lands.

## Scope note (2026-10-10 amendment)

Per the plan amendment, this spike was produced with **automated scope only**: the fixture
files below were created under the git-ignored scratch directory
`.superpowers/sdd/2026-10-07-mcp-apps-support/spike/` and are **not committed**. No tracked
file was edited for the spike itself, and no Extension Development Host was driven from
automation. The manual F5 verification below must be performed by a human before the
nested-frame model is confirmed and `mcpAppsEnabled` is enabled in production.

## How to run the manual check

1. Press F5 in this repo to launch the Extension Development Host (dev CSP variant is used automatically).
2. Temporarily paste the proxy fixture body (see "Proxy fixture" below) into the dev webview HTML (`getDevHtmlContent` in `src/core/webview/ClineProvider.ts`) as throwaway markup, or serve `proxy.html` from a local file and load it inside a test webview panel. This edit is throwaway — revert it after the check; do not commit.
3. Observe the four criteria in the table below and record PASS/FAIL plus notes.
4. Fill in the VS Code version (Help > About), set `Status:` to VERIFIED, and replace `Decision: PENDING` with either `PRIMARY` (nested-frame model CONFIRMED) or `FALLBACK` (render-into-proxy; requires architecture re-review before Task 9).

## PASS criteria (all must hold)

1. The inner frame shows `ran` (inline script executed despite the TOP-LEVEL webview CSP being nonce+strict-dynamic).
2. DevTools console of the outer frame logs `[proxy] relay:` for a message posted from the inner frame (add `parent.postMessage("ping","*")` to the srcdoc to test).
3. The webview itself still loads normally (no CSP violations for the React app).
4. Host-window transport seam: the webview window receives the relayed message with `event.source === proxyFrame.contentWindow` (register a `window.addEventListener("message", …)` probe in the webview console and inspect `event.source`). With the SHIPPED proxy (`src/assets/mcp-app-sandbox-proxy.html`) instead of the fixture, observe the parse-time `{ type: "mcp-app-sandbox-proxy-ready" }` ping in the webview DevTools console — the shipped proxy posts it to `window.parent` at parse time and no webview code consumes it (`McpAppFrame` starts the bridge on the iframe `load` event), so seeing it with a matching `event.source` directly proves the proxy→host relay path that carries all AppBridge traffic.

**FAIL handling:** if criterion 1 fails, record it and adopt the documented fallback: render app HTML directly into the proxy document (no inner frame) — flag in the decision doc that isolation is weaker and requires architecture re-review before Task 9. If criterion 2 fails, the relay must use `MessageChannel` ports instead of direct `postMessage`; note the required change for Task 8. If criterion 4 fails (relayed message never reaches the webview window, arrives with a mismatched `event.source`, or the ready ping never fires), the source-gated listeners in `McpAppFrame.tsx` / the shipped proxy cannot complete the AppBridge handshake — fix the relay chain before enabling `mcpAppsEnabled`.

## Results

Machine-verified 2026-10-24 via the automated dev-host spike (`pnpm --dir apps/vscode-e2e test:spike:mcp-apps`; VS Code 1.100.0, Electron/Chromium bundled with that build). Raw evidence: `apps/vscode-e2e/out/spike-evidence/spike-evidence.json`.

| Criterion | Result | Notes |
|---|---|---|
| Inner srcdoc inline script executes | **FAIL** | Chromium CSP inheritance: the sandboxed srcdoc frame inherits the parent webview's delivered policy, so the app's inline `<script>` is blocked despite the proxy document's own meta CSP (`'unsafe-inline'`). Policies intersect; the inherited nonce+strict-dynamic `script-src` wins. Witness from the run: `[about:srcdoc] Refused to execute inline script because it violates the following Content Security Policy directive: "script-src 'self' https://*.vscode-cdn.net 'sha256-…' 'wasm-unsafe-eval' 'nonce-…' 'strict-dynamic'"`. |
| proxy↔inner postMessage relay works | **PARTIAL** | Host→proxy→srcdoc leg PROVEN: the proxy received `mcp-app-set-html`, mounted the sandboxed srcdoc iframe, and the card text `hello-mcp-app` rendered (`srcdocCardText`). Inner→proxy leg UNPROVEN — the inner relay probe script never executes (blocked by the criterion-1 CSP inheritance above), so nothing reaches the relay. |
| Webview app unaffected by frame-src | **PASS** | React app healthy end to end: task ran to completion, "Card rendered." landmark visible in chat (`completionLandmarkVisible: true`); no CSP violations attributable to the webview app itself. |
| Host-window transport seam (source-gated relay + ready ping) | **PARTIAL** | The shipped proxy's parse-time `{ type: "mcp-app-sandbox-proxy-ready" }` ping was captured by the host-window probe with `sourceIsProxyFrame: true` — the proxy→host relay path that carries AppBridge traffic works and source gating matches. The inner-origin leg of the seam is unproven downstream of criterion 1 (no relayed inner message to observe). |

Decision: **FALLBACK** — per the FAIL handling above, the nested-frame model is not viable inside a VS Code webview (Chromium intersects inherited CSP policies into srcdoc documents; the proxy's meta CSP cannot re-admit `'unsafe-inline'` once the delivered nonce+strict-dynamic policy is inherited). Adopt render-into-proxy: the proxy document renders app HTML directly and executes app scripts via `document.createElement("script")` insertion, which satisfies the inherited `'strict-dynamic'` chain. Isolation is weaker (app code runs in the proxy document's own origin context under the inherited webview CSP) and **requires architecture re-review before Task 9**. `mcpAppsEnabled` remains default-off.

Three product bugs were found and fixed en route (all covered by `src/core/webview/__tests__/ClineProvider.spec.ts`): (1) raw `</script>` inside the injected `MCP_APP_SANDBOX_PROXY_HTML` JSON literal killed the inline injection script — `<` is now escaped as `\u003c`; (2) webview CSP `frame-src` lacked `blob:`, so the blob-mounted proxy iframe navigated to `chrome-error://` — `blob:` added to dev and prod `frame-src`; (3) the relay-script sha256 hash was computed over CRLF file bytes while browsers normalize script data to LF — the asset is now LF-normalized at read time.

### Fallback re-verification (2026-10-24)

The dev-host spike was re-scoped to the render-into-proxy fallback model — the app HTML renders INSIDE the blob-mounted proxy document (`src/assets/mcp-app-sandbox-proxy.html`), with app inline scripts re-executed via dynamic insertion admitted by strict-dynamic propagation from the hash-admitted relay script; there is no nested srcdoc frame — and re-run against the real VS Code 1.100.0 Extension Development Host (`pnpm --dir apps/vscode-e2e test:spike:mcp-apps`; run of 2026-10-25T15:39Z, result `1 passed`). All criteria now pass, machine-verified from `apps/vscode-e2e/out/spike-evidence/spike-evidence.json`:

| Criterion | Result | Evidence JSON values |
|---|---|---|
| c1: app inline script executed inside the proxy document (strict-dynamic re-execution), witnessed as the relay probe arriving at the host window | **PASS** | `c1InnerScriptExecuted: true`; `relayProbe.nonce: "spike-relay-probe-001"` |
| c2a: host→proxy control delivery renders the card in the blob proxy frame | **PASS** | `c2aHostToInnerDelivery: true`; `srcdocCardText: "hello-mcp-app"` |
| c2b: proxy→host relay of app traffic | **PASS** | `c2bInnerToHostRelay: true` (same relay probe witness) |
| c3: webview app unaffected | **PASS** | `c3WebviewAppUnaffected: true`; `completionLandmarkVisible: true` |
| c4: host-window transport seam (source-gated) | **PASS** | `c4HostWindowSeam: true`; `relayProbe.sourceIsProxyFrame: true` and `ping.sourceIsProxyFrame: true` |

The fallback model is therefore live and machine-verified in the dev host: app scripts execute inside the opaque-origin proxy document and the full AppBridge relay path (proxy→host window with matching `event.source`) works end to end.

## Fixture contents

### Proxy fixture (`.superpowers/sdd/2026-10-07-mcp-apps-support/spike/proxy.html`)

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

### Nested srcdoc test page (`.superpowers/sdd/2026-10-07-mcp-apps-support/spike/inner-srcdoc.html`)

Same content as the `srcdoc` attribute above, with the criterion-2 ping added per the PASS-criteria note:

```html
<!DOCTYPE html><html><body><div id='x'>no</div><script>document.getElementById('x').textContent='ran'; parent.postMessage("ping","*")</script></body></html>
```

To exercise criterion 2, either use this file's content as the `srcdoc` string in `proxy.html`, or append `parent.postMessage("ping","*")` to the inline script inside the `srcdoc` attribute.

## CSP change already landed (automated part of Task 1)

The webview CSP now includes `frame-src ${webview.cspSource}` in both the dev (`getDevHtmlContent`) and production (`getHtmlContent`) variants in `src/core/webview/ClineProvider.ts`, covered by the unit test `"includes frame-src in the production webview CSP"` in `src/core/webview/__tests__/ClineProvider.spec.ts`. `script-src` is unchanged (nonce + `'strict-dynamic'`, no `unsafe-inline`).
