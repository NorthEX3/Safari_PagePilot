// Real-Chromium test of the injected panel with a mocked extension runtime. Run: node tests/test-ui.js
const { chromium } = require("playwright"); const path = require("path"), assert = require("assert"), fs = require("fs");
const root = path.join(__dirname, "..");
const script = fs.readFileSync(path.join(root, "extension/content.js"), "utf8");
const LONG = Array.from({ length: 4000 }, (_, i) => `line ${i} lorem ipsum dolor sit amet`).join("\n");
const PAGE = `<html><head><title>CSS Tutorial</title></head><body><main><h1>CSS Tutorial</h1><p id="sel">Learning flexbox and grid.</p><pre>.a{display:flex}</pre><div class="monaco-editor"><div class="view-lines">visible-line-only</div></div><style>@keyframes fadeIn{from{opacity:0}to{opacity:1}} .hero{animation:fadeIn 1s ease infinite;transition:opacity .3s}</style><div class="hero" style="transform:translateX(3px)">hero</div><script type="text/plain" src="/js/anim.js"></script><script type="text/plain" src="https://cdn.example.com/gsap/3.12/gsap.min.js"><\/script><div>${LONG.replace(/\n/g, "<br>")}</div></main></body></html>`;

const INIT = () => {
  // Expose the closed shadow root to the test only.
  const orig = Element.prototype.attachShadow;
  Element.prototype.attachShadow = function (o) { const r = orig.call(this, { ...o, mode: "open" }); window.__shadow = r; return r; };
  window.__ports = []; window.__script = "stream"; window.__store = { apiKey: "sk-x", baseUrl: "https://api.deepseek.com", model: "deepseek-chat" }; window.__msgs = [];
  window.browser = { storage: { local: { get: async () => ({ ...window.__store }), set: async o => Object.assign(window.__store, o), remove: async k => k.forEach(x => delete window.__store[x]) } },
    runtime: { sendMessage: async m => { window.__msgs.push(m); if (m.type === "PAGEPILOT_TECH") return { ok: true, tech: { globals: ["gsap@3.12.5", "THREE@r160"], canvases: [{ w: 1920, h: 1080 }] } }; if (m.type === "PAGEPILOT_EDITOR") return { ok: true, docs: window.__editor || [] }; return window.__testResult ?? { ok: true }; }, connect() {
    const handlers = [], disc = [];
    const port = { sent: [], onMessage: { addListener: f => handlers.push(f) }, onDisconnect: { addListener: f => disc.push(f) },
      disconnect() {}, postMessage(m) {
        port.sent.push(m); window.__ports.push(port);
        const emit = x => handlers.forEach(f => f(x));
        if (m.type === "abort") { emit({ type: "done", aborted: true }); return; }
        if (m.type !== "ask") return;
        if (window.__script === "error") return setTimeout(() => emit({ type: "error", error: "API Key 无效或已失效，请重新检查。" }), 10);
        if (window.__script === "slow") return setTimeout(() => { emit({ type: "delta", text: "好的" }); setTimeout(() => emit({ type: "done" }), 3500); }, 400);
        if (window.__script === "hang") { emit({ type: "delta", text: "部分" }); return; }
        const text = "## 总结\n这是 **重点**，参见 [文档](https://example.com) 与 [坏链接](javascript:alert(1))。\n\n- 第一项 `flex`\n- 第二项\n\n```css\n.a { display: flex; }\n```\n\n<img src=x onerror=\"window.__xss=1\"><script>window.__xss=1<\/script>";
        let i = 0; const step = () => { if (i < text.length) { emit({ type: "delta", text: text.slice(i, i += 7) }); setTimeout(step, 4); } else emit({ type: "done" }); }; setTimeout(step, 10);
      } };
    return port;
  } } };
};

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 810 }, deviceScaleFactor: 2 });
  const errors = []; page.on("pageerror", e => errors.push(e.message)); page.on("console", m => m.type() === "error" && errors.push(m.text()));
  await page.addInitScript(INIT);
  await page.route("https://test.local/**", r => r.fulfill({ contentType: "text/html", body: PAGE }));
  await page.route("https://test.local/js/anim.js", r => r.fulfill({ contentType: "application/javascript", body: "var pad=\"" + "x".repeat(5000) + "\";function init(){ gsap.to(\".hero\",{x:100,duration:1.2,ease:\"power2.out\"}); } " + "y".repeat(5000) + " requestAnimationFrame(loop);" }));
  await page.route("https://cdn.example.com/**", r => r.fulfill({ status: 200, contentType: "application/javascript", headers: { "access-control-allow-origin": "*" }, body: "//" }));
  await page.goto("https://test.local/");
  const inject = () => page.addScriptTag({ content: script });
  const q = sel => page.evaluate(s => window.__shadow.querySelector(s)?.textContent ?? null, sel);
  const clickChip = async label => { await page.waitForFunction(l => [...window.__shadow.querySelectorAll("#chips .chip")].some(b => b.textContent === l), label); await page.evaluate(l => [...window.__shadow.querySelectorAll("#chips .chip")].find(b => b.textContent === l).click(), label); };
  const extraLabels = () => page.evaluate(() => [...[...window.__shadow.querySelectorAll("#chips .chip")].slice(3), ...window.__shadow.querySelectorAll("#chipsMore .chip")].map(c => c.textContent));
  const chipLabels = () => page.evaluate(() => [...window.__shadow.querySelectorAll("#chips .chip")].map(b => b.textContent));
  const click = sel => page.evaluate(s => window.__shadow.querySelector(s).click(), sel);
  const ok = m => console.log("  ok  ", m);

  await inject();
  assert.equal(await page.locator("#pagepilot-safari-root").count(), 1); ok("panel injected");
  assert.equal(await q("#title"), "CSS Tutorial"); assert.equal(await q(".tag-label"), "正在阅读：");
  const lay = await page.evaluate(() => { const s = window.__shadow, r = e => s.querySelector(e).getBoundingClientRect(); return { tagBottom: r("#pagetag").bottom, composerTop: r(".composer").top, gap: r(".composer").top - r("#pagetag").bottom, tagH: r("#pagetag").height, inCard: !!s.querySelector(".card #pagetag"), cardRows: s.querySelectorAll(".card .row").length, fs: getComputedStyle(s.querySelector("#pagetag")).fontSize }; });
  assert.ok(lay.tagBottom <= lay.composerTop && !lay.inCard && lay.cardRows === 0 && lay.tagH <= 28 && lay.gap >= 14 && lay.fs === "11px", JSON.stringify(lay)); const cen = await page.evaluate(() => { const s = window.__shadow, t = s.querySelector("#pagetag").getBoundingClientRect(), p = s.querySelector("#panel").getBoundingClientRect(); return Math.abs((t.left + t.right) / 2 - (p.left + p.right) / 2); });
  assert.ok(cen < 1.5, "tag off-centre by " + cen); ok("「正在阅读：标题」 shown as a small tag above the composer (no settings card above the chips any more)");
  await page.screenshot({ path: path.join(root, "tests/ui-empty.png") });

  await page.evaluate(() => { const t = window.__shadow.querySelector("#title"); t.dataset.orig = t.textContent; t.textContent = "一个非常非常非常非常非常非常非常非常非常非常非常非常长的网页标题 A very long page title that must be truncated with an ellipsis"; });
  const ell = await page.evaluate(() => { const s = window.__shadow, tag = s.querySelector("#pagetag").getBoundingClientRect(), p = s.querySelector("#panel").getBoundingClientRect(), t = s.querySelector("#title"); return { fits: tag.width <= 252 && tag.width <= p.width - 20, clipped: t.scrollWidth > t.clientWidth, overflow: getComputedStyle(t).textOverflow, label: s.querySelector(".tag-label").getBoundingClientRect().width > 0 }; });
  assert.ok(ell.fits && ell.clipped && ell.overflow === "ellipsis" && ell.label, JSON.stringify(ell)); ok("long title is cut with an ellipsis, label stays visible");
  await page.evaluate(() => { const t = window.__shadow.querySelector("#title"); t.textContent = t.dataset.orig; });

  // composer alignment: textarea and send button share height, textarea grows with text
  const box = () => page.evaluate(() => { const t = window.__shadow.querySelector("#question").getBoundingClientRect(), b = window.__shadow.querySelector("#send").getBoundingClientRect(); return { t: t.height, b: b.height, tb: t.bottom, bb: b.bottom }; });
  let bx = await box(); assert.equal(Math.round(bx.t), Math.round(bx.b)); assert.equal(Math.round(bx.tb), Math.round(bx.bb)); ok("textarea and send button aligned (" + bx.t + "px)");
  await page.evaluate(() => { const t = window.__shadow.querySelector("#question"); t.value = "a\nb\nc"; t.dispatchEvent(new Event("input")); });
  bx = await box(); assert.ok(bx.t > bx.b && Math.round(bx.tb) === Math.round(bx.bb)); ok("grows with multi-line text, stays bottom-aligned");
  await page.evaluate(() => { const t = window.__shadow.querySelector("#question"); t.value = ""; t.dispatchEvent(new Event("input")); });

  // selection capture + explain
  await page.evaluate(() => { const r = document.createRange(); r.selectNodeContents(document.getElementById("sel")); const s = getSelection(); s.removeAllRanges(); s.addRange(r); });
  await page.evaluate(() => window.__shadow.querySelector("#question").focus());
  await clickChip("解释选中内容");
  await page.waitForFunction(() => window.__ports.length === 1);
  let sent = await page.evaluate(() => window.__ports[0].sent[0]);
  assert.match(sent.messages.at(-1).content, /Learning flexbox and grid/); ok("selection survives focusing the panel");
  assert.match(sent.messages.at(-1).content, /网页标题：CSS Tutorial/);
  assert.match(sent.messages.at(-1).content, /已省略中间部分/); assert.ok(sent.messages.at(-1).content.length < 23000); ok("long page truncated (" + sent.messages.at(-1).content.length + " chars)");

  // streaming + markdown + XSS safety
  await page.waitForFunction(() => !window.__shadow.querySelector("#send").classList.contains("stop"), null, { timeout: 5000 });
  assert.equal(await page.evaluate(() => window.__shadow.querySelectorAll(".msg.assistant h2").length), 1); ok("markdown heading rendered");
  assert.equal(await page.evaluate(() => window.__shadow.querySelectorAll(".msg.assistant li").length), 2);
  const links = await page.evaluate(() => [...window.__shadow.querySelectorAll(".md a")].map(a => [a.href, a.rel]));
  assert.deepEqual(links, [["https://example.com/", "noopener noreferrer"]]); ok("only http(s) links kept");
  assert.equal(await page.evaluate(() => !!window.__xss || !!window.__shadow.querySelector("img,script")), false); ok("no HTML injection from model output");
  assert.match(await q(".msg.assistant"), /window\.__xss=1/); ok("underscores in identifiers are left alone");
  assert.equal(await q(".codebox pre"), ".a { display: flex; }"); ok("fenced code block");
  await page.screenshot({ path: path.join(root, "tests/ui-chat.png") });

  // copy button
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await click(".copy");
  await page.waitForFunction(() => window.__shadow.querySelector(".toast"));
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), ".a { display: flex; }"); ok("copy code + toast");
  const tick0 = await page.evaluate(() => { const b = window.__shadow.querySelector(".copy"); return { done: b.classList.contains("done"), text: b.textContent, svg: !!b.querySelector("svg.tick"), aria: b.getAttribute("aria-label"), minW: b.style.minWidth }; });
  assert.ok(tick0.done && tick0.text === "" && tick0.svg && tick0.aria === "已复制" && tick0.minW !== "", JSON.stringify(tick0)); ok("after copying, 复制 becomes a tick icon (button keeps its width)");
  const draw = await page.evaluate(async () => { const p = window.__shadow.querySelector(".copy .tick path"), a = parseFloat(getComputedStyle(p).strokeDashoffset); await new Promise(r => setTimeout(r, 120)); const b = parseFloat(getComputedStyle(p).strokeDashoffset); await new Promise(r => setTimeout(r, 400)); const c = parseFloat(getComputedStyle(p).strokeDashoffset); return { a, b, c, name: getComputedStyle(p).animationName, color: getComputedStyle(p).stroke }; });
  assert.ok(draw.name === "tickdraw" && draw.a > draw.b && draw.b > draw.c && draw.c === 0, JSON.stringify(draw)); ok("the tick draws itself (stroke offset " + draw.a.toFixed(2) + " → " + draw.b.toFixed(2) + " → 0)");
  await page.waitForTimeout(1300);
  assert.equal(await page.evaluate(() => { const b = window.__shadow.querySelector(".copy"); return b.textContent + "|" + b.classList.contains("done") + "|" + b.style.minWidth; }), "复制|false|"); ok("and after a moment the label comes back");

  // follow-up keeps history without re-sending old page text
  await page.evaluate(() => { const t = window.__shadow.querySelector("#question"); t.value = "再详细一点"; });
  await page.evaluate(() => window.__shadow.querySelector("#question").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
  await page.waitForFunction(() => window.__ports.length === 2);
  sent = await page.evaluate(() => window.__ports[1].sent[0]);
  assert.equal(sent.messages.length, 3); assert.equal(sent.messages[0].content.includes("网页标题"), false); ok("history carried, old page snapshot dropped");
  await page.waitForFunction(() => !window.__shadow.querySelector("#send").classList.contains("stop"));

  // switch off: no page text sent

  // smart code reading
  const askText = async text => {
    const n = await page.evaluate(() => window.__ports.length);
    await page.evaluate(t => { window.__shadow.querySelector("#question").value = t; }, text);
    await click("#send"); await page.waitForFunction(k => window.__ports.length === k + 1, n);
    const content = await page.evaluate(() => window.__ports.at(-1).sent[0].messages.at(-1).content);
    await page.waitForFunction(() => !window.__shadow.querySelector("#send").classList.contains("stop"), null, { timeout: 5000 });
    return content;
  };
  const metaText = () => page.evaluate(() => { const m = [...window.__shadow.querySelectorAll(".meta")].filter(x => /已读取网页/.test(x.textContent)); return m.length ? m[m.length - 1].textContent : ""; });
  const editorCalls = () => page.evaluate(() => window.__msgs.filter(m => m.type === "PAGEPILOT_EDITOR").length);
  await page.evaluate(() => { window.__editor = [{ kind: "monaco", name: "/index.html", lang: "html", text: "<h1>FULL-EDITOR-CONTENT</h1>\n<p>line 99</p>" }]; });
  let c = await askText("这段代码是怎么运行的？");
  assert.match(c, /页面中的代码/); assert.match(c, /FULL-EDITOR-CONTENT/); assert.match(c, /编辑器完整内容：\/index\.html（html）/);
  assert.match(c, /\.a\{display:flex\}/); assert.equal(c.includes("【编辑器（当前可见部分）】"), false); ok("code question auto-attaches full editor + code blocks (visible-only snippet deduped)");
  assert.match(await metaText(), /已读取网页 [\d,]+ 字.*已附上代码（编辑器 1 个）/); ok("status line shows what was read and attached");
  const before = await editorCalls();
  c = await askText("总结一下这页");
  assert.equal(await editorCalls(), before); assert.equal(c.includes("页面中的代码"), false); ok("non-code question reads no code");
  await page.evaluate(() => { window.__editor = []; });
  c = await askText("html 结构是什么？");
  assert.match(c, /页面 HTML 结构/); assert.match(c, /<main>/); assert.match(c, /<h1>/); assert.equal(c.includes("<script"), false); ok("structure outline for HTML/DOM questions (no script)");
  assert.match(c, /【编辑器（当前可见部分）】\nvisible-line-only/); ok("falls back to visible editor text when full model unavailable");
  c = await askText("这个网站的动效是怎么实现的？");
  assert.match(c, /动效 \/ 技术线索/); assert.match(c, /cdn\.example\.com\/gsap\/3\.12\/gsap\.min\.js/); assert.match(c, /gsap@3\.12\.5、THREE@r160/);
  assert.match(c, /<canvas> 1 个（1920×1080）/); assert.match(c, /@keyframes（1）[\s\S]*fadeIn/); assert.match(c, /\.hero \{[^}]*animation:[^}]*fadeIn[^}]*\}/); assert.match(c, /\.hero \{[^}]*transition:[^}]*opacity/);
  assert.match(c, /正在运行[\s\S]*hero[\s\S]*CSS animation「fadeIn」/); ok("running animations listed via getAnimations");
  assert.match(c, /内联样式[\s\S]*transform:translateX\(3px\)/); ok("inline motion styles listed");
  assert.match(c, /脚本片段[\s\S]*test\.local\/js\/anim\.js[\s\S]*gsap\.to\("\.hero",\{x:100,duration:1\.2/); assert.ok(c.length < 40000); assert.equal(c.includes("x".repeat(400)), false); ok("script excerpts around gsap/requestAnimationFrame, whole file not sent (" + c.length + " chars total)");
  assert.match(await metaText(), /动效线索/); ok("animation question attaches scripts, libraries, canvas, @keyframes and animation rules");
  c = await askText("这段代码怎么运行的");
  assert.equal(c.includes("动效 / 技术线索"), false); ok("plain code question does not attach animation clues");
  // intent matrix: which extra material each kind of question pulls in
  await page.evaluate(() => { window.__editor = []; });
  const flags = async text => { const x = await askText(text); return { code: x.includes("页面中的代码"), structure: x.includes("页面 HTML 结构"), tech: x.includes("动效 / 技术线索") }; };
  const cases = [
    ["这个函数为什么报错", { code: 1, structure: 0, tech: 0 }],
    ["这行代码的执行顺序是什么", { code: 1, structure: 0, tech: 0 }],
    ["Why does this throw an exception?", { code: 1, structure: 0, tech: 0 }],
    ["为什么这个样式不生效", { code: 1, structure: 1, tech: 0 }],
    ["这个页面的布局是怎么搭的", { code: 1, structure: 1, tech: 0 }],
    ["这个按钮的 hover 效果怎么实现", { code: 1, structure: 0, tech: 1 }],
    ["这个页面是怎么做出来的，用了什么技术栈", { code: 1, structure: 0, tech: 1 }],
    ["请用中文总结这篇文章", { code: 0, structure: 0, tech: 0 }],
    ["作者是谁，什么时候发表的", { code: 0, structure: 0, tech: 0 }],
    ["把第二段翻译成英文", { code: 0, structure: 0, tech: 0 }],
    ["这是什么意思", { code: 0, structure: 0, tech: 0 }]
  ];
  for (const [text, want] of cases) {
    const got = await flags(text);
    assert.deepEqual([got.code, got.structure, got.tech].map(Number), [want.code, want.structure, want.tech], `intent mismatch for "${text}": ${JSON.stringify(got)}`);
  }
  ok("intent matrix (" + cases.length + " questions: code / structure / animation / none)");
  await page.evaluate(() => { const d = document.createElement("div"); d.id = "snip"; d.textContent = "const total = items.map(i => i.price).reduce((a, b) => a + b, 0);"; document.body.append(d); const r = document.createRange(); r.selectNodeContents(d); const s = getSelection(); s.removeAllRanges(); s.addRange(r); });
  await page.waitForTimeout(100);
  const sel = await flags("这是什么意思");
  assert.equal(sel.code, true); ok("explain-this with a code-looking selection counts as a code question");
  await clickChip("解释代码"); await page.waitForFunction(() => window.__ports.length >= 1);
  await page.waitForFunction(() => !window.__shadow.querySelector("#send").classList.contains("stop"), null, { timeout: 5000 });
  assert.match(await page.evaluate(() => window.__ports.at(-1).sent[0].messages.at(-1).content), /页面中的代码/); ok("explain-code chip always reads code");

  // "正在阅读并思考…" lives in the page tag (not in a chat bubble) and animates its dots
  await page.evaluate(() => { window.__script = "slow"; window.__shadow.querySelector("#question").value = "慢一点"; });
  const tag0 = await page.evaluate(() => ({ w: window.__shadow.querySelector("#pagetag").getBoundingClientRect().width, label: window.__shadow.querySelector(".tag-label").textContent, bubbles: window.__shadow.querySelectorAll("#chat .msg.assistant").length }));
  await click("#send"); await page.waitForTimeout(160);
  const think = await page.evaluate(() => { const s = window.__shadow, tag = s.querySelector("#pagetag"), d = s.querySelector("#tagdots"); return { label: s.querySelector(".tag-label").textContent, titleHidden: s.querySelector("#title").hidden, dots: !d.hidden, anim: getComputedStyle(d, "::after").animationName, w: tag.getBoundingClientRect().width, bubbles: s.querySelectorAll("#chat .msg.assistant").length, busy: tag.getAttribute("aria-busy") }; });
  assert.ok(think.label === "正在阅读并思考" && think.titleHidden && think.dots && think.anim === "dots" && think.bubbles === tag0.bubbles && think.busy === "true", JSON.stringify({ tag0, think })); ok("while waiting: the page tag reads 正在阅读并思考 with animated dots and no answer bubble yet");
  await page.waitForTimeout(220); // let the 160ms width morph finish
  const fit = await page.evaluate(() => { const s = window.__shadow, tag = s.querySelector("#pagetag"), l = s.querySelector(".tag-label").getBoundingClientRect().width, d = s.querySelector("#tagdots").getBoundingClientRect().width; return { w: tag.getBoundingClientRect().width, natural: l + d + 24 + 1, min: tag.style.minWidth, wStyle: tag.style.width, overflow: tag.scrollWidth - tag.clientWidth }; });
  assert.ok(Math.abs(fit.w - fit.natural) <= 2 && fit.min === "" && fit.wStyle === "" && fit.overflow <= 1, JSON.stringify(fit)); ok("the box fits the text: " + fit.w.toFixed(1) + "px for 正在阅读并思考… (no leftover width from the long title)");
  const breathe = await page.evaluate(async () => { const tag = window.__shadow.querySelector("#pagetag"), name = getComputedStyle(tag).animationName, seen = []; for (let i = 0; i < 16; i++) { seen.push(parseFloat(getComputedStyle(tag).opacity)); await new Promise(r => setTimeout(r, 100)); } return { name, min: Math.min(...seen), max: Math.max(...seen) }; });
  assert.ok(breathe.name === "breathe" && breathe.max > 0.9 && breathe.min < 0.55, JSON.stringify(breathe)); ok("the tag breathes while thinking (opacity swings " + breathe.min.toFixed(2) + " ↔ " + breathe.max.toFixed(2) + ")");
  const dotFrames = [];
  for (let i = 0; i < 4; i++) { dotFrames.push(await page.evaluate(() => getComputedStyle(window.__shadow.querySelector("#tagdots"), "::after").content)); await page.waitForTimeout(150); }
  assert.ok(new Set(dotFrames).size >= 2, JSON.stringify(dotFrames)); ok("the ellipsis grows and shrinks (" + dotFrames.join(" ") + ")");
  await page.waitForTimeout(250); // first token has arrived (t≈400ms), the reply is still streaming
  const streaming = await page.evaluate(() => { const s = window.__shadow; return { label: s.querySelector(".tag-label").textContent, titleHidden: s.querySelector("#title").hidden, dots: !s.querySelector("#tagdots").hidden, busy: s.querySelector("#send").classList.contains("stop"), bubble: [...s.querySelectorAll("#chat .msg.assistant")].pop().textContent }; });
  assert.ok(streaming.label === "正在阅读并思考" && streaming.titleHidden && streaming.dots && streaming.busy && streaming.bubble.includes("好的"), JSON.stringify(streaming)); ok("while the reply is still being written the tag keeps saying 正在阅读并思考… (the site title stays hidden)");
  await page.waitForFunction(() => !window.__shadow.querySelector("#send").classList.contains("stop"), null, { timeout: 5000 });
  const answered = await page.evaluate(() => { const s = window.__shadow; return { label: s.querySelector(".tag-label").textContent, titleHidden: s.querySelector("#title").hidden, dots: !s.querySelector("#tagdots").hidden, bubbles: s.querySelectorAll("#chat .msg.assistant").length, last: [...s.querySelectorAll("#chat .msg.assistant")].pop().textContent, minW: s.querySelector("#pagetag").style.minWidth }; });
  assert.ok(answered.label === "正在阅读：" && !answered.titleHidden && !answered.dots && answered.bubbles === tag0.bubbles + 1 && answered.last.includes("好的") && answered.minW === "", JSON.stringify(answered)); ok("only when the reply is complete does the tag return to 正在阅读：<title>");
  assert.equal(await page.evaluate(() => { const t = window.__shadow.querySelector("#pagetag"); return getComputedStyle(t).animationName + "/" + getComputedStyle(t).opacity; }), "none/1"); ok("…and it stops breathing, fully opaque again");
  await page.evaluate(() => { window.__script = "stream"; });

  // error path
  await page.evaluate(() => { window.__script = "error"; window.__shadow.querySelector("#question").value = "x"; });
  await click("#send");
  await page.waitForFunction(() => window.__shadow.querySelector(".msg.error"));
  assert.match(await q(".msg.error"), /API Key 无效/); ok("error bubble");

  // stop button
  await page.evaluate(() => { window.__script = "hang"; window.__shadow.querySelector("#question").value = "y"; });
  await click("#send");
  await page.waitForFunction(() => window.__shadow.querySelector("#send").classList.contains("stop"));
  assert.equal(await q("#send"), "停止"); await click("#send");
  await page.waitForFunction(() => !window.__shadow.querySelector("#send").classList.contains("stop"));
  assert.ok(await page.evaluate(() => [...window.__shadow.querySelectorAll(".meta")].some(m => /已停止/.test(m.textContent)))); ok("stop keeps partial answer");

  // clear, Esc closes, toggle
  assert.ok(await page.evaluate(() => window.__shadow.querySelectorAll("#chat .msg").length) > 0);
  await click("#clear");
  assert.equal(await page.evaluate(() => window.__shadow.querySelectorAll("#chat .msg").length), 0); ok("clear conversation (state reset immediately)");
  const fx0 = await page.evaluate(() => { const s = window.__shadow; return { layer: !!s.querySelector(".fx"), strips: s.querySelectorAll(".fx-strip").length, cavity: !!s.querySelector(".fx-cavity"), lid: !!s.querySelector(".fx-lid"), realHidden: s.querySelector("#clear").style.visibility === "hidden", sheetCoversChat: (() => { const st = s.querySelector(".fx-strip").getBoundingClientRect(), ch = s.querySelector("#chat").getBoundingClientRect(); return st.left <= ch.left && st.right >= ch.right; })() }; });
  const sheet = await page.evaluate(() => { const s = window.__shadow, r = [...s.querySelectorAll(".fx-strip")].map(e => e.getBoundingClientRect()), ch = s.querySelector("#chat").getBoundingClientRect(), comp = s.querySelector(".composer").getBoundingClientRect(); return { top: Math.min(...r.map(x => x.top)) - ch.top, bottom: Math.max(...r.map(x => x.bottom)) - ch.bottom, aboveComposer: Math.max(...r.map(x => x.bottom)) <= comp.top + 1 }; });
  assert.ok(Math.abs(sheet.top) < 3 && Math.abs(sheet.bottom) < 3 && sheet.aboveComposer, JSON.stringify(sheet)); ok("the sheet covers the conversation area only (composer excluded)");
  assert.ok(fx0.layer && fx0.strips >= 20 && fx0.cavity && fx0.lid && fx0.realHidden && fx0.sheetCoversChat, JSON.stringify(fx0)); ok("trash effect starts: one sheet cut into " + fx0.strips + " slices, black cavity, 3D lid");
  const order = await page.evaluate(() => { const k = [...window.__shadow.querySelector(".fx").children].map(n => n.className || "strips"); return k; });
  assert.deepEqual(order, ["strips", "fx-rim", "fx-cavity", "fx-lidwrap"]); ok("stacking: paper behind, then rim, opening and lid in front (paper goes into the bin)");
  const frame = await page.evaluate(() => { const s = window.__shadow, f = s.querySelector(".fx-rim").getBoundingClientRect(), c = s.querySelector(".fx-cavity").getBoundingClientRect(), l = s.querySelector(".fx-lidwrap").getBoundingClientRect(); return { rimTop: l.top - f.top, rimSide: l.left - f.left, rimSideR: f.right - l.right, cavTop: l.top - c.top, cavSide: l.left - c.left, rimBottom: f.bottom - l.bottom }; });
  assert.ok(frame.rimTop >= 1 && frame.rimSide >= 2 && frame.rimSideR >= 2 && frame.cavTop > 0 && frame.cavSide >= 1 && frame.rimBottom >= 1, JSON.stringify(frame)); ok("the lid's top edge sits inside a slightly larger frame (rim " + frame.rimSide + "px each side, " + frame.rimTop + "px above), like the reference");
  await page.waitForTimeout(380);
  const lid = await page.evaluate(() => { const l = window.__shadow.querySelector(".fx-lid"); return { t: l.style.transform, back: l.classList.contains("back"), persp: getComputedStyle(l.parentElement).perspective, origin: getComputedStyle(l).transformOrigin }; });
  const deg = parseFloat(/rotateX\(([\d.]+)deg/.exec(lid.t)[1]);
  assert.ok(deg > 40 && deg < 70 && !lid.back && lid.persp !== "none" && /^[\d.]+px 0px/.test(lid.origin), JSON.stringify(lid)); ok("lid tilts open around its top edge in perspective (" + deg + "deg, origin " + lid.origin + "; icon face still visible)");
  const red = await page.evaluate(() => { const l = window.__shadow.querySelector(".fx-lid"), r = l.querySelector(".fx-red"), cs = getComputedStyle(r); return { op: parseFloat(cs.opacity), bg: cs.backgroundImage, border: cs.borderTopColor, icon: getComputedStyle(r.querySelector(".icon")).color, base: getComputedStyle(l.querySelector(":scope > .icon")).color, size: parseFloat(getComputedStyle(r.querySelector(".icon")).width) }; });
  assert.ok(red.op > 0.95 && red.bg.includes("rgb(229, 100, 90)") && red.bg.includes("rgb(229, 95, 85)") && red.border === "rgb(218, 70, 62)", JSON.stringify(red)); ok("red cap (#e5645a→#e55f55, border #da463e) is a separate layer on the lid");
  const lip = await page.evaluate(() => { const l = window.__shadow.querySelector(".fx-lid"), b = getComputedStyle(l.querySelector(".fx-red")); return { shadow: b.boxShadow, radius: parseFloat(getComputedStyle(l).borderTopLeftRadius), rim: parseFloat(getComputedStyle(window.__shadow.querySelector(".fx-rim")).opacity) }; });
  assert.ok(lip.shadow.includes("rgb(158, 45, 40)") && lip.radius > 7 && lip.rim > 0.85, JSON.stringify(lip)); ok("lid has a darker-red thickness edge, rounder corners and the bin rim shows (like the reference recording)");
  assert.ok(Math.abs(red.size - 21) < 0.5, "lid icon size " + red.size); ok("lid icon is the same 21px as the real button (no size jump when it swaps back)");
  assert.equal(red.icon, "rgb(255, 255, 255)"); assert.equal(red.base, "rgb(140, 140, 140)"); ok("white icon on the red cap, normal grey icon underneath");
  await page.waitForFunction(() => !window.__shadow.querySelector(".fx"), null, { timeout: 4000 });
  const fx1 = await page.evaluate(() => { const s = window.__shadow; return { realVisible: s.querySelector("#clear").style.visibility === "", chatVisible: true, empty: !!s.querySelector("#empty") }; });
  assert.ok(fx1.realVisible && fx1.chatVisible && fx1.empty, JSON.stringify(fx1)); ok("effect cleans up: trash button and chat are back, empty state shown");
  await page.keyboard.press("Escape");
  assert.equal(await page.locator("#pagepilot-safari-root").count(), 0); ok("Esc closes");
  await inject(); await inject();
  assert.equal(await page.locator("#pagepilot-safari-root").count(), 0); ok("re-running toggles off");

  // settings page: opens from the gear, presets, validation, save, test, Esc order
  await inject();
  const vis = () => page.evaluate(() => window.__shadow.querySelector("#settings").classList.contains("open"));
  assert.equal(await vis(), false); ok("settings closed when a key exists (chat first)");
  await click("#gear"); await page.waitForFunction(() => window.__shadow.querySelector("#settings").classList.contains("open"));
  assert.equal(await q("#bartitle"), "设置"); assert.equal(await page.evaluate(() => window.__shadow.querySelector("#baseUrl").value), "https://api.deepseek.com"); ok("gear opens settings, loads saved values");
  await page.waitForTimeout(400); await page.screenshot({ path: path.join(root, "tests/ui-settings.png") });
  await click('[data-preset="openai"]');
  assert.equal(await page.evaluate(() => window.__shadow.querySelector("#model").value), "gpt-4o-mini"); ok("preset fills defaults");
  await page.evaluate(() => { window.__shadow.querySelector("#baseUrl").value = "http://evil.com"; }); await click("#save");
  assert.match(await q("#status"), /https/); ok("rejects plain http");
  await page.evaluate(() => { window.__shadow.querySelector("#baseUrl").value = "https://openrouter.ai/api/v1/"; window.__shadow.querySelector("#model").value = "foo/bar"; }); await click("#test");
  await page.waitForFunction(() => window.__shadow.querySelector("#status").textContent.includes("连接成功"));
  let msg = await page.evaluate(() => window.__msgs.at(-1)); assert.equal(msg.type, "PAGEPILOT_TEST"); assert.equal(msg.settings.baseUrl, "https://openrouter.ai/api/v1"); ok("test connection goes through background, URL normalised");
  await page.evaluate(() => { window.__testResult = { ok: false, error: "API Key 无效或已失效，请重新检查。" }; }); await click("#test");
  await page.waitForFunction(() => window.__shadow.querySelector("#status").classList.contains("error")); ok("test failure shown");
  await page.keyboard.press("Escape");
  assert.equal(await vis(), false); assert.equal(await page.locator("#pagepilot-safari-root").count(), 1); ok("Esc leaves settings first, panel stays");
  await click("#gear"); await click("#save"); await page.waitForFunction(() => !window.__shadow.querySelector("#settings").classList.contains("open"));
  assert.equal(await page.evaluate(() => window.__store.model), "foo/bar"); assert.equal(await page.evaluate(() => window.__store.baseUrl), "https://openrouter.ai/api/v1"); ok("save persists and returns to chat");
  await page.keyboard.press("Escape");
  await page.evaluate(() => { window.__script = "stream"; }); // earlier test left the mock in "hang" mode
  // quick questions: gear lives in the chip row (right-aligned), prompts are user editable
  await inject();
  await page.waitForFunction(() => window.__shadow.querySelector("#gear"));
  const row = await page.evaluate(() => { const s = window.__shadow, g = s.querySelector("#gear").getBoundingClientRect(), chip = s.querySelector("#chips .chip").getBoundingClientRect(), p = s.querySelector("#panel").getBoundingClientRect(); return { inBar: !!s.querySelector(".appbar #gear"), inChips: !!s.querySelector("#chips #gear"), sameRow: Math.abs((g.top + g.bottom) / 2 - (chip.top + chip.bottom) / 2) < 3, rightGap: p.right - g.right }; });
  assert.ok(!row.inBar && row.inChips && row.sameRow && row.rightGap > 8 && row.rightGap < 20, JSON.stringify(row)); const gs = await page.evaluate(() => { const s = window.__shadow, g = s.querySelector("#gear").getBoundingClientRect(), c = s.querySelector("#chips .chip").getBoundingClientRect(); return { w: g.width, h: g.height, chipH: c.height, radius: getComputedStyle(s.querySelector("#gear")).borderTopLeftRadius }; });
  assert.ok(Math.abs(gs.w - gs.h) < 0.5 && Math.abs(gs.h - gs.chipH) < 0.5 && gs.radius === "50%", JSON.stringify(gs)); ok("gear is a circle whose diameter equals the chip height (" + gs.w + "px)");
  ok("gear sits at the right end of the quick-question row, not in the top bar");
  assert.deepEqual(await chipLabels(), ["总结网页", "解释选中内容", "解释代码"]); ok("default quick questions");
  await click("#gear"); await page.waitForFunction(() => window.__shadow.querySelector("#settings").classList.contains("open"));
  assert.equal(await page.evaluate(() => window.__shadow.querySelectorAll("#quickList [data-q]").length), 16); ok("settings page lists 3 button entries + 5 menu entries (2 fields each)");
  const folded = await page.evaluate(() => { const items = [...window.__shadow.querySelectorAll("#quickList .quick-item")]; return { all: items.length, hidden: items.filter(i => i.querySelector(".quick-prompt").hidden && i.querySelector(".quick-prompt").getBoundingClientRect().height === 0).length, arrows: items.map(i => i.querySelector(".exp").getAttribute("aria-expanded")), nameVisible: items.every(i => i.querySelector(".quick-name").getBoundingClientRect().height > 40) }; });
  assert.ok(folded.hidden === folded.all && folded.arrows.every(a => a === "false") && folded.nameVisible, JSON.stringify(folded)); ok("every entry's question is hidden by default; only the name row and a round arrow button show");
  const expStyle = await page.evaluate(() => { const b = window.__shadow.querySelector(".exp"), cs = getComputedStyle(b), r = b.getBoundingClientRect(); return { round: cs.borderTopLeftRadius, w: r.width, shadow: cs.boxShadow !== "none", arrow: getComputedStyle(b.querySelector(".icon")).transform }; });
  assert.ok(expStyle.round === "50%" && expStyle.w === 30 && expStyle.shadow && expStyle.arrow === "none", JSON.stringify(expStyle)); ok("the expand button is a white round button with a soft shadow, arrow pointing down");
  await click(".exp"); await page.waitForTimeout(330);
  const opened = await page.evaluate(() => { const i = window.__shadow.querySelector(".quick-item"), b = i.querySelector(".exp"); return { open: !i.querySelector(".quick-prompt").hidden, h: i.querySelector(".quick-prompt").getBoundingClientRect().height, aria: b.getAttribute("aria-expanded"), arrow: getComputedStyle(b.querySelector(".icon")).transform }; });
  assert.ok(opened.open && opened.h > 60 && opened.aria === "true" && opened.arrow === "matrix(-1, 0, 0, -1, 0, 0)", JSON.stringify(opened)); ok("pressing it shows the question and turns the arrow upward");
  await click(".exp"); await page.waitForTimeout(260);
  assert.equal(await page.evaluate(() => window.__shadow.querySelector(".quick-item .quick-prompt").hidden), true); ok("pressing again hides it (arrow back down)");
  const setQuick = (i, label, prompt) => page.evaluate(([i, l, p]) => { const q = window.__shadow.querySelector("#quickList"); q.querySelectorAll('[data-q="label"]')[i].value = l; q.querySelectorAll('[data-q="prompt"]')[i].value = p; }, [i, label, prompt]);
  await setQuick(0, "翻译", "请把当前页面的主要内容翻译成英文");
  await setQuick(1, "", "请解释我选中的内容：\n{选中内容}");
  await setQuick(2, "查用法", "解释「{选中内容}」在这里的用法");
  await page.evaluate(() => { window.__shadow.querySelector("#quickList [data-q=prompt]").value = ""; }); await click("#save");
  assert.match(await q("#status"), /按钮 1/); assert.equal(await page.evaluate(() => window.__shadow.querySelector(".quick-item .quick-prompt").hidden), false); ok("the entry with a missing question opens itself so you can fill it in"); assert.equal(await page.evaluate(() => (window.__store.quickPrompts || [{ label: "总结网页" }])[0].label), "总结网页"); ok("label without a question is rejected, nothing saved");
  await setQuick(0, "翻译", "请把当前页面的主要内容翻译成英文"); await click("#save");
  await page.waitForFunction(() => !window.__shadow.querySelector("#settings").classList.contains("open"));
  assert.deepEqual(await chipLabels(), ["翻译", "查用法", "翻译成中文"]); ok("custom labels saved; the hidden button is gone (and, with room to spare, the first menu entry is pulled out into the row)");
  const stored = await page.evaluate(() => window.__store.quickPrompts); assert.equal(stored.length, 8); assert.equal(stored[0].prompt, "请把当前页面的主要内容翻译成英文");
  const chipSend = async label => { const n = await page.evaluate(() => window.__ports.length); await clickChip(label); await page.waitForFunction(k => window.__ports.length === k + 1, n); await page.waitForFunction(() => !window.__shadow.querySelector("#send").classList.contains("stop"), null, { timeout: 5000 }); };
  await chipSend("翻译");
  let sentQ = await page.evaluate(() => window.__ports.at(-1).sent[0].messages.at(-1).content);
  assert.ok(sentQ.startsWith("请把当前页面的主要内容翻译成英文")); ok("custom question is what gets sent");
  await page.evaluate(() => { let d = document.getElementById("snip"); if (!d) { d = document.createElement("div"); d.id = "snip"; d.textContent = "const total = items.length;"; document.body.append(d); } const r = document.createRange(); r.selectNodeContents(d); const s = getSelection(); s.removeAllRanges(); s.addRange(r); });
  await page.waitForTimeout(100);
  await chipSend("查用法");
  sentQ = await page.evaluate(() => window.__ports.at(-1).sent[0].messages.at(-1).content);
  assert.ok(sentQ.startsWith("解释「const total") && !sentQ.includes("{选中内容}")); ok("{选中内容} is replaced by the selected text");
  await click("#gear"); await page.waitForFunction(() => window.__shadow.querySelector("#settings").classList.contains("open"));
  await click("#resetQuick"); await click("#save"); await page.waitForFunction(() => !window.__shadow.querySelector("#settings").classList.contains("open"));
  assert.deepEqual(await chipLabels(), ["总结网页", "解释选中内容", "解释代码"]); ok("reset restores the defaults");
  // caterpillar track: the three chips are one rigid line that feeds out of the gear (and back in)
  const settle = () => page.evaluate(() => Promise.all([...window.__shadow.querySelectorAll(".chip-track, .chip-clip, #gear svg")].flatMap(e => e.getAnimations().map(a => a.finished.catch(() => 0)))));
  await settle();
  const centers = () => page.evaluate(() => [...window.__shadow.querySelectorAll("#chips .chip")].map(c => { const r = c.getBoundingClientRect(); return r.left + r.width / 2; }));
  const restCenters = await centers();
  await click("#gear"); await page.waitForFunction(() => window.__shadow.querySelector("#settings").classList.contains("open"));
  await page.waitForTimeout(350);
  const covered = await page.evaluate(() => { const s = window.__shadow, g = s.querySelector("#gear").getBoundingClientRect(), top = s.elementFromPoint((g.left + g.right) / 2, (g.top + g.bottom) / 2); return { top: top && (top.id || top.className || top.tagName), inSettings: !!(top && top.closest("#settings")) }; });
  assert.ok(covered.inSettings, JSON.stringify(covered)); ok("the gear is covered by the settings page (not shown on it)");
  const pulled = await page.evaluate(() => { const s = window.__shadow, g = s.querySelector("#gear").getBoundingClientRect(), t = s.querySelector(".chip-track"), left = Math.min(...[...s.querySelectorAll("#chips .chip")].map(c => c.getBoundingClientRect().left)); return { left, gearCentre: (g.left + g.right) / 2, tf: getComputedStyle(t).transform }; });
  assert.ok(pulled.left >= pulled.gearCentre, JSON.stringify(pulled)); ok("opening settings: the whole line has been pulled into the gear (nothing left of the gear's centre)");
  const closeBtn = await page.evaluate(() => { const b = window.__shadow.querySelector("#close"), cs = getComputedStyle(b); return { bg: cs.backgroundColor, bgImg: cs.backgroundImage, border: cs.borderTopWidth, shadow: cs.boxShadow, color: cs.color, stroke: getComputedStyle(b.querySelector("path")).strokeWidth }; });
  assert.ok(closeBtn.bg === "rgba(0, 0, 0, 0)" && closeBtn.bgImg === "none" && closeBtn.border === "0px" && closeBtn.shadow === "none" && closeBtn.color === "rgb(140, 140, 140)" && closeBtn.stroke === "2px", JSON.stringify(closeBtn)); ok("close button is a bare grey thin cross (no frame, not red), as in the Smartisan BottomSheet");
  const back = await page.evaluate(() => { const b = window.__shadow.querySelector("#back"), cs = getComputedStyle(b); return { bg: cs.backgroundColor, bgImg: cs.backgroundImage, border: cs.borderTopWidth, shadow: cs.boxShadow, color: cs.color }; });
  assert.ok(back.bg === "rgba(0, 0, 0, 0)" && back.bgImg === "none" && back.border === "0px" && back.shadow === "none" && back.color === "rgb(140, 140, 140)", JSON.stringify(back)); ok("settings back arrow is a bare grey icon (no frame), as in the Smartisan App Bar");
  await click("#back");
  const belt = await page.evaluate(() => { const s = window.__shadow, tr = s.querySelector(".chip-track"), cl = s.querySelector(".chip-clip"), chips = [...s.querySelectorAll("#chips .chip")], cog = s.querySelector("#gear svg"); const kf = tr.getAnimations()[0]?.effect.getKeyframes(); return { track: tr.getAnimations().length, clip: cl.getAnimations().length, chips: chips.map(c => c.getAnimations().length), cog: cog.getAnimations().length, from: kf && kf[0].transform, to: kf && kf[1].transform }; });
  assert.ok(belt.track === 1 && belt.clip === 1 && belt.cog === 1 && belt.chips.every(n => n === 0) && /^translateX\([\d.]+px\)$/.test(belt.from) && /^translateX\(0(px)?\)$/.test(belt.to), JSON.stringify(belt)); ok("back from settings: ONE track animation slides the whole line out of the gear; chips themselves do not spin");
  await page.waitForTimeout(330);
  const during = await centers();
  const gaps = (xs) => [xs[1] - xs[0], xs[2] - xs[1]].map(v => Math.round(v));
  assert.deepEqual(gaps(during), gaps(restCenters)); assert.ok(during[0] > restCenters[0] + 8, JSON.stringify({ during, restCenters })); ok("mid-slide the line is rigid (spacing unchanged) and still on its way out");
  await settle();
  const end = await centers();
  assert.ok(end.every((x, i) => Math.abs(x - restCenters[i]) < 0.6), JSON.stringify({ end, restCenters })); ok("the line ends exactly where it started");
  await page.keyboard.press("Escape");

  // blue chips (Smartisan Chip/blue) + a drop-down button that unfolds the extra quick questions as more chips, downward
  await page.keyboard.press("Escape");
  await inject(); await page.waitForFunction(() => window.__shadow.querySelector("#more"));
  const chipStyle = await page.evaluate(() => { const c = getComputedStyle(window.__shadow.querySelector("#chips .chip")); return { color: c.color, bg: c.backgroundImage, border: c.borderTopColor, radius: c.borderTopLeftRadius, h: c.height }; });
  assert.deepEqual(chipStyle, { color: "rgb(99, 147, 255)", bg: "linear-gradient(rgb(230, 239, 255), rgb(225, 236, 255))", border: "rgb(147, 178, 247)", radius: "100px", h: "30px" }); ok("quick-question chips use the light-blue Chip (#6393ff text, #e6efff→#e1ecff fill, #93b2f7 border)");
  const place = await page.evaluate(() => { const s = window.__shadow, m = s.querySelector("#more").getBoundingClientRect(), g = s.querySelector("#gear").getBoundingClientRect(); return { left: m.right <= g.left, size: m.width, same: Math.abs((m.top + m.bottom) / 2 - (g.top + g.bottom) / 2) < 1, hidden: s.querySelector("#chipsMore").hidden }; });
  assert.ok(place.left && place.size === 30 && place.same && place.hidden, JSON.stringify(place)); ok("a round drop-down button sits just left of the gear; the extra area starts collapsed");
  const emptyCentre = () => page.evaluate(() => { const r = window.__shadow.querySelector("#empty").getBoundingClientRect(); return (r.top + r.bottom) / 2; });
  const chatBefore = await page.evaluate(() => window.__shadow.querySelector("#chat").getBoundingClientRect().top);
  const emptyBefore = await emptyCentre();
  await page.evaluate(() => { window.__samples = []; const s = window.__shadow; const tick = () => { const e = s.querySelector("#empty").getBoundingClientRect(); window.__samples.push({ c: (e.top + e.bottom) / 2, t: s.querySelector("#chat").getBoundingClientRect().top }); if (window.__samples.length < 45) requestAnimationFrame(tick); }; requestAnimationFrame(tick); });
  await click("#more"); await page.waitForTimeout(300);
  const frames = await page.evaluate(() => window.__samples);
  const dev = Math.max(...frames.map(f => Math.abs(f.c - emptyBefore))), mono = frames.every((f, i) => i === 0 || f.t >= frames[i - 1].t - 0.01), moving = frames.filter(f => f.t > frames[0].t + 1).length;
  assert.ok(dev < 0.6 && mono && moving >= 5, JSON.stringify({ dev, mono, moving, n: frames.length })); ok("frame by frame (" + frames.length + " frames): the empty-state picture never leaves its place (max " + dev.toFixed(2) + "px) while the chat area moves smoothly down");
  const more = await page.evaluate(() => { const s = window.__shadow, box = s.querySelector("#chipsMore"), chips = [...box.querySelectorAll(".chip")], row = s.querySelector("#chips").getBoundingClientRect(), cs = chips.map(c => getComputedStyle(c)), rs = chips.map(c => c.getBoundingClientRect()); return { labels: chips.map(c => c.textContent), below: rs.every(r => r.top >= row.bottom), sameStyle: cs.every(c => c.color === "rgb(99, 147, 255)" && c.borderTopColor === "rgb(147, 178, 247)" && c.height === "30px" && c.borderTopLeftRadius === "100px"), rows: new Set(rs.map(r => Math.round(r.top))).size, leftAligned: Math.min(...rs.map(r => r.left)) - s.querySelector("#chips .chip").getBoundingClientRect().left, expanded: s.querySelector("#more").getAttribute("aria-expanded"), chatTop: s.querySelector("#chat").getBoundingClientRect().top, onTop: chips.every(c => { const r = c.getBoundingClientRect(); const hit = s.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return hit === c || c.contains(hit); }), pop: !!s.querySelector(".menu") }; });
  assert.deepEqual(more.labels, ["翻译成中文", "查找内容", "出测验题", "找关键数据", "改写更通俗"]);
  assert.ok(more.below && more.sameStyle && more.rows >= 2 && Math.abs(more.leftAligned) < 1 && more.expanded === "true" && !more.pop && more.onTop, JSON.stringify(more)); ok("click: the 5 extra questions unfold below as the same blue Label chips, wrapped downward, no pop-up card");
  assert.ok(more.chatTop - chatBefore >= 70, JSON.stringify({ chatBefore, now: more.chatTop })); ok("the conversation area is pushed down to make room (" + Math.round(more.chatTop - chatBefore) + "px)");
  const emptyAfter = await emptyCentre();
  assert.ok(Math.abs(emptyAfter - emptyBefore) < 1, JSON.stringify({ emptyBefore, emptyAfter })); ok("the background picture (empty state) stays exactly where it was");
  const spacing = await page.evaluate(() => { const s = window.__shadow, all = [...s.querySelectorAll("#chips .chip"), ...s.querySelectorAll("#chipsMore .chip")].map(c => c.getBoundingClientRect()); const rows = []; all.forEach(r => { const row = rows.find(x => Math.abs(x.top - r.top) < 2); row ? row.items.push(r) : rows.push({ top: r.top, bottom: r.bottom, items: [r] }); }); rows.sort((a, b) => a.top - b.top); return { vertical: rows.slice(1).map((r, i) => +(r.top - rows[i].bottom).toFixed(2)), horizontal: rows.flatMap(r => r.items.sort((a, b) => a.left - b.left).slice(1).map((it, i) => +(it.left - r.items[i].right).toFixed(1))), rowCount: rows.length }; });
  assert.ok(spacing.rowCount >= 3 && spacing.vertical.every(v => Math.abs(v - 8) < 0.6) && spacing.horizontal.every(v => Math.abs(v - 8) < 0.6), JSON.stringify(spacing)); ok("every gap between chips is the same 8px, across and between all rows " + JSON.stringify(spacing.vertical));
  await page.evaluate(() => { window.__fold = []; const s = window.__shadow; const tick = () => { const e = s.querySelector("#empty").getBoundingClientRect(); window.__fold.push((e.top + e.bottom) / 2); if (window.__fold.length < 30) requestAnimationFrame(tick); }; requestAnimationFrame(tick); });
  await page.keyboard.press("Escape");
  await page.waitForTimeout(260);
  const foldDev = await page.evaluate(b => Math.max(...window.__fold.map(c => Math.abs(c - b))), emptyBefore);
  assert.ok(foldDev < 0.6, "fold deviation " + foldDev); ok("…and while folding back it does not move either (max " + foldDev.toFixed(2) + "px)");
  assert.equal(await page.evaluate(() => window.__shadow.querySelector("#chipsMore").hidden), true); assert.ok(Math.abs((await emptyCentre()) - emptyBefore) < 1); assert.equal(await page.locator("#pagepilot-safari-root").count(), 1); ok("Esc folds the extra chips back first (panel stays)");
  await click("#more"); await page.waitForTimeout(300); await click("#more"); await page.waitForTimeout(260);
  assert.equal(await page.evaluate(() => window.__shadow.querySelector("#chipsMore").hidden), true); ok("the drop-down button toggles it");
  await click("#more"); await page.waitForTimeout(300);
  const nSent = await page.evaluate(() => window.__ports.length);
  await page.evaluate(() => [...window.__shadow.querySelectorAll("#chipsMore .chip")].find(b => b.textContent === "查找内容").click());
  await page.waitForFunction(k => window.__ports.length === k + 1, nSent);
  const menuSent = await page.evaluate(() => window.__ports.at(-1).sent[0].messages.at(-1).content);
  assert.ok(menuSent.startsWith("我对下面这个词或概念不熟悉")); ok("choosing an extra chip sends its question");
  await page.waitForTimeout(260);
  assert.equal(await page.evaluate(() => window.__shadow.querySelector("#chipsMore").hidden), true); ok("…and folds the extra chips away");
  await page.waitForFunction(() => !window.__shadow.querySelector("#send").classList.contains("stop"), null, { timeout: 5000 });
  // settings: add / delete menu entries, then the extra chips follow
  await click("#gear"); await page.waitForFunction(() => window.__shadow.querySelector("#settings").classList.contains("open"));
  await click("#addQuick");
  assert.equal(await page.evaluate(() => window.__shadow.querySelectorAll("#quickList .quick-item").length), 9);
  assert.equal(await page.evaluate(() => { const l = [...window.__shadow.querySelectorAll("#quickList .quick-item")].pop(); return !l.querySelector(".quick-prompt").hidden; }), true); ok("a newly added entry starts open");
  await page.evaluate(() => { const items = window.__shadow.querySelectorAll("#quickList .quick-item"), last = items[items.length - 1]; last.querySelector('[data-q="label"]').value = "写邮件"; last.querySelector('[data-q="prompt"]').value = "请根据网页内容起草一封回复邮件。"; items[3].querySelector(".quick-del").click(); });
  assert.equal(await page.evaluate(() => window.__shadow.querySelectorAll("#quickList .quick-item").length), 8); ok("settings: add a menu entry, delete another");
  await click("#save"); await page.waitForFunction(() => !window.__shadow.querySelector("#settings").classList.contains("open"));
  await page.evaluate(() => Promise.all([...window.__shadow.querySelectorAll(".chip-track, .chip-clip, #gear svg")].flatMap(e => e.getAnimations().map(a => a.finished.catch(() => 0)))));
  await click("#more"); await page.waitForTimeout(300);
  assert.deepEqual(await page.evaluate(() => [...window.__shadow.querySelectorAll("#chipsMore .chip")].map(b => b.textContent)), ["查找内容", "出测验题", "找关键数据", "改写更通俗", "写邮件"]); ok("the extra chips reflect the edited list");
  await page.keyboard.press("Escape");
  // lists saved before the menu existed get the default extra entries
  await page.waitForTimeout(260); await page.keyboard.press("Escape");
  await page.evaluate(() => { window.__store = { apiKey: "sk-x", baseUrl: "https://api.deepseek.com", model: "deepseek-chat", quickPrompts: [{ label: "总结", prompt: "总结" }, { label: "解释", prompt: "解释" }, { label: "代码", prompt: "代码" }] }; });
  await inject(); await page.waitForFunction(() => window.__shadow.querySelector("#more"));
  assert.equal((await extraLabels()).length, 5); ok("old 3-entry lists are upgraded with the default extra entries");
  await page.keyboard.press("Escape");
  // a saved list that still holds the retired default "提炼要点" gets the new "查找内容"
  await page.evaluate(() => { window.__store = { apiKey: "sk-x", quickVersion: 2, quickPrompts: [{ label: "A", prompt: "a" }, { label: "B", prompt: "b" }, { label: "C", prompt: "c" }, { label: "提炼要点", prompt: "请用要点列表提炼当前网页的核心信息，每条不超过 30 字。" }, { label: "自己的", prompt: "自己的问题" }] }; });
  await inject(); await page.waitForFunction(() => window.__shadow.querySelector("#more"));
  assert.deepEqual(await extraLabels(), ["查找内容", "自己的"]); ok("the retired default is swapped for 查找内容; the user's own entries are untouched");
  await page.keyboard.press("Escape");
  await page.evaluate(() => { window.__store = { apiKey: "sk-x", baseUrl: "https://api.deepseek.com", model: "deepseek-chat" }; });

  // first run: no key -> lands on settings
  await page.evaluate(() => { window.__store = {}; }); await inject();
  await page.waitForFunction(() => window.__shadow.querySelector("#settings").classList.contains("open")); ok("first run opens settings automatically");
  await page.keyboard.press("Escape"); await page.keyboard.press("Escape");

  // floating card: inset from the viewport edges with rounded corners
  await inject();
  const geo = await page.evaluate(() => { const r = document.getElementById("pagepilot-safari-root").getBoundingClientRect(); return { top: r.top, bottom: innerHeight - r.bottom, right: innerWidth - r.right, radius: getComputedStyle(window.__shadow.querySelector("#panel")).borderTopLeftRadius }; });
  assert.ok(geo.top >= 10 && geo.bottom >= 10 && geo.right >= 10, JSON.stringify(geo)); assert.equal(geo.radius, "12px"); ok("floats with margins (" + geo.top + "/" + geo.bottom + "/" + geo.right + "px) and 12px radius");
  await page.keyboard.press("Escape"); await page.keyboard.press("Escape"); // first Esc leaves the (first-run) settings page

  // resizable width: drag the left edge; 300px (3/4 of the 400px default) .. half of the page; remembered
  await page.evaluate(() => { window.__store = { apiKey: "sk-x", baseUrl: "https://api.deepseek.com", model: "deepseek-chat" }; });
  await inject(); await page.waitForFunction(() => window.__shadow.querySelector("#grip"));
  const hostW = () => page.evaluate(() => Math.round(document.getElementById("pagepilot-safari-root").getBoundingClientRect().width));
  const gripBox = () => page.evaluate(() => { const r = window.__shadow.querySelector("#grip").getBoundingClientRect(); return { x: r.left + 3, y: r.top + r.height / 2 }; });
  const dragBy = async dx => { const g = await gripBox(); await page.mouse.move(g.x, g.y); await page.mouse.down(); await page.mouse.move(g.x + dx / 2, g.y, { steps: 3 }); await page.mouse.move(g.x + dx, g.y, { steps: 3 }); await page.mouse.up(); };
  assert.equal(await hostW(), 400);
  await dragBy(-100); assert.equal(await hostW(), 500); assert.equal(await page.evaluate(() => window.__store.panelWidth), 500); ok("dragging the left edge 100px to the left widens the panel to 500px and remembers it");
  await dragBy(-2000); assert.equal(await hostW(), 640); ok("widest = half of the page (1280 / 2 = 640px)");
  await dragBy(2000); assert.equal(await hostW(), 300); ok("narrowest = 3/4 of the default width (300px)");
  await page.evaluate(() => window.__shadow.querySelector("#grip").focus());
  await page.keyboard.press("ArrowLeft"); assert.equal(await hostW(), 316); await page.keyboard.press("Home"); assert.equal(await hostW(), 400); assert.equal(await page.evaluate(() => window.__store.panelWidth), null); ok("keyboard: ← widens by 16px, Home restores 400px");
  await dragBy(-120); assert.equal(await hostW(), 520);
  await page.keyboard.press("Escape"); await inject(); await page.waitForFunction(() => window.__shadow.querySelector("#grip"));
  await page.waitForFunction(() => Math.round(document.getElementById("pagepilot-safari-root").getBoundingClientRect().width) === 520); ok("the chosen width is restored next time the panel opens");
  await page.evaluate(() => window.__shadow.querySelector("#grip").dispatchEvent(new MouseEvent("dblclick", { bubbles: true }))); assert.equal(await hostW(), 400); ok("double-click on the edge resets to 400px");
  await page.setViewportSize({ width: 900, height: 700 }); await page.waitForTimeout(100);
  await dragBy(-2000); assert.equal(await hostW(), 450); await page.setViewportSize({ width: 1280, height: 810 }); await page.evaluate(() => window.__shadow.querySelector("#grip").dispatchEvent(new MouseEvent("dblclick", { bubbles: true }))); ok("the half-of-page limit follows the window (900px page → 450px max)");
  // widening the panel pulls the extra quick questions out of the drop-down into the row, in order; narrowing puts them back
  await page.evaluate(() => window.__shadow.querySelector("#grip").dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
  await page.waitForTimeout(80);
  const split = async () => { await page.waitForTimeout(320); return page.evaluate(() => { const s = window.__shadow; return { row: [...s.querySelectorAll("#chips .chip")].map(c => c.textContent), menu: [...s.querySelectorAll("#chipsMore .chip")].map(c => c.textContent), more: s.querySelector("#more") && !s.querySelector("#more").hidden, oneLine: new Set([...s.querySelectorAll("#chips .chip")].map(c => Math.round(c.getBoundingClientRect().top))).size === 1 }; }); };
  const base = await split();
  assert.deepEqual(base.row, ["总结网页", "解释选中内容", "解释代码"]); assert.equal(base.menu.length, 5); assert.ok(base.more); ok("at the default 400px: 3 chips in the row, 5 in the drop-down");
  await dragBy(-240);
  const mid = await split();
  assert.deepEqual(mid.row, ["总结网页", "解释选中内容", "解释代码", "翻译成中文", "查找内容"]); assert.deepEqual(mid.menu, ["出测验题", "找关键数据", "改写更通俗"]); assert.ok(mid.more && mid.oneLine, JSON.stringify(mid)); ok("at 640px: the first 2 menu entries are pulled into the row (in order), 3 stay in the drop-down, still one line");
  await page.setViewportSize({ width: 1800, height: 810 }); await page.waitForTimeout(80);
  await dragBy(-2000); await page.waitForTimeout(80);
  const full = await split();
  assert.equal(full.row.length, 8); assert.equal(full.menu.length, 0); assert.equal(full.more, false); assert.ok(full.oneLine); ok("wide enough (900px): all 8 are in the row on one line and the drop-down button disappears");
  const clipped = await page.evaluate(() => { const s = window.__shadow, row = s.querySelector("#chips").getBoundingClientRect(), g = s.querySelector("#gear").getBoundingClientRect(), last = [...s.querySelectorAll("#chips .chip")].pop().getBoundingClientRect(); return last.right <= g.left - 7 && last.right <= row.right; });
  assert.ok(clipped); ok("…and nothing overlaps the gear");
  await dragBy(2000); await page.waitForTimeout(80);
  const narrowAgain = await split();
  assert.deepEqual(narrowAgain.row.length, 3); assert.equal(narrowAgain.menu.length, 5); assert.ok(narrowAgain.more); ok("narrowing puts them all back into the drop-down");
  await page.setViewportSize({ width: 1280, height: 810 });
  await page.evaluate(() => window.__shadow.querySelector("#grip").dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
  // no DOM churn while dragging: chips are only moved when the number that fits really changes
  await page.evaluate(() => window.__shadow.querySelector("#grip").dispatchEvent(new MouseEvent("dblclick", { bubbles: true }))); await page.waitForTimeout(100);
  const countMutations = async fn => { await page.evaluate(() => { window.__mut = 0; window.__mo = new MutationObserver(r => { window.__mut += r.length; }); window.__mo.observe(window.__shadow, { childList: true, subtree: true }); }); await fn(); await page.waitForTimeout(120); return page.evaluate(() => { window.__mo.takeRecords(); window.__mo.disconnect(); return window.__mut; }); };
  const churn1 = await countMutations(() => dragBy(-60));
  assert.equal(churn1, 0, "mutations while dragging 400→460px: " + churn1); ok("dragging 400 → 460px (same number of chips fit): 0 DOM mutations");
  await dragBy(-180); await page.waitForTimeout(320);
  const churn2 = await countMutations(async () => { await dragBy(20); await dragBy(-10); });
  assert.equal(churn2, 0, "mutations while dragging 640→650→640px: " + churn2); ok("dragging around 640px with 2 pulled-out chips: 0 DOM mutations (their slide-in is never restarted)");
  const churn3 = await countMutations(() => dragBy(220));
  assert.ok(churn3 > 0 && churn3 <= 12, "mutations on the way back to 400: " + churn3); ok("narrowing back only moves the chips that really leave (" + churn3 + " DOM mutations in total)");
  await page.evaluate(() => window.__shadow.querySelector("#grip").dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
  // the click itself must be cheap: one layout (the final one) for unfolding and for folding
  await page.keyboard.press("Escape"); await page.waitForTimeout(100);
  await page.evaluate(() => { window.__shadow.querySelector("#grip").dispatchEvent(new MouseEvent("dblclick", { bubbles: true })); window.__store = { apiKey: "sk-x", baseUrl: "https://api.deepseek.com", model: "deepseek-chat" }; });
  await inject(); await page.waitForFunction(() => window.__shadow.querySelector("#more"));
  const cdp = await page.context().newCDPSession(page); await cdp.send("Performance.enable");
  const layouts = async () => (await cdp.send("Performance.getMetrics")).metrics.find(m => m.name === "LayoutCount").value;
  await page.waitForTimeout(500);
  let l0 = await layouts(); await click("#more"); await page.waitForTimeout(30); const expandLayouts = (await layouts()) - l0;
  await page.waitForTimeout(400);
  l0 = await layouts(); await click("#more"); await page.waitForTimeout(30); const foldLayouts = (await layouts()) - l0;
  assert.ok(expandLayouts <= 2 && foldLayouts <= 1, JSON.stringify({ expandLayouts, foldLayouts })); ok("clicking the arrow costs " + expandLayouts + " layouts to unfold and " + foldLayouts + " to fold (the final one, then transforms only; the height-driven version needed 13-17)");
  await page.waitForTimeout(300);
  const promoted = await page.evaluate(() => getComputedStyle(window.__shadow.querySelector("#chat")).willChange);
  assert.equal(promoted, "transform"); ok("the conversation layer is pre-promoted (will-change: transform), so the first animated frame needs no layer set-up");
  // the extra chips slide away and STAY away: no snap-back for a frame before the area is hidden
  await page.waitForTimeout(300);
  await click("#more"); await page.waitForTimeout(350);
  const slideFrames = await page.evaluate(() => new Promise(resolve => { const s = window.__shadow, chip = s.querySelector("#chipsMore .chip"), t = []; const before = chip.getBoundingClientRect().top; const tick = () => { const r = chip.getBoundingClientRect(); t.push(r.height ? r.top - before : null); if (t.length < 30) requestAnimationFrame(tick); else resolve(t); }; s.querySelector("#more").click(); requestAnimationFrame(tick); }));
  let rebound = 0, last = 0; slideFrames.forEach(v => { if (v === null) return; if (v > last + 0.5) rebound = Math.max(rebound, v - last); last = v; });
  assert.ok(rebound < 1, "rebound " + rebound + " frames " + slideFrames.join(" ")); ok("folding: the chips only ever move up and away (largest snap-back " + rebound.toFixed(1) + "px); before the fix they jumped back 75px for 2 frames");
  await page.waitForTimeout(300);
  assert.equal(await page.evaluate(() => window.__shadow.querySelector("#chipsMore").hidden), true);
  await click("#more"); await page.waitForTimeout(350);
  assert.equal(await page.evaluate(() => window.__shadow.querySelector("#chipsMore").hidden), false); ok("and the next unfold starts clean");
  await click("#more"); await page.waitForTimeout(350);
  const edge = await page.evaluate(() => { const s = window.__shadow, chat = s.querySelector("#chat").getBoundingClientRect(), chips = Math.max(...[...s.querySelectorAll("#chips .chip")].map(c => c.getBoundingClientRect().bottom)); return chat.top - chips; });
  assert.ok(edge >= 13, "gap " + edge); ok("the conversation's scroll edge sits " + edge.toFixed(0) + "px under the quick-question row (was 4px)");
  await page.keyboard.press("Escape"); await page.evaluate(() => { window.__store = { apiKey: "sk-x", baseUrl: "https://api.deepseek.com", model: "deepseek-chat" }; });

  // narrow viewport
  await page.setViewportSize({ width: 375, height: 700 }); await inject();
  const w = await page.evaluate(() => document.getElementById("pagepilot-safari-root").getBoundingClientRect().width);
  assert.ok(w <= 375); await page.screenshot({ path: path.join(root, "tests/ui-narrow.png") }); ok("fits narrow viewport (" + w + "px)");

  assert.deepEqual(errors, [], "page errors: " + errors.join("; "));
  console.log("\nPASS: UI tests"); await browser.close();
})().catch(e => { console.error("FAIL:", e.message); process.exit(1); });
