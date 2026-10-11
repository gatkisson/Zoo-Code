# MCP Apps spike results (Task 1)

Date: 2026-10-11  VS Code version: <fill in from Help > About when running the manual check>

Status: AWAITING MANUAL VERIFICATION — run F5 dev-host check per this document before enabling mcpAppsEnabled in production

Decision: PENDING

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
3. Observe the three criteria in the table below and record PASS/FAIL plus notes.
4. Fill in the VS Code version (Help > About), set `Status:` to VERIFIED, and replace `Decision: PENDING` with either `PRIMARY` (nested-frame model CONFIRMED) or `FALLBACK` (render-into-proxy; requires architecture re-review before Task 9).

## PASS criteria (all must hold)

1. The inner frame shows `ran` (inline script executed despite the TOP-LEVEL webview CSP being nonce+strict-dynamic).
2. DevTools console of the outer frame logs `[proxy] relay:` for a message posted from the inner frame (add `parent.postMessage("ping","*")` to the srcdoc to test).
3. The webview itself still loads normally (no CSP violations for the React app).

**FAIL handling:** if criterion 1 fails, record it and adopt the documented fallback: render app HTML directly into the proxy document (no inner frame) — flag in the decision doc that isolation is weaker and requires architecture re-review before Task 9. If criterion 2 fails, the relay must use `MessageChannel` ports instead of direct `postMessage`; note the required change for Task 8.

## Results

| Criterion | Result | Notes |
|---|---|---|
| Inner srcdoc inline script executes | PENDING | |
| proxy↔inner postMessage relay works | PENDING | |
| Webview app unaffected by frame-src | PENDING | |

Decision: PENDING

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
