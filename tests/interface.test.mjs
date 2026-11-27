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
  const context = await browser.newContext({viewport:options.viewport || {width:360,height:800}, deviceScaleFactor:1});
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(({options, feed}) => {
    window.__mock = {online:false, maxPayload:20, protocol:'legacy', version:0, configHex:'', control:true, name:'NRF-测试', feed, calls:[], writes:[], rssCount:0, instance:Math.random(), ...options};
    window.__notifyNative = hex => window.InkNative.onmessage({data:JSON.stringify({event:'notification',data:hex})});
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
        else if (request.method === 'selectConnect') {
          if (mock.beforeConnectNotificationHex) window.__notifyNative(mock.beforeConnectNotificationHex);
          reply({id:'AA:BB:CC:DD:EE:FF',name:mock.name,protocol:mock.protocol,version:mock.version,configHex:mock.configHex || mock.beforeConnectNotificationHex || '',control:mock.control,maxPayload:mock.maxPayload});
          if (mock.afterConnectNotificationHex) setTimeout(() => window.__notifyNative(mock.afterConnectNotificationHex), 25);
        }
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

async function connect(page) {
  await page.locator('#btnConnect').click();
  await page.waitForFunction(() => connected && !connectionBusy);
}
const driverConfig = driver => '00010203040506' + driver.toString(16).padStart(2, '0');
const nrfOptions = (version, driver, extra = {}) => ({protocol:'nrf',version,control:false,name:'NRF_EPD_测试',configHex:driver == null ? '' : driverConfig(driver),...extra});

// Independent vector: white, black, red, black, white, black, red, white in every row.
// Planes: 0xab (black), 0xdd (red); four-color pixels: 30 40 30 43.
async function uploadPattern(page) {
  return page.evaluate(async () => {
    fb.width = 8; fb.height = 20;
    const ctx = fb.getContext('2d');
    const pixels = ctx.createImageData(8, 20);
    const colors = [[255,255,255],[0,0,0],[255,0,0],[0,0,0],[255,255,255],[0,0,0],[255,0,0],[255,255,255]];
    for (let y = 0; y < 20; y++) for (let x = 0; x < 8; x++) pixels.data.set([...colors[x],255], (y * 8 + x) * 4);
    ctx.putImageData(pixels, 0, 0);
    await uploadNrfImage({id:'test-vector',planes:['bw','bwr']});
    return window.__mock.writes;
  });
}

for (const driver of [2,5]) test('NRF unreadable-version fallback uses old commands and correct red polarity, driver ' + driver, async () => {
  const {context,page,errors} = await open(nrfOptions(0,driver));
  try {
    await connect(page);
    const writes = await uploadPattern(page);
    assert.ok(writes.every(write => write.channel === 'image' && write.hex.length <= 40));
    assert.deepEqual(writes.map(write => write.hex), [
      '01', driver === 2 ? '0324' : '0310', '04' + 'ab'.repeat(19), '04ab',
      driver === 2 ? '0326' : '0313', '04' + '22'.repeat(19), '0422', '05'
    ]);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

for (const version of [0x16,0x1a]) test('NRF firmware 0x' + version.toString(16) + ' uses the matching uncompressed packet flags', async () => {
  const {context,page,errors} = await open(nrfOptions(version,3));
  try {
    await connect(page);
    const writes = await uploadPattern(page);
    const flags = version === 0x16 ? ['0f','ff','00','f0'] : ['02','00','03','01'];
    assert.ok(writes.every(write => write.channel === 'image' && write.hex.length <= 40));
    assert.deepEqual(writes.map(write => write.hex), [
      '01', '30' + flags[0] + 'ab'.repeat(18), '30' + flags[1] + 'abab',
      '30' + flags[2] + 'dd'.repeat(18), '30' + flags[3] + 'dddd', '05'
    ]);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

for (const driver of [0x08,0x09,0x0e,0x0f]) test('NRF four-color driver 0x' + driver.toString(16) + ' packs color nibbles into one plane', async () => {
  const {context,page,errors} = await open(nrfOptions(0x1a,driver));
  try {
    await connect(page);
    const writes = await uploadPattern(page);
    assert.equal(writes[0].hex,'01');
    assert.equal(writes.at(-1).hex,'05');
    const data = writes.slice(1,-1);
    assert.equal(data.length,5);
    assert.equal(data[0].hex.slice(0,4),'3002');
    assert.ok(data.slice(1).every(write => write.hex.startsWith('3000')));
    assert.equal(data.map(write => write.hex.slice(4)).join(''),'30403043'.repeat(20));
    assert.ok(writes.every(write => write.channel === 'image' && write.hex.length <= 40));
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test('a configuration notification received before native connect resolves survives through the cached result', async () => {
  const {context,page,errors} = await open(nrfOptions(0x16,null,{beforeConnectNotificationHex:driverConfig(3)}));
  try {
    await connect(page);
    assert.deepEqual(await page.evaluate(() => ({protocol:bleProtocol,version:nrfVersion,driver:nrfDriver,expecting:nrfExpectConfig})), {protocol:'nrf',version:0x16,driver:3,expecting:false});
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test('a configuration notification arriving after connect initializes the driver without confusing text replies', async () => {
  const {context,page,errors} = await open(nrfOptions(0x16,null,{afterConnectNotificationHex:driverConfig(3)}));
  try {
    await connect(page);
    await page.waitForFunction(() => nrfDriver === 3);
    await page.evaluate(() => window.__notifyNative('743d31373935373939393939')); // t=1795799999
    assert.equal(await page.evaluate(() => nrfDriver),3);
    assert.equal(await page.evaluate(() => nrfExpectConfig),false);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test('NRF capability notifications override version-based flag selection before image packets start', async () => {
  const {context,page,errors} = await open(nrfOptions(0x16,3));
  try {
    await connect(page);
    await page.evaluate(() => {
      window.__mock.onWrite = write => {
        if (write.hex === '01') window.__notifyNative('6d74753d323020726c653d31'); // mtu=20 rle=1
      };
    });
    const writes = await uploadPattern(page);
    assert.equal(writes[1].hex.slice(0,4),'3002');
    assert.equal(writes[2].hex.slice(0,4),'3000');
    assert.equal(writes[3].hex.slice(0,4),'3003');
    assert.equal(writes[4].hex.slice(0,4),'3001');
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test('NRF upload refuses to send any bytes until a screen driver is known', async () => {
  const {context,page,errors} = await open(nrfOptions(0x1a,null));
  try {
    await connect(page);
    await page.locator('#btnUpload').click();
    await page.waitForFunction(() => !uploading);
    assert.equal(await page.evaluate(() => window.__mock.writes.length),0);
    assert.match(await page.textContent('#log'),/尚未读取到屏幕驱动/);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

for (const profile of [{protocol:'legacy',control:true},{protocol:'legacy',control:false},{protocol:'nrf',control:false}]) test('control availability matches ' + profile.protocol + ' with control=' + profile.control, async () => {
  const {context,page,errors} = await open({...profile,version:0x16,configHex:driverConfig(3)});
  try {
    await connect(page);
    await page.locator('.utility-trigger[data-panel="ctrlCard"]:visible').first().click();
    assert.equal(await page.locator('#btnSetTime').isEnabled(),profile.control || profile.protocol === 'nrf');
    for (const id of ['btnSleepOn','btnSleepOff','btnLut','btnChePai']) assert.equal(await page.locator('#'+id).isEnabled(),profile.control,id);
    const buttons = await page.locator('.chip[data-cmd]').evaluateAll(nodes => nodes.map(node => ({cmd:node.dataset.cmd.toLowerCase(),disabled:node.disabled})));
    for (const button of buttons) assert.equal(!button.disabled,profile.protocol === 'nrf' ? ['e100','e101','e102','e2'].includes(button.cmd) : profile.control,button.cmd);
    if (profile.protocol === 'nrf') {
      await page.locator('.chip[data-cmd="E2"]').click();
      await page.waitForFunction(() => !controlBusy);
      assert.deepEqual(await page.evaluate(() => window.__mock.writes),[{channel:'image',hex:'05'}]);
      const before = Math.floor(Date.now()/1000);
      await page.locator('.chip[data-cmd="e102"]').click();
      await page.waitForFunction(() => !controlBusy);
      const time = (await page.evaluate(() => window.__mock.writes)).at(-1);
      assert.equal(time.channel,'image');
      assert.equal(time.hex.slice(0,2),'20');
      assert.equal(time.hex.length,14);
      assert.equal(time.hex.slice(-2),'02');
      const timestamp = parseInt(time.hex.slice(2,10),16);
      assert.ok(timestamp >= before && timestamp <= Math.floor(Date.now()/1000));
    } else if (profile.control) {
      await page.locator('.chip[data-cmd="e102"]').click();
      await page.waitForFunction(() => !controlBusy);
      assert.deepEqual(await page.evaluate(() => window.__mock.writes),[{channel:'control',hex:'e102'},{channel:'control',hex:'e2'}]);
    }
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test('desktop tools switch in the side menu and close through Escape, close button, and backdrop', async () => {
  const {context,page,errors} = await open({viewport:{width:1440,height:900}});
  try {
    assert.equal(await page.locator('#utilityPanel').isVisible(),false);
    const controller = page.locator('.sidenav .utility-trigger[data-panel="ctrlCard"]');
    const logs = page.locator('.sidenav .utility-trigger[data-panel="logCard"]');
    await controller.click();
    assert.equal(await page.locator('#ctrlCard').isVisible(),true);
    assert.equal(await page.locator('#logCard').isVisible(),false);
    assert.equal(await controller.getAttribute('aria-expanded'),'true');
    await logs.click();
    assert.equal(await page.locator('#ctrlCard').isVisible(),false);
    assert.equal(await page.locator('#logCard').isVisible(),true);
    assert.equal(await controller.getAttribute('aria-expanded'),'false');
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#utilityPanel').isVisible(),false);
    assert.equal(await logs.evaluate(node => node === document.activeElement),true);
    await controller.click();
    await page.locator('#ctrlCard [data-close-panel]').click();
    assert.equal(await page.locator('#utilityPanel').isVisible(),false);
    await logs.click();
    await page.locator('#utilityBackdrop').click({position:{x:1100,y:400}});
    assert.equal(await page.locator('#utilityPanel').isVisible(),false);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

for (const viewport of [{width:320,height:568},{width:390,height:844}]) test('six text lines and mobile tools stay usable without overlap at ' + viewport.width + 'px', async () => {
  const {context,page,errors} = await open({viewport});
  try {
    await page.locator('#bodyInput').fill('第一行文字\n第二行文字\n第三行文字\n第四行文字\n第五行文字\n第六行文字');
    const layout = await page.evaluate(() => {
      const body = document.querySelector('.editor-body');
      const rects = [...body.children].filter(node => getComputedStyle(node).display !== 'none').map(node => node.getBoundingClientRect());
      const input = document.querySelector('#bodyInput').getBoundingClientRect();
      const field = document.querySelector('#bodyInput').parentElement.getBoundingClientRect();
      return {rows:document.querySelectorAll('.line-style-row').length,sectionsDoNotOverlap:rects.every((rect,i) => !i || rect.top >= rects[i-1].bottom - 1),textBoxContained:input.top >= field.top && input.bottom <= field.bottom + 1,horizontalOverflow:document.documentElement.scrollWidth > innerWidth};
    });
    assert.deepEqual(layout,{rows:6,sectionsDoNotOverlap:true,textBoxContained:true,horizontalOverflow:false});
    await page.locator('#screenSelect').scrollIntoViewIfNeeded();
    await page.locator('#screenSelect').selectOption('2.13');
    assert.equal(await page.inputValue('#screenSelect'),'2.13');
    const trigger = page.locator('.page-actions .utility-trigger[data-panel="ctrlCard"]');
    await trigger.click();
    assert.equal(await page.locator('#ctrlCard').isVisible(),true);
    await page.locator('#ctrlCard [data-close-panel]').click();
    assert.equal(await page.locator('#utilityPanel').isVisible(),false);
    await page.locator('.page-actions .utility-trigger[data-panel="logCard"]').click();
    assert.equal(await page.locator('#logCard').isVisible(),true);
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#utilityPanel').isVisible(),false);
    await page.locator('#bodyInput').scrollIntoViewIfNeeded();
    await page.screenshot({path:'test-results/mobile-six-lines-'+viewport.width+'.png'});
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});
