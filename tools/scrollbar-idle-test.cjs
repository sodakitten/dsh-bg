// Browser behavior checks for the native conversation scrollbar. Requires
// Playwright on NODE_PATH; DSH_TEST_BROWSER_CHANNEL defaults to Windows Edge.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const source = fs.readFileSync(path.join(__dirname, '..', 'framing.js'), 'utf8');
const storageKey = 'dsh-bg-crop/settings/v1';
// DSH 0.2.0-rc.2 ui-theme scrollbar contract: paint via elevation tokens,
// transparent track, content-box thumb, and an unchanged reserved gutter.
const nativeCss = `
body{--dsh-scrollbar-width:10px;--dsh-scrollbar-thumb-border:2px;
 --dsh-scrollbar-thumb:rgb(120,120,120);--dsh-scrollbar-thumb-hover:rgb(90,90,90)}
::-webkit-scrollbar{width:var(--dsh-scrollbar-width);height:var(--dsh-scrollbar-width)}
::-webkit-scrollbar-track{margin-block:2px;background:transparent}
::-webkit-scrollbar-thumb{border:var(--dsh-scrollbar-thumb-border) solid transparent;
 background:var(--dsh-scrollbar-thumb);background-clip:content-box;border-radius:999px}
::-webkit-scrollbar-thumb:hover{background-color:var(--dsh-scrollbar-thumb-hover)}
::-webkit-scrollbar-corner{background:transparent}`;
const server = http.createServer((req, res) => {
  if (req.url.startsWith('/__beauticode/')) {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ ok: true, identity: null, themes: [], groups: [], muted: true }));
    return;
  }
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.end(`<!doctype html><html><head><style>${nativeCss}
  body{margin:0;font:14px sans-serif}#root{width:600px}
  .native_scrollBody{height:180px;overflow-y:auto;scrollbar-gutter:stable}
  #transcript{height:1400px}#code{width:100px;height:40px;overflow:auto}
  #beauticode-console-page{margin:20px;width:950px}.bc-row{display:flex;justify-content:space-between}
  .bc-row-text{display:flex;flex-direction:column}.bc-control{display:flex;align-items:center}
  </style></head><body><div id="root"><div id="conversation" class="native_scrollBody" tabindex="0">
  <div id="transcript">Conversation<div id="code"><div style="height:300px">Code</div></div></div>
  </div></div><div id="beauticode-console-page"><div class="bc-group"></div></div>
  <script>${source}</script></body></html>`);
});

