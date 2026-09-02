import { launch, goto } from "./pw";
const ctx = await launch(); const page = ctx.page;
const r = await page.request.fetch("http://localhost:5000/api/artifacts", { method: "POST", headers: { "x-local-user": "u1", "content-type": "application/json" }, data: JSON.stringify({ type: "code", title: "Probe code", content: "const x = 1;\nfunction f(a) { return a + x; }", language: "javascript" }) });
const a = await r.json(); await goto(ctx, "/artifacts", "artifacts with code");
await page.click(`[data-testid=artifact-card-${a.id}]`).catch(() => {}); await page.waitForTimeout(1500);
const ok = await page.locator("code, pre").evaluateAll(els => els.some(e => e.querySelector(".token") || /token/.test(e.innerHTML))); console.log("highlighted tokens rendered:", ok, "| page shows code:", /function f\(a\)/.test(await page.innerText("body")));
await page.screenshot({ path: "tests/perf/out/shot-code-artifact.png" });
await page.request.fetch(`http://localhost:5000/api/artifacts/${a.id}`, { method: "DELETE", headers: { "x-local-user": "u1" } });
await ctx.browser.close();
