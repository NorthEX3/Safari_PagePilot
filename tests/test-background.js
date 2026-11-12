// Offline tests for extension/background.js: endpoint validation, SSE parsing, streaming, errors, abort.
const fs = require("fs"), vm = require("vm"), path = require("path"), assert = require("assert");
const src = fs.readFileSync(path.join(__dirname, "../extension/background.js"), "utf8");

function load({ storage = {}, fetchImpl } = {}) {
  let onConnect, onMessage, onClicked;
  const calls = { inject: [], badge: [] };
  const chrome = {
    action: { onClicked: { addListener: f => { onClicked = f; } }, setBadgeText: async o => { calls.badge.push(o.text); } },
    tabs: { query: async () => [{ id: 99 }] },
    scripting: { executeScript: async o => { if (calls.fail) throw new Error("denied"); calls.inject.push(o); if (o.world === "MAIN") return [{ result: calls.editorDocs || [] }]; } },
    storage: { local: { get: async () => storage } },
    runtime: { id: "me", onConnect: { addListener: f => { onConnect = f; } }, onMessage: { addListener: f => { onMessage = f; } } }
  };
  const ctx = { chrome, fetch: fetchImpl, console, URL, TextDecoder, AbortController, setTimeout, clearTimeout, Promise };
  ctx.globalThis = ctx;
  vm.runInNewContext(src, ctx);
  return { core: ctx.PagePilotCore, connect: () => onConnect, message: () => onMessage, click: () => onClicked, calls };
}
function fakePort(tabId = 1) {
  const sent = []; const handlers = []; const disc = [];
  return {
    name: "pagepilot-stream", sender: tabId ? { tab: { id: tabId } } : {}, sent,
    postMessage: m => sent.push(m), disconnect() { this.disconnected = true; },
    onMessage: { addListener: f => handlers.push(f) }, onDisconnect: { addListener: f => disc.push(f) },
    emit: m => handlers.forEach(f => f(m)), drop: () => disc.forEach(f => f())
  };
}
const sse = chunks => ({
  ok: true, status: 200, headers: { get: () => "text/event-stream; charset=utf-8" },
  body: { getReader() { let i = 0; const enc = new TextEncoder(); return { read: async () => i < chunks.length ? { done: false, value: enc.encode(chunks[i++]) } : { done: true } }; } }
});
const delta = t => `data: ${JSON.stringify({ choices: [{ delta: { content: t } }] })}\n\n`;
const wait = ms => new Promise(r => setTimeout(r, ms));
const tests = [];
const t = (name, fn) => tests.push([name, fn]);

