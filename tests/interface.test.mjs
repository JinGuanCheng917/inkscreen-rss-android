import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { chromium } from 'playwright';

let server, browser, origin;
const feed = '<?xml version="1.0"?><rss><channel><item><pubDate>Fri, 27 Nov 2026 08:00:00 GMT</pubDate><description>第一条测试新闻；第二条测试新闻；第三条测试新闻</description></item></channel></rss>';
const sourceA = {id:'test-source-a',name:'测试来源甲',url:'https://feeds.example.com/a.xml'};
const sourceB = {id:'test-source-b',name:'测试来源乙',url:'https://feeds.example.com/b.xml'};
const storedDraft = {title:'保留标题',body:'保留文字\n第二行',rssSchema:1,rssEnabled:true,rssSources:[sourceA],rssSelectedId:sourceA.id};
const palette = {primary:'#725500',onPrimary:'#ffffff',primaryContainer:'#ffe08c',onPrimaryContainer:'#241a00',secondaryContainer:'#e8dfc8',onSecondaryContainer:'#211b0c',surface:'#fffbf1',onSurface:'#201b13',surfaceVariant:'#eae1cd',onSurfaceVariant:'#494536',outline:'#7b7666',background:'#fffbf1'};
const fallbackPalette = {...palette,primary:'#365e9d',primaryContainer:'#d7e3ff',background:'#f9f9ff',surface:'#ffffff'};
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
  page.on('dialog', dialog => dialog.accept());
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(({options, feed, storedDraft, palette, fallbackPalette}) => {
    window.__mock = {online:false, maxPayload:20, protocol:'legacy', version:0, configHex:'', control:true, name:'NRF-测试', theme:{enabled:true,dynamicAvailable:true,colors:palette}, feed, calls:[], requests:[], writes:[], rssCount:0, rssCompleted:0, instance:Math.random(), ...options};
    const savedDynamic = sessionStorage.getItem('mock.native.dynamic');
    if (savedDynamic != null) window.__mock.theme.enabled = savedDynamic === 'true';
    window.__emitNative = (event, data) => window.InkNative.onmessage({data:JSON.stringify({event,data})});
    window.__notifyNative = hex => window.InkNative.onmessage({data:JSON.stringify({event:'notification',data:hex})});
    if (options.storage !== null && localStorage.getItem('epd.one.ui.v2') == null) localStorage.setItem('epd.one.ui.v2', JSON.stringify(options.storage || storedDraft));
    window.InkNative = {postMessage(text) {
      const request = JSON.parse(text);
      const mock = window.__mock;
      mock.calls.push(request.method);
      mock.requests.push(request);
      const reply = result => window.InkNative.onmessage({data:JSON.stringify({id:request.id, result})});
      const reject = (code, message) => window.InkNative.onmessage({data:JSON.stringify({id:request.id, error:{code,message}})});
      queueMicrotask(() => {
        if (request.method === 'network') reply({online:mock.online});
        else if (request.method === 'theme') {
          if (typeof request.params.enabled === 'boolean') { mock.theme.enabled = request.params.enabled; sessionStorage.setItem('mock.native.dynamic',String(request.params.enabled)); }
          reply({...mock.theme,colors:mock.theme.enabled && mock.theme.dynamicAvailable ? mock.theme.colors : fallbackPalette});
        }
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
          const text = mock.feeds?.[request.params.url] || mock.feed;
          setTimeout(() => { mock.rssCompleted++; mock.rssError ? reject('rss_failed', mock.rssError) : reply({text}); }, mock.rssDelay || 0);
        }
      });
    }};
  }, {options,feed,storedDraft,palette,fallbackPalette});
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
    await showPanel(page,'rssCard');
    await page.locator('#rssSwitch').uncheck();
    await page.locator('#rssCard [data-close-panel]').click();
    await page.locator('#btnRefresh').click();
    assert.equal(await page.inputValue('#bodyInput'), '保留文字\n第二行');
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test('title-only RSS falls back to distinct item titles and labels the draft with its selected source', async () => {
  const titleFeed = '<?xml version="1.0"?><rss version="2.0"><channel><title>频道标题</title><item><title>只含标题的第一条</title></item><item><title>只含标题的第二条</title></item><item><title>只含标题的第一条</title></item><item><title>只含标题的第三条</title></item></channel></rss>';
  const {context,page,errors} = await open({online:true,feed:titleFeed});
  try {
    await page.waitForFunction(() => window.__mock.rssCompleted === 1 && !rssLoading);
    assert.equal(await page.inputValue('#bodyInput'),'只含标题的第一条\n只含标题的第二条\n只含标题的第三条');
    assert.match(await page.inputValue('#titleInput'),/^\d{1,2}-\d{1,2} 测试来源甲$/);
    assert.doesNotMatch(await page.inputValue('#titleInput'),/AI早报|频道标题/);
    assert.match(await page.textContent('#rssStatus'),/已填充 3 条/);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test('Atom HTML summaries become plain text while preserving summary line boundaries', async () => {
  const atomFeed = '<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>Atom测试</title><entry><title>条目标题</title><updated>2026-11-27T08:00:00Z</updated><summary type="html">&lt;p&gt;第一条 &lt;b&gt;Atom&lt;/b&gt; 摘要&lt;br/&gt;第二条 &amp;amp; 更多；第三条摘要&lt;/p&gt;</summary></entry></feed>';
  const {context,page,errors} = await open({online:true,feed:atomFeed});
  try {
    await page.waitForFunction(() => window.__mock.rssCompleted === 1 && !rssLoading);
    assert.equal(await page.inputValue('#bodyInput'),'第一条 Atom 摘要\n第二条 & 更多\n第三条摘要');
    assert.match(await page.textContent('#rssStatus'),/已填充 3 条/);
    assert.doesNotMatch(await page.inputValue('#bodyInput'),/<[^>]+>|&amp;/);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test('untrusted RSS HTML never executes image handlers or scripts and cannot call the native bridge', async () => {
  const unsafeFeed = '<?xml version="1.0"?><rss><channel><item><description><![CDATA[<img data-rss-untrusted src="/missing-rss-image" onerror="window.__rssExecuted=true;window.InkNative.postMessage(JSON.stringify({id:999,method:\'disconnect\',params:{}}))"><script>window.__rssExecuted=true;window.InkNative.postMessage(JSON.stringify({id:998,method:"write",params:{channel:"image",hex:"aa"}}))</script><style>.unsafe { color:red; }</style><ul><li>安全的第一条内容</li><li>安全的第二条内容</li></ul>]]></description></item></channel></rss>';
  const {context,page,errors} = await open({feed:unsafeFeed});
  try {
    await connect(page);
    await page.evaluate(() => { window.__mock.online = true; });
    await page.locator('#btnRefresh').click();
    await page.waitForFunction(() => window.__mock.rssCompleted === 1 && !rssLoading);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await page.inputValue('#bodyInput'),'安全的第一条内容\n安全的第二条内容');
    assert.equal(await page.evaluate(() => !!window.__rssExecuted),false);
    assert.equal(await page.locator('img[data-rss-untrusted]').count(),0);
    assert.equal(await page.evaluate(() => window.__mock.calls.includes('disconnect')),false);
    assert.deepEqual(await page.evaluate(() => window.__mock.writes),[]);
    assert.equal(await page.textContent('#connText'),'已连接');
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
async function showPanel(page, id) {
  if (await page.locator('#'+id).isVisible()) return;
  if (await page.locator('#utilityPanel').isVisible()) await page.keyboard.press('Escape');
  await page.locator('.utility-trigger[data-panel="'+id+'"]:visible').first().click();
  assert.equal(await page.locator('#'+id).isVisible(),true);
}
async function waitReady(page) {
  await page.waitForFunction(() => window.materialButtons && document.querySelector('#btnRefresh.MuiButton-root') && !document.querySelector('#btnRefresh').disabled);
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

test('first launch has RSS disabled and no bundled source even when online', async () => {
  const {context,page,errors} = await open({online:true,storage:null});
  try {
    await showPanel(page,'rssCard');
    assert.equal(await page.locator('#rssSwitch').isChecked(),false);
    assert.deepEqual(await page.evaluate(() => state.rssSources),[]);
    assert.equal(await page.evaluate(() => state.rssSelectedId),'');
    assert.equal(await page.evaluate(() => window.__mock.rssCount),0);
    assert.doesNotMatch((await page.locator('#rssSource option').allTextContents()).join(' '),/daily\.juya\.uk/);
    assert.equal(await page.inputValue('#rssUrl'),'');
    await page.locator('#rssCard [data-close-panel]').click();
    await page.locator('#btnRefresh').click();
    assert.equal(await page.evaluate(() => window.__mock.rssCount),0);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

for (const custom of [false,true]) test('old settings migrate ' + (custom ? 'a custom source' : 'the removed built-in source') + ' with RSS disabled', async () => {
  const url = custom ? sourceA.url : 'https://daily.juya.uk/rss.xml';
  const {context,page,errors} = await open({online:true,storage:{title:'旧草稿',body:'旧正文',rssEnabled:true,rssUrl:url}});
  try {
    await showPanel(page,'rssCard');
    assert.equal(await page.locator('#rssSwitch').isChecked(),false);
    assert.equal(await page.evaluate(() => window.__mock.rssCount),0);
    assert.equal(await page.inputValue('#bodyInput'),'旧正文');
    const sources = await page.evaluate(() => state.rssSources);
    assert.equal(sources.length,custom ? 1 : 0);
    if (custom) { assert.equal(sources[0].url,url); assert.ok(sources[0].name); assert.equal(await page.inputValue('#rssSource'),sources[0].id); }
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test('multiple RSS sources support explicit add, update, selection persistence, and deletion', async () => {
  const {context,page,errors} = await open({storage:{...storedDraft,rssEnabled:false,rssSources:[],rssSelectedId:''}});
  try {
    await showPanel(page,'rssCard');
    await page.locator('#rssSwitch').check();
    await page.locator('#rssName').fill('技术资讯');
    await page.locator('#rssUrl').fill(sourceA.url);
    await page.locator('#btnRssSave').click();
    const first = await page.evaluate(() => state.rssSources[0]);
    assert.equal(first.name,'技术资讯'); assert.equal(first.url,sourceA.url); assert.ok(first.id);
    await page.locator('#btnRssNew').click();
    assert.equal(await page.inputValue('#rssSource'),'');
    assert.equal(await page.inputValue('#rssName'),'');
    assert.equal(await page.inputValue('#rssUrl'),'');
    await page.locator('#rssName').fill('今日新闻');
    await page.locator('#rssUrl').fill(sourceB.url);
    await page.locator('#btnRssSave').click();
    const second = await page.evaluate(() => state.rssSources[1]);
    assert.equal(second.name,'今日新闻'); assert.ok(second.id !== first.id);
    await page.locator('#rssSource').selectOption(first.id);
    assert.equal(await page.inputValue('#rssName'),'技术资讯');
    assert.equal(await page.inputValue('#rssUrl'),sourceA.url);
    await page.locator('#rssName').fill('技术资讯更新');
    await page.locator('#rssUrl').fill('https://feeds.example.com/updated.xml');
    assert.equal(await page.evaluate(() => state.rssSources[0].url),sourceA.url);
    await page.locator('#btnRssSave').click();
    assert.equal(await page.evaluate(() => state.rssSources.length),2);
    assert.equal(await page.evaluate(() => state.rssSources[0].id),first.id);
    assert.equal(await page.evaluate(() => state.rssSources[0].url),'https://feeds.example.com/updated.xml');
    await page.locator('#rssSource').selectOption(second.id);
    await page.locator('#rssSwitch').uncheck();
    await page.reload(); await waitReady(page); await showPanel(page,'rssCard');
    assert.equal(await page.inputValue('#rssSource'),second.id);
    assert.equal(await page.inputValue('#rssName'),'今日新闻');
    assert.equal(await page.inputValue('#rssUrl'),sourceB.url);
    assert.equal(await page.locator('#rssSwitch').isChecked(),false);
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('epd.one.ui.v2')).rssSchema),1);
    await page.locator('#rssSwitch').check();
    await page.locator('#btnRssDelete').click();
    assert.deepEqual(await page.evaluate(() => state.rssSources.map(source => source.id)),[first.id]);
    await page.locator('#rssSource').selectOption(first.id);
    await page.locator('#btnRssDelete').click();
    assert.deepEqual(await page.evaluate(() => state.rssSources),[]);
    assert.equal(await page.inputValue('#rssSource'),'');
    assert.equal(await page.evaluate(() => window.__mock.rssCount),0);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test('RSS rejects malformed and non-HTTPS addresses before saving or fetching', async () => {
  const {context,page,errors} = await open({online:true,storage:{...storedDraft,rssEnabled:false,rssSources:[],rssSelectedId:''}});
  try {
    await showPanel(page,'rssCard');
    await page.locator('#rssSwitch').check();
    await page.locator('#rssName').fill('待验证来源');
    for (const url of ['', 'not a URL', 'http://example.com/rss.xml', 'https://', 'file:///tmp/feed.xml', 'https://alice:password@example.com/rss.xml']) {
      await page.locator('#rssUrl').fill(url);
      await page.locator('#btnRssSave').click();
      assert.equal(await page.evaluate(() => state.rssSources.length),0,url);
    }
    assert.equal(await page.evaluate(() => window.__mock.rssCount),0);
    await page.locator('#rssUrl').fill('  '+sourceA.url+'#article  ');
    await page.locator('#btnRssSave').click();
    assert.equal(await page.evaluate(() => state.rssSources[0].url),sourceA.url);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test('enabling RSS waits for explicit fetch, then saved enabled settings fetch again on refresh and restart', async () => {
  const {context,page,errors} = await open({online:true,storage:{...storedDraft,rssEnabled:false}});
  try {
    await showPanel(page,'rssCard');
    await page.locator('#rssSwitch').check();
    assert.equal(await page.evaluate(() => window.__mock.rssCount),0);
    await page.locator('#btnRssFetch').click();
    await page.waitForFunction(() => window.__mock.rssCompleted === 1 && !rssLoading);
    assert.equal(await page.inputValue('#bodyInput'),'第一条测试新闻\n第二条测试新闻\n第三条测试新闻');
    await page.locator('#rssCard [data-close-panel]').click();
    await page.locator('#btnRefresh').click();
    await page.waitForFunction(() => window.__mock.rssCompleted === 2 && !rssLoading);
    await page.reload(); await waitReady(page);
    await page.waitForFunction(() => window.__mock.rssCompleted === 1 && !rssLoading);
    const requests = await page.evaluate(() => window.__mock.requests.filter(request => request.method === 'rss'));
    assert.equal(requests[0].params.url,sourceA.url);
    assert.equal(await page.evaluate(() => state.rssEnabled),true);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test('fetch uses only the saved selected source and ignores unsaved form edits', async () => {
  const {context,page,errors} = await open({storage:{...storedDraft,rssSources:[sourceA,sourceB]}});
  try {
    await showPanel(page,'rssCard');
    await page.locator('#rssUrl').fill('https://unsaved.example.com/not-used.xml');
    await page.evaluate(() => { window.__mock.online = true; });
    await page.locator('#btnRssFetch').click();
    await page.waitForFunction(() => window.__mock.rssCompleted === 1 && !rssLoading);
    assert.equal(await page.evaluate(() => window.__mock.requests.find(request => request.method === 'rss').params.url),sourceA.url);
    assert.equal(await page.evaluate(() => state.rssSources[0].url),sourceA.url);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

for (const change of ['select','disable']) test('a late RSS response cannot replace the draft after ' + change, async () => {
  const {context,page,errors} = await open({rssDelay:200,storage:{...storedDraft,rssSources:[sourceA,sourceB]}});
  try {
    await showPanel(page,'rssCard');
    await page.evaluate(() => { window.__mock.online = true; });
    await page.locator('#btnRssFetch').click();
    await page.waitForFunction(() => window.__mock.rssCount === 1);
    if (change === 'select') await page.locator('#rssSource').selectOption(sourceB.id);
    else await page.locator('#rssSwitch').uncheck();
    await page.waitForFunction(() => window.__mock.rssCompleted === 1 && !rssLoading);
    assert.equal(await page.inputValue('#titleInput'),'保留标题');
    assert.equal(await page.inputValue('#bodyInput'),'保留文字\n第二行');
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test('dynamic palette updates native theme and MUI colors without changing e-paper pixels', async () => {
  const {context,page,errors} = await open({viewport:{width:1440,height:900}});
  try {
    await page.waitForFunction(() => getComputedStyle(document.documentElement).getPropertyValue('--brand').trim().toLowerCase() === '#725500');
    assert.equal(await page.locator('#dynamicColorSwitch').isChecked(),true);
    const before = await page.evaluate(() => fb.toDataURL());
    const changed = {...palette,primary:'#005fae',primaryContainer:'#d3e4ff'};
    await page.evaluate(colors => window.__emitNative('theme',{enabled:true,dynamicAvailable:true,colors}),changed);
    await page.waitForFunction(() => getComputedStyle(document.querySelector('#btnConnect')).backgroundColor === 'rgb(0, 95, 174)');
    assert.equal(await page.evaluate(() => fb.toDataURL()),before);
    await showPanel(page,'rssCard');
    await page.locator('#dynamicColorSwitch').uncheck();
    await page.waitForFunction(() => window.__mock.requests.some(request => request.method === 'theme' && request.params.enabled === false));
    await page.waitForFunction(() => getComputedStyle(document.documentElement).getPropertyValue('--brand').trim().toLowerCase() === '#365e9d');
    assert.equal(await page.evaluate(() => fb.toDataURL()),before);
    await page.reload(); await waitReady(page);
    await page.waitForFunction(() => document.querySelector('#dynamicColorSwitch') && !document.querySelector('#dynamicColorSwitch').checked);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test('devices without dynamic palettes retain a usable default interface', async () => {
  const {context,page,errors} = await open({theme:{enabled:true,dynamicAvailable:false,colors:palette}});
  try {
    await page.waitForFunction(() => window.__mock.calls.includes('theme'));
    assert.equal(await page.locator('#dynamicColorSwitch').isChecked(),true);
    assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--brand').trim().toLowerCase()),'#365e9d');
    assert.ok((await page.textContent('#themeStatus')).trim());
    assert.equal(await page.locator('#btnConnect').isEnabled(),true);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

for (const viewport of [{width:320,height:568},{width:390,height:844}]) test('mobile RSS settings remain reachable at ' + viewport.width + 'px with several saved sources', async () => {
  const {context,page,errors} = await open({viewport,storage:{...storedDraft,rssEnabled:false,rssSources:[sourceA,sourceB]}});
  try {
    await showPanel(page,'rssCard');
    await page.locator('#rssSwitch').check();
    await page.locator('#rssSource').selectOption(sourceB.id);
    assert.equal(await page.inputValue('#rssUrl'),sourceB.url);
    await page.locator('#btnRssSave').scrollIntoViewIfNeeded();
    assert.equal(await page.locator('#btnRssSave').isVisible(),true);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),false);
    const rect = await page.locator('#rssCard').boundingBox();
    assert.ok(rect.x >= 0 && rect.x + rect.width <= viewport.width + 1);
    await page.screenshot({path:'test-results/rss-mobile-'+viewport.width+'.png'});
    await page.locator('#rssCard [data-close-panel]').click();
    await page.locator('#bodyInput').fill('RSS设置返回后仍可编辑');
    assert.equal(await page.inputValue('#bodyInput'),'RSS设置返回后仍可编辑');
    await page.screenshot({path:'test-results/main-mobile-'+viewport.width+'.png'});
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});