(async () => {
  server.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const browser = await chromium.launch({ channel: process.env.DSH_TEST_BROWSER_CHANNEL || 'msedge', headless: true, ignoreDefaultArgs: ['--hide-scrollbars'] });
  const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  let checks = 0;
  const check = (value, message) => { assert(value, message); checks++; console.log('PASS ' + message); };
  const state = () => page.evaluate(() => document.documentElement.dataset.bgcScrollbars);
  const snapshot = () => page.locator('#conversation').evaluate(el => ({
    color: getComputedStyle(el, '::-webkit-scrollbar-thumb').backgroundColor,
    width: getComputedStyle(el, '::-webkit-scrollbar').width,
    gutter: getComputedStyle(el).scrollbarGutter,
    clientWidth: el.clientWidth, scrollTop: el.scrollTop,
    code: getComputedStyle(document.getElementById('code'), '::-webkit-scrollbar-thumb').backgroundColor,
  }));
  const delay = page.getByRole('slider', { name: '滚动条隐藏等待', exact: true });
  const toggle = page.getByRole('button', { name: '会话滚动条自动隐藏', exact: true });
  const setDelay = value => delay.evaluate((el, value) => {
    el.value = String(value); el.dispatchEvent(new Event('input', { bubbles: true }));
  }, value);
  try {
    await page.clock.install();
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.clock.runFor(300);
    check(await toggle.getAttribute('aria-pressed') === 'false' && await delay.inputValue() === '2' && await delay.isDisabled(), 'first load defaults to disabled, with 2-second waiting time');
    await page.clock.runFor(4000);
    check(await state() === undefined, 'default leaves native scrollbar behavior untouched');
    await toggle.click();
    const visible = await snapshot();
    await page.clock.runFor(2200);
    const hidden = await snapshot();
    check(hidden.color === 'rgba(0, 0, 0, 0)', 'idle scrollbar thumb becomes transparent');
    check(hidden.width === visible.width && hidden.gutter === visible.gutter && hidden.clientWidth === visible.clientWidth, 'hiding preserves scrollbar width, gutter and transcript geometry');
    check(hidden.code === visible.code && hidden.code !== hidden.color, 'inner code scrollbar retains native color');

    await page.mouse.move(300, 100);
    await page.clock.runFor(30);
    check(await state() === 'visible' && ['rgb(120, 120, 120)', 'rgb(90, 90, 90)'].includes((await snapshot()).color), 'pointer movement immediately restores native paint');
    await page.clock.runFor(1200);
    await page.mouse.move(320, 100);
    await page.clock.runFor(1200);
    check(await state() === 'visible', 'new activity extends the idle deadline');
    await page.clock.runFor(900);
    check(await state() === 'hidden', 'stationary pointer hides again after the configured delay');

    await page.mouse.wheel(0, 150);
    // Wheel delivery is queued by Chromium's compositor, unlike key dispatch.
    await page.waitForTimeout(80);
    await page.clock.runFor(30);
    check(await state() === 'visible', 'wheel input restores the scrollbar');
    await page.clock.runFor(2200);
    await page.keyboard.press('ArrowDown');
    await page.clock.runFor(30);
    check(await state() === 'visible', 'keyboard input restores the scrollbar');

    await page.mouse.move(300, 100);
    await page.mouse.down();
    await page.waitForTimeout(80);
    await page.clock.runFor(4000);
    check(await state() === 'visible', 'pressed pointer remains visible during a drag pause');
    await page.mouse.up();
    await page.waitForTimeout(80);
    await page.clock.runFor(2200);
    check(await state() === 'hidden', 'release restarts the idle countdown');

    const idleTop = (await snapshot()).scrollTop;
    await page.evaluate(() => {
      const p = document.createElement('p'); p.textContent = 'Streamed output';
      document.getElementById('transcript').append(p);
      document.getElementById('conversation').scrollTop += 30;
    });
    await page.clock.runFor(300);
    check(await state() === 'hidden' && (await snapshot()).scrollTop > idleTop, 'streaming and programmatic scrolling do not reveal an idle scrollbar');

    await setDelay(5);
    await page.mouse.move(330, 110);
    await page.clock.runFor(4500);
    check(await state() === 'visible', 'changed delay takes effect immediately');
    await page.clock.runFor(800);
    check(await state() === 'hidden', 'changed 5-second deadline hides the thumb');
    await toggle.click();
    check(await state() === undefined && await delay.isDisabled(), 'switch off restores native behavior and disables delay control');
    await page.clock.runFor(31000);
    check((await snapshot()).color === visible.color, 'disabled feature leaves no timer hiding native scrollbars');
    check(await page.evaluate(key => JSON.parse(localStorage.getItem(key)).scrollbarIdleSeconds, storageKey) === 5, 'switch off retains the selected waiting time');
    await page.reload();
    await page.clock.runFor(300);
    check(await toggle.getAttribute('aria-pressed') === 'false' && await delay.inputValue() === '5', 'switch and waiting time survive reload');
    await toggle.click();
    await page.getByRole('button', { name: '恢复默认滚动条隐藏等待', exact: true }).click();
    check(await delay.inputValue() === '2' && await delay.getAttribute('aria-valuetext') === '2 秒', 'reset and accessible value both use the 2-second default');

    for (const value of [-100, 100]) {
      await page.evaluate(({ key, value }) => localStorage.setItem(key, JSON.stringify({ scrollbarIdleSeconds: value })), { key: storageKey, value });
      await page.reload(); await page.clock.runFor(300);
      check(await delay.inputValue() === (value < 0 ? '1' : '30'), 'saved out-of-range delay clamps to ' + (value < 0 ? '1' : '30'));
    }
    await page.evaluate(key => localStorage.setItem(key, JSON.stringify({ scrollbarIdleSeconds: null })), storageKey);
    await page.reload(); await page.clock.runFor(300);
    check(await delay.inputValue() === '2', 'invalid saved delay falls back to 2 seconds');
    await toggle.click();
    const nativeBox = await page.locator('#conversation').boundingBox();
    await page.mouse.move(nativeBox.x + nativeBox.width - 5, nativeBox.y + 12);
    await page.mouse.down();
    await page.waitForTimeout(80);
    await page.clock.runFor(4000);
    check((await snapshot()).color !== 'rgba(0, 0, 0, 0)', 'native thumb stays painted while held beyond the timeout');
    await page.mouse.move(nativeBox.x + nativeBox.width - 5, nativeBox.y + 65);
    await page.waitForTimeout(80);
    check((await snapshot()).scrollTop > 0, 'native scrollbar dragging still scrolls the conversation');
    await page.mouse.up();
    await page.mouse.move(300, 100);
    await page.clock.runFor(2200);
    check(await state() === 'hidden', 'native drag release does not leave an idle timer stuck');
    check(pageErrors.length === 0, 'client script has no runtime errors: ' + JSON.stringify(pageErrors));
    console.log(checks + ' scrollbar behavior checks passed.');
  } finally {
    await browser.close(); server.close();
  }
})().catch(error => { console.error(error); server.close(); process.exitCode = 1; });