t("buildEndpoint normalises and validates", () => {
  const { core } = load();
  assert.equal(core.buildEndpoint("https://api.deepseek.com").endpoint, "https://api.deepseek.com/chat/completions");
  assert.equal(core.buildEndpoint("https://api.openai.com/v1/").endpoint, "https://api.openai.com/v1/chat/completions");
  assert.equal(core.buildEndpoint("https://x.io/v1/chat/completions?a=1#b").endpoint, "https://x.io/v1/chat/completions");
  assert.equal(core.buildEndpoint("http://localhost:11434/v1").endpoint, "http://localhost:11434/v1/chat/completions");
  assert.ok(core.buildEndpoint("http://evil.example/v1").error);
  assert.ok(core.buildEndpoint("https://u:p@x.io").error);
  assert.ok(core.buildEndpoint("not a url").error);
});
t("sanitizeMessages filters, truncates, requires trailing user", () => {
  const { core } = load();
  assert.equal(core.sanitizeMessages([{ role: "assistant", content: "a" }]), null);
  assert.equal(core.sanitizeMessages("x"), null);
  const out = core.sanitizeMessages([{ role: "system", content: "evil" }, { role: "user", content: "x".repeat(40000) }]);
  assert.equal(out.length, 1); assert.equal(out[0].content.length, 32000);
  assert.equal(core.sanitizeMessages(Array.from({ length: 30 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: "m" + i })).concat({ role: "user", content: "last" })).length, 12);
});
t("SSE parser handles split chunks, CRLF, multi-line, trailing flush", () => {
  const { core } = load(); const got = [];
  const p = core.createSseParser(d => got.push(d));
  p.push('data: {"a"'); p.push(':1}\r\n\r\ndata: two\n'); p.push('\ndata: [DO'); p.push("NE]\n\n: comment\n\ndata: tail");
  p.flush();
  assert.deepEqual(got, ['{"a":1}', "two", "[DONE]", "tail"]);
});
t("streams deltas then done; sends bearer + stream flag", async () => {
  let req;
  const { connect } = load({
    storage: { apiKey: " sk-1 ", baseUrl: "https://api.deepseek.com", model: "deepseek-chat" },
    fetchImpl: async (url, init) => { req = { url, init }; return sse([delta("你"), delta("好") .slice(0, 10), delta("好").slice(10), `data: ${JSON.stringify({ usage: { total_tokens: 9 }, choices: [] })}\n\n`, "data: [DONE]\n\n"]); }
  });
  const port = fakePort(); connect()(port);
  port.emit({ type: "ask", messages: [{ role: "user", content: "hi" }] });
  await wait(30);
  const body = JSON.parse(req.init.body);
  assert.equal(req.url, "https://api.deepseek.com/chat/completions");
  assert.equal(req.init.headers.Authorization, "Bearer sk-1");
  assert.equal(body.stream, true); assert.equal(body.model, "deepseek-chat"); assert.equal(body.messages[0].role, "system");
  assert.deepEqual(port.sent.filter(m => m.type === "delta").map(m => m.text), ["你", "好"]);
  assert.equal(port.sent.at(-1).type, "done"); assert.equal(port.sent.at(-1).usage.total_tokens, 9);
});
t("accepts ports even when sender info is missing (Safari)", async () => {
  const { connect } = load({ storage: { apiKey: "k" }, fetchImpl: async () => sse([delta("x"), "data: [DONE]\n\n"]) });
  const port = fakePort(0); connect()(port); port.emit({ type: "ask", messages: [{ role: "user", content: "x" }] }); await wait(20);
  assert.ok(!port.disconnected); assert.equal(port.sent.at(-1).type, "done");
});
t("missing key / bad url / bad payload produce errors", async () => {
  for (const [storage, msgs, re] of [
    [{}, [{ role: "user", content: "x" }], /API Key/],
    [{ apiKey: "k", baseUrl: "http://evil.com" }, [{ role: "user", content: "x" }], /https/],
    [{ apiKey: "k" }, [{ role: "assistant", content: "x" }], /消息格式/]
  ]) {
    const { connect } = load({ storage, fetchImpl: async () => { throw new Error("should not fetch"); } });
    const port = fakePort(); connect()(port); port.emit({ type: "ask", messages: msgs }); await wait(10);
    assert.equal(port.sent[0].type, "error"); assert.match(port.sent[0].error, re);
  }
});
t("HTTP errors map to friendly messages", async () => {
  for (const [status, re] of [[401, /无效/], [402, /余额/], [429, /频繁/], [404, /不存在/], [500, /HTTP 500/]]) {
    const { connect } = load({ storage: { apiKey: "k" }, fetchImpl: async () => ({ ok: false, status, json: async () => ({ error: { message: "boom" } }) }) });
    const port = fakePort(); connect()(port); port.emit({ type: "ask", messages: [{ role: "user", content: "x" }] }); await wait(10);
    assert.match(port.sent[0].error, re);
  }
});
t("falls back to JSON when provider ignores streaming", async () => {
  const { connect } = load({ storage: { apiKey: "k" }, fetchImpl: async () => ({ ok: true, status: 200, headers: { get: () => "application/json" }, json: async () => ({ choices: [{ message: { content: "整段答案" } }], usage: { n: 1 } }) }) });
  const port = fakePort(); connect()(port); port.emit({ type: "ask", messages: [{ role: "user", content: "x" }] }); await wait(10);
  assert.deepEqual(port.sent.map(m => m.type), ["delta", "done"]); assert.equal(port.sent[0].text, "整段答案");
});
t("abort stops stream and reports aborted", async () => {
  let abortSignal;
  const { connect } = load({
    storage: { apiKey: "k" },
    fetchImpl: async (_u, init) => {
      abortSignal = init.signal;
      return { ok: true, status: 200, headers: { get: () => "text/event-stream" }, body: { getReader: () => ({ read: () => new Promise((res, rej) => { init.signal.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" }))); }) }) } };
    }
  });
  const port = fakePort(); connect()(port); port.emit({ type: "ask", messages: [{ role: "user", content: "x" }] }); await wait(10);
  port.emit({ type: "abort" }); await wait(10);
  assert.ok(abortSignal.aborted); assert.deepEqual(port.sent.at(-1), { type: "done", aborted: true });
});
t("empty stream is an error; mid-stream provider error surfaces", async () => {
  let { connect } = load({ storage: { apiKey: "k" }, fetchImpl: async () => sse(["data: [DONE]\n\n"]) });
  let port = fakePort(); connect()(port); port.emit({ type: "ask", messages: [{ role: "user", content: "x" }] }); await wait(10);
  assert.match(port.sent.at(-1).error, /没有返回/);
  ({ connect } = load({ storage: { apiKey: "k" }, fetchImpl: async () => sse([`data: ${JSON.stringify({ error: { message: "quota" } })}\n\n`]) }));
  port = fakePort(); connect()(port); port.emit({ type: "ask", messages: [{ role: "user", content: "x" }] }); await wait(10);
  assert.match(port.sent.at(-1).error, /quota/);
});
t("v0.1 storage keys are migrated; flash model name falls back", async () => {
  let body;
  const { connect } = load({ storage: { deepseekApiKey: "old", deepseekModel: "deepseek-flash" }, fetchImpl: async (_u, i) => { body = JSON.parse(i.body); return sse([delta("x"), "data: [DONE]\n\n"]); } });
  const port = fakePort(); connect()(port); port.emit({ type: "ask", messages: [{ role: "user", content: "x" }] }); await wait(10);
  assert.equal(body.model, "deepseek-chat");
});
t("test-connection message works without any sender info", async () => {
  const { message } = load({ fetchImpl: async () => ({ ok: true, status: 200 }) });
  const handler = message();
  assert.equal(handler({ type: "other" }, {}, () => {}), false);
  const res = await new Promise(r => handler({ type: "PAGEPILOT_TEST", settings: { baseUrl: "https://a.io", apiKey: "k", model: "m" } }, undefined, r));
  assert.equal(res.ok, true);
  const bad = await new Promise(r => handler({ type: "PAGEPILOT_TEST", settings: { baseUrl: "http://evil.com", apiKey: "k", model: "m" } }, undefined, r));
  assert.match(bad.error, /https/);
});
t("test-connection reports HTTP detail and network failures", async () => {
  let { message } = load({ fetchImpl: async () => ({ ok: false, status: 404, json: async () => ({}) }) });
  let res = await new Promise(r => message()({ type: "PAGEPILOT_TEST", settings: { baseUrl: "https://a.io", apiKey: "k", model: "bad" } }, {}, r));
  assert.match(res.error, /不存在/);
  ({ message } = load({ fetchImpl: async () => { throw Object.assign(new Error("Load failed"), { name: "TypeError" }); } }));
  res = await new Promise(r => message()({ type: "PAGEPILOT_TEST", settings: { baseUrl: "https://a.io", apiKey: "k", model: "m" } }, {}, r));
  assert.match(res.error, /a\.io.*TypeError: Load failed/);
});
t("toolbar click injects the panel into http(s) tabs, flags internal pages", async () => {
  const h = load();
  await h.click()({ id: 7, url: "https://example.com/a" });
  assert.deepEqual(h.calls.inject[0], { target: { tabId: 7 }, files: ["content.js"] });
  await h.click()({ id: 8, url: "about:blank" });
  assert.equal(h.calls.inject.length, 1); assert.deepEqual(h.calls.badge, ["!"]);
  h.calls.fail = true; await h.click()({ id: 9, url: "https://x.io" });
  assert.deepEqual(h.calls.badge, ["!", "!"]);
});

t("PAGEPILOT_EDITOR reads editors in MAIN world, dedupes, falls back to the active tab", async () => {
  const h = load(); h.calls.editorDocs = [{ text: "a=1" }, { text: "a=1" }, { text: "b=2" }];
  let res = await new Promise(r => h.message()({ type: "PAGEPILOT_EDITOR" }, { tab: { id: 5 } }, r));
  assert.equal(h.calls.inject.at(-1).target.tabId, 5); assert.equal(h.calls.inject.at(-1).world, "MAIN");
  assert.deepEqual(res.docs.map(d => d.text), ["a=1", "b=2"]);
  res = await new Promise(r => h.message()({ type: "PAGEPILOT_EDITOR" }, {}, r));
  assert.equal(h.calls.inject.at(-1).target.tabId, 99); // Safari may not provide sender.tab
  h.calls.fail = true; res = await new Promise(r => h.message()({ type: "PAGEPILOT_EDITOR" }, {}, r));
  assert.deepEqual(res, { ok: false, docs: [] });
});
t("pageEditorReader extracts Monaco / CodeMirror 6 / CodeMirror 5 contents", () => {
  const { core } = load();
  const mk = (text, lang) => ({ uri: { path: "/index.html", toString: () => "inmemory://x" }, getLanguageId: () => lang, getValue: () => text });
  const win = { monaco: { editor: { getModels: () => [mk("<h1>Hi</h1>", "html")] } } };
  const cm6 = { cmView: { view: { state: { doc: { toString: () => "const a = 1;" } } } } };
  const cm5 = { CodeMirror: { getValue: () => "print(1)" } };
  const document = { querySelectorAll: sel => sel === ".cm-content" ? [cm6] : sel === ".CodeMirror" ? [cm5] : [] };
  const out = vm.runInNewContext("(" + core.pageEditorReader.toString() + ")()", { window: win, document });
  assert.deepEqual(out.map(d => [d.kind, d.lang, d.text]), [["monaco", "html", "<h1>Hi</h1>"], ["codemirror", "", "const a = 1;"], ["codemirror", "", "print(1)"]]);
  assert.equal(out[0].name, "/index.html");
  assert.deepEqual(vm.runInNewContext("(" + core.pageEditorReader.toString() + ")()", { window: {}, document: { querySelectorAll: () => [] } }), []);
});

t("pageTechReader detects animation libraries and canvases; PAGEPILOT_TECH message", async () => {
  const { core } = load();
  const win = { gsap: { version: "3.12.5" }, THREE: { REVISION: "160" }, jQuery: { fn: { jquery: "3.7.1" } }, Swiper: function () {} };
  const doc = { querySelectorAll: () => [{ width: 1920, height: 1080 }] };
  const out = vm.runInNewContext("(" + core.pageTechReader.toString() + ")()", { window: win, document: doc });
  assert.deepEqual(out.globals, ["gsap@3.12.5", "THREE@r160", "Swiper", "jQuery@3.7.1"]); assert.deepEqual(out.canvases, [{ w: 1920, h: 1080 }]);
  const h = load(); h.calls.editorDocs = { globals: ["gsap"], canvases: [] };
  const res = await new Promise(r => h.message()({ type: "PAGEPILOT_TECH" }, {}, r));
  assert.equal(res.ok, true); assert.deepEqual(res.tech.globals, ["gsap"]);
  h.calls.fail = true; const bad = await new Promise(r => h.message()({ type: "PAGEPILOT_TECH" }, {}, r));
  assert.deepEqual(bad, { ok: false, tech: {} });
});

t("PAGEPILOT_FETCH returns script text for http(s) only, honours size limit", async () => {
  const mk = (body, len) => async () => ({ ok: true, headers: { get: () => len }, text: async () => body });
  let h = load({ fetchImpl: mk("var a=1;", "8") });
  let res = await new Promise(r => h.message()({ type: "PAGEPILOT_FETCH", url: "https://x.io/a.js" }, {}, r));
  assert.deepEqual(res, { ok: true, text: "var a=1;" });
  res = await new Promise(r => h.message()({ type: "PAGEPILOT_FETCH", url: "file:///etc/passwd" }, {}, r)); assert.equal(res.ok, false);
  res = await new Promise(r => h.message()({ type: "PAGEPILOT_FETCH", url: "javascript:alert(1)" }, {}, r)); assert.equal(res.ok, false);
  h = load({ fetchImpl: mk("big", "9000000") });
  res = await new Promise(r => h.message()({ type: "PAGEPILOT_FETCH", url: "https://x.io/big.js" }, {}, r)); assert.equal(res.ok, false);
  h = load({ fetchImpl: async () => { throw new Error("net"); } });
  res = await new Promise(r => h.message()({ type: "PAGEPILOT_FETCH", url: "https://x.io/a.js" }, {}, r)); assert.equal(res.ok, false);
});

(async () => {
  let failed = 0;
  for (const [name, fn] of tests) {
    try { await fn(); console.log("  ok  ", name); } catch (e) { failed++; console.log("  FAIL", name, "\n      ", e.message); }
  }
  console.log(failed ? `\n${failed} FAILED` : `\nPASS: ${tests.length} background tests`);
  process.exit(failed ? 1 : 0);
})();
