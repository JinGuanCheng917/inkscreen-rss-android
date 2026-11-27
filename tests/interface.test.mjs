import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { chromium } from 'playwright';

let server, browser, origin;
const feed = '<?xml version="1.0"?><rss><channel><item><pubDate>Fri, 27 Nov 2026 08:00:00 GMT</pubDate><description>第一条测试新闻；第二条测试新闻；第三条测试新闻</description></item></channel></rss>';
before(async () => {
  await fs.mkdir('test-results', {recursive:true});
  server = http.createServer(async (request, response) => {
    const name = request.url === '/' ? 'index.html' : request.url.slice(1).split('?')[0];
    const target = path.resolve('app/src/main/assets', name);
    if (!target.startsWith(path.resolve('app/src/main/assets') + path.sep)) { response.writeHead(403).end(); return; }
    try {
      const data = await fs.readFile(target);
      const type = name.endsWith('.js') ? 'application/javascript' : name.endsWith('.css') ? 'text/css' : 'text/html';
      response.writeHead(200, {'Content-Type':type + '; charset=utf-8'}); response.end(data);
    } catch { response.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = 'http://127.0.0.1:' + server.address().port;
  browser = await chromium.launch({headless:true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || (process.platform === 'win32' ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : undefined)});
});
after(async () => { if (browser) await browser.close(); if (server) await new Promise(resolve => server.close(resolve)); });

async function open(options = {}) {
  const context = await browser.newContext({viewport:{width:360,height:800}, deviceScaleFactor:1});
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(({options, feed}) => {
    window.__mock = {online:false, maxPayload:20, feed, calls:[], writes:[], rssCount:0, instance:Math.random(), ...options};
    localStorage.setItem('epd.one.ui.v2', JSON.stringify({title:'保留标题', body:'保留文字\n第二行', rssEnabled:true}));
    window.InkNative = {postMessage(text) {
      const request = JSON.parse(text);
      const mock = window.__mock;
      mock.calls.push(request.method);
      const reply = result => window.InkNative.onmessage({data:JSON.stringify({id:request.id, result})});
      const reject = (code, message) => window.InkNative.onmessage({data:JSON.stringify({id:request.id, error:{code,message}})});
      queueMicrotask(() => {
        if (request.method === 'network') reply({online:mock.online});
        else if (request.method === 'connectLast' || request.method === 'lastDevice') reject('no_device', '首次使用请连接');
        else if (request.method === 'selectConnect') reply({id:'AA:BB:CC:DD:EE:FF',name:'NRF-测试',control:true,maxPayload:mock.maxPayload});
        else if (request.method === 'write') { mock.writes.push(request.params); if(mock.onWrite) mock.onWrite(request.params); reply({}); }
        else if (request.method === 'disconnect') { window.InkNative.onmessage({data:JSON.stringify({event:'disconnected',data:{}})}); reply({}); }
        else if (request.method === 'rss') {
          mock.rssCount++;
          setTimeout(() => mock.rssError ? reject('rss_failed', mock.rssError) : reply({text:mock.feed}), mock.rssDelay || 0);
        }
      });
    }};
  }, {options,feed});
  await page.goto(origin);
  await page.waitForFunction(() => window.materialButtons && document.querySelector('#btnRefresh.MuiButton-root'));
  await page.waitForFunction(() => !document.querySelector('#btnRefresh').disabled);
  return {context,page,errors};
}

test('offline launch skips every RSS request and keeps editable content and visible refresh', async () => {
  const {context,page,errors} = await open();
  try {
    assert.equal(await page.inputValue('#bodyInput'), '保留文字\n第二行');
    assert.equal(await page.evaluate(() => window.__mock.rssCount), 0);
    assert.match(await page.textContent('#rssStatus'), /跳过 RSS/);
    await page.locator('#bodyInput').fill('离线仍可编辑');
    const instance = await page.evaluate(() => window.__mock.instance);
    await page.locator('#btnRefresh').click();
    await page.waitForFunction(() => !document.querySelector('#btnRefresh').disabled);
    assert.equal(await page.evaluate(() => window.__mock.instance), instance);
    assert.equal(await page.inputValue('#bodyInput'), '离线仍可编辑');
    assert.equal(await page.evaluate(() => window.__mock.rssCount), 0);
    await page.screenshot({path:'test-results/mobile-offline.png'});
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
    assert.equal(overflow, false);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test('request failure keeps the draft; refresh after network recovery succeeds without reload or BLE disconnect', async () => {
  const {context,page,errors} = await open();
  try {
    const instance = await page.evaluate(() => window.__mock.instance);
    await page.locator('#btnConnect').click();
    await page.waitForFunction(() => document.querySelector('#connText').textContent === '已连接');
    await page.evaluate(() => { window.__mock.online = true; window.__mock.rssError = 'RSS 请求超时'; });
    await page.locator('#btnRefresh').click();
    await page.waitForFunction(() => !document.querySelector('#btnRefresh').disabled);
    assert.equal(await page.inputValue('#bodyInput'), '保留文字\n第二行');
    assert.match(await page.textContent('#rssStatus'), /保留当前文字/);
    await page.evaluate(() => { window.__mock.rssError = null; });
    await page.locator('#btnRefresh').click();
    await page.waitForFunction(() => !document.querySelector('#btnRefresh').disabled);
    assert.equal(await page.inputValue('#bodyInput'), '第一条测试新闻\n第二条测试新闻\n第三条测试新闻');
    assert.equal(await page.evaluate(() => window.__mock.instance), instance);
    assert.equal(await page.evaluate(() => window.__mock.calls.includes('disconnect')), false);
    assert.equal(await page.textContent('#connText'), '已连接');
    await page.screenshot({path:'test-results/mobile-online.png'});
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test('RSS finishing after a manual edit never overwrites that edit', async () => {
  const {context,page} = await open();
  try {
    await page.evaluate(() => { window.__mock.online = true; window.__mock.rssDelay = 350; });
    await page.locator('#btnRefresh').click();
    await page.locator('#bodyInput').fill('获取过程中输入的新文字');
    await page.waitForFunction(() => !document.querySelector('#btnRefresh').disabled);
    assert.equal(await page.inputValue('#bodyInput'), '获取过程中输入的新文字');
    assert.match(await page.textContent('#rssStatus'), /已保留编辑/);
  } finally { await context.close(); }
});

for (const maxPayload of [20, 244]) test('BLE packet offsets and canvas bytes survive max payload ' + maxPayload, async () => {
  const {context,page,errors} = await open({maxPayload});
  try {
    await page.locator('#screenSelect').selectOption('2.13');
    await page.locator('#btnConnect').click();
    await page.waitForFunction(() => document.querySelector('#connText').textContent === '已连接');
    const expected = await page.evaluate(() => bytesToHex(canvas2bytesRot(fb, 'bw')));
    await page.locator('#btnUpload').click();
    await page.waitForFunction(() => !document.querySelector('#btnUpload').disabled, null, {timeout:15000});
    const writes = await page.evaluate(() => window.__mock.writes);
    assert.equal(writes.at(-1).hex, '01');
    let bytes = 0, assembled = '';
    for (const write of writes.slice(0, -1)) {
      assert.equal(write.channel, 'image');
      assert.ok(write.hex.length / 2 <= maxPayload);
      assert.equal(write.hex.slice(0,4), '03ff');
      assert.equal(parseInt(write.hex.slice(4,8),16), bytes);
      bytes += (write.hex.length - 8) / 2;
      assembled += write.hex.slice(8);
    }
    assert.equal(assembled, expected);
    assert.equal(bytes, 212 * 128 / 8);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test('malformed RSS is skipped and the app stays usable', async () => {
  const {context,page,errors} = await open({online:true,feed:'not xml'});
  try {
    assert.equal(await page.inputValue('#bodyInput'), '保留文字\n第二行');
    assert.match(await page.textContent('#rssStatus'), /已跳过/);
    await page.locator('#rssSwitch').uncheck();
    await page.locator('#btnRefresh').click();
    assert.equal(await page.inputValue('#bodyInput'), '保留文字\n第二行');
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test('editing during two-plane upload keeps both transmitted planes from the same preview', async () => {
  const {context,page,errors} = await open();
  try {
    await page.locator('#screenSelect').selectOption('4.2small');
    await page.locator('#btnConnect').click();
    await page.waitForFunction(() => document.querySelector('#connText').textContent === '已连接');
    const expected = await page.evaluate(() => ({bw:bytesToHex(canvas2bytesRow(fb,'bw')),red:bytesToHex(canvas2bytesRow(fb,'bwr'))}));
    await page.evaluate(() => { window.__mock.onWrite = () => { window.__mock.onWrite = null; state.body = '上传中改字'; renderFramebuffer(); }; });
    await page.locator('#btnUpload').click();
    await page.waitForFunction(() => !document.querySelector('#btnUpload').disabled, null, {timeout:15000});
    const writes = await page.evaluate(() => window.__mock.writes);
    assert.equal(writes.at(-1).hex, 'aa');
    const assembled = prefix => writes.filter(x=>x.hex.startsWith(prefix)).map(x=>x.hex.slice(8)).join('');
    assert.equal(assembled('04ff'),expected.bw);
    assert.equal(assembled('0400'),expected.red);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});
