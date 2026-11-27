
"use strict";
/* ============================================================
   0. 常量
   ============================================================ */
const EPD_SERVICE  = '13187b10-eba9-a3ba-044e-83d3217d9a38';
const EPD_CHAR     = '4b646063-6264-f3a7-8941-e65356ea82fe';
const RXTX_SERVICE = '00001f10-0000-1000-8000-00805f9b34fb';
const RXTX_CHAR    = '00001f1f-0000-1000-8000-00805f9b34fb';
const OPTIONAL_SERVICES = ['0000221f-0000-1000-8000-00805f9b34fb', RXTX_SERVICE, EPD_SERVICE];

/* 画布绘制字体：与原「墨水屏文字」页面完全一致，保证字形与度量不漂移 */
const CANVAS_FONT = '-apple-system, "SF Pro Display", "Helvetica Neue", Arial, sans-serif';

/* 排版度量：100% 沿用「墨水屏文字」页面的取值，基准画布 400×300 */
const LAYOUT = {
  baseW: 400, baseH: 300,
  pad: 24,            /* 内容留白 */
  contentFs: 24,      /* 正文字号 */
  rowH: 24,           /* 行高 */
  rowGap: 4,          /* 行间距 */
  bgPadX: 8,          /* 行底色左右外扩 */
  bgPadY: 4,          /* 行底色上下外扩 */
  titleGap: 16,       /* 标题与正文之间 */
  noTitleTop: 8,      /* 无标题时正文起始偏移 */
  titleFs: { base: 36, len5: 32, len6: 28 },
  titleOnlyFs: { base: 72, len4: 56, len5: 48, len6: 40 }
};

/* 输入限制：与原页面一致 */
const LIMITS = { title: 6, row: 24, rows: 6 };

const SCREENS = [
  { id:'4.2',      label:'4.2 寸 · 400×300',      w:400, h:300, pack:'row', planes:['bw','bwr'], finish:'01' },
  { id:'4.2small', label:'4.2 日历小图 · 280×100', w:280, h:100, pack:'row', planes:['bw','bwr'], finish:'AA' },
  { id:'7.5',      label:'7.5 寸 · 800×480',      w:800, h:480, pack:'row', planes:['bw','bwr'], finish:'01' },
  { id:'7.5small', label:'7.5 日历小图 · 400×180', w:400, h:180, pack:'row', planes:['bw','bwr'], finish:'AA' },
  { id:'2.9',      label:'2.9 寸 · 296×128',      w:296, h:128, pack:'rot', planes:['bw','bwr'], finish:'01' },
  { id:'2.13',     label:'2.13 寸 · 212×128',     w:212, h:128, pack:'rot', planes:['bw'],       finish:'01' },
  { id:'2.13hd',   label:'2.13 寸高分 · 250×128', w:250, h:128, pack:'rot', planes:['bw'],       finish:'01' }
];

const STYLES = [
  { id:'black',        label:'黑色文字', fg:'#000000', bg:null },
  { id:'red',          label:'红色文字', fg:'#FF0000', bg:null },
  { id:'bg-black',     label:'黑底白字', fg:'#FFFFFF', bg:'#000000' },
  { id:'bg-red-white', label:'红底白字', fg:'#FFFFFF', bg:'#FF0000' },
  { id:'bg-red-black', label:'红底黑字', fg:'#000000', bg:'#FF0000' }
];

const STORE_KEY = 'epd.one.ui.v2';
const DEFAULT_RSS = 'https://daily.juya.uk/rss.xml';

const state = {
  title: '',
  body: '',
  lineStyles: {},
  align: 'left',       /* left | center | only */
  screenId: '4.2',
  orient: 0,
  algo: 'floyd',
  threshold: 125,
  rssUrl: DEFAULT_RSS,
  rssEnabled: true,
  autoReconnect: true
};

/* BLE 运行时 */
let bleDevice = null, gattServer = null, epdChar = null, rxtxChar = null;
let connected = false, uploading = false, autoReconnect = true, reconnectTries = 0, composing = false;
let rssOn = false;
let rssLoading = false, rssRequestVersion = 0, reconnectTimer = null, connectionBusy = false, controlBusy = false;
let nativeMaxPayload = 20, nativeConnectionTask = null;   /* RSS 开关不持久化，每次打开默认关闭 */

const $ = id => document.getElementById(id);
const fb = $('fb');
const logBox = $('log');

/* ============================================================
   1. 工具
   ============================================================ */
const delay = ms => new Promise(r => setTimeout(r, ms));
const clamp = (v, a, b) => v < a ? a : (v > b ? b : v);

function hexToBytes(hex){
  const out = [];
  for (let i = 0; i < hex.length; i += 2) out.push(parseInt(hex.substr(i, 2), 16) || 0);
  return new Uint8Array(out);
}
function bytesToHex(data){
  return new Uint8Array(data).reduce((m, i) => m + ('0' + i.toString(16)).slice(-2), '');
}
function intToHex(n, bytes){
  bytes = bytes || 4;
  return Math.max(0, Math.round(n)).toString(16).padStart(bytes * 2, '0');
}
function screen(){ return SCREENS.find(s => s.id === state.screenId) || SCREENS[0]; }
function fmtBytes(n){ return n.toLocaleString('en-US'); }

function log(msg, kind){
  const t = new Date();
  const stamp = ('0' + t.getHours()).slice(-2) + ':' + ('0' + t.getMinutes()).slice(-2) + ':' + ('0' + t.getSeconds()).slice(-2);
  const row = document.createElement('div');
  const s1 = document.createElement('span'); s1.className = 't'; s1.textContent = stamp;
  const s2 = document.createElement('span'); if (kind) s2.className = kind; s2.textContent = msg;
  row.appendChild(s1); row.appendChild(s2);
  logBox.appendChild(row);
  while (logBox.children.length > 200) logBox.removeChild(logBox.firstChild);
  logBox.scrollTop = logBox.scrollHeight;
}

function toast(msg, isErr){
  const el = document.createElement('div');
  el.className = 'toast' + (isErr ? ' err' : '');
  el.textContent = msg;
  $('toastWrap').appendChild(el);
  setTimeout(() => el.classList.add('out'), 2100);
  setTimeout(() => el.remove(), 2350);
}

function setStatusLine(html){ $('statusLine').innerHTML = html; }
function escapeHtml(value){ return String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function buttonDisabled(button, disabled){ window.materialButtons.update(typeof button === 'string' ? $(button) : button, {disabled}); }
function buttonText(id, text){ window.materialButtons.update($(id), {text}); }

/* ============================================================
   2. 排版渲染（度量与「墨水屏文字」页面一致）
   ============================================================ */
function styleOf(id){ return STYLES.find(s => s.id === id) || STYLES[0]; }
function bodyLines(){ return state.body.split('\n'); }

function drawTextPage(ctx, w, h){
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, w, h);

  /* 非 400×300 屏幕按短边比例等比缩放，400×300 时系数恒为 1 */
  const k = Math.min(w / LAYOUT.baseW, h / LAYOUT.baseH);
  const pad       = Math.round(LAYOUT.pad * k);
  const fsContent = Math.max(6, Math.round(LAYOUT.contentFs * k));
  const rowH      = Math.max(6, Math.round(LAYOUT.rowH * k));
  const rowGap    = Math.max(1, Math.round(LAYOUT.rowGap * k));
  const bgPadX    = Math.round(LAYOUT.bgPadX * k);
  const bgPadY    = Math.round(LAYOUT.bgPadY * k);
  const maxTextW  = w - pad * 2;

  const title   = state.title.trim();
  const hasTitle = title.length > 0;
  const only    = state.align === 'only';
  const showContent = !only;

  /* ---- 标题字号（与原页面同一套阶梯） ---- */
  let titleFs;
  if (only){
    titleFs = Math.round(LAYOUT.titleOnlyFs.base * k);
    if (title.length >= 4) titleFs = Math.round(LAYOUT.titleOnlyFs.len4 * k);
    if (title.length >= 5) titleFs = Math.round(LAYOUT.titleOnlyFs.len5 * k);
    if (title.length >= 6) titleFs = Math.round(LAYOUT.titleOnlyFs.len6 * k);
  } else {
    titleFs = Math.round(LAYOUT.titleFs.base * k);
    if (title.length >= 5) titleFs = Math.round(LAYOUT.titleFs.len5 * k);
    if (title.length >= 6) titleFs = Math.round(LAYOUT.titleFs.len6 * k);
  }

  /* ---- 正文行：位置、截断、底色 ---- */
  const rowInfos = [];
  let fsRow = fsContent;                 /* 正文实际字号（长行时等比缩小） */
  let cursorY = pad + (hasTitle ? titleFs + Math.round(LAYOUT.titleGap * k) : Math.round(LAYOUT.noTitleTop * k));

  if (showContent){
    const lines = bodyLines().slice(0, LIMITS.rows);

    /* 单行上限 24 字：最长行超出画布宽度时，整段正文等比缩小字号，
       让整行都能画出来，而不是被省略号截掉。短行（≤14 字）字号不变。 */
    ctx.font = fsContent + 'px ' + CANVAS_FONT;
    let widest = 0;
    for (const raw of lines) widest = Math.max(widest, ctx.measureText(raw).width);
    if (widest > maxTextW){
      fsRow = Math.max(6, Math.floor(fsContent * maxTextW / widest));
      while (fsRow > 6){
        ctx.font = fsRow + 'px ' + CANVAS_FONT;
        let over = false;
        for (const raw of lines) if (ctx.measureText(raw).width > maxTextW){ over = true; break; }
        if (!over) break;
        fsRow -= 1;
      }
    }
    ctx.font = fsRow + 'px ' + CANVAS_FONT;

    for (let i = 0; i < lines.length; i++){
      const raw = lines[i];
      const styleId = state.lineStyles[i] || 'black';
      const st = styleOf(styleId);
      const hasBg = !!st.bg && raw.trim().length > 0;

      let displayText = raw;
      let textWidth = ctx.measureText(displayText).width;
      while (textWidth > maxTextW && displayText.length > 1){
        displayText = displayText.slice(0, -1);
        textWidth = ctx.measureText(displayText + '…').width;
      }
      if (displayText !== raw && raw.length > 0) displayText = displayText + '…';

      rowInfos.push({
        text: displayText,
        style: st,
        hasBg: hasBg,
        isEmpty: raw.trim().length === 0,
        y: cursorY,
        width: textWidth
      });
      cursorY += rowH + rowGap;
    }

    /* 行底色（先画底再画字，与原页面顺序一致；原页面正文恒为左侧起排） */
    for (let i = 0; i < rowInfos.length; i++){
      const info = rowInfos[i];
      if (!info.hasBg || info.isEmpty) continue;
      let top = info.y - bgPadY;
      let bottom = info.y + fsRow + bgPadY;
      if (i + 1 < rowInfos.length && rowInfos[i + 1].hasBg && !rowInfos[i + 1].isEmpty) bottom += rowGap;

      const boxW = info.width + bgPadX * 2;
      ctx.fillStyle = info.style.bg;
      ctx.fillRect(pad, top, Math.max(1, boxW), bottom - top);
    }
  }

  /* ---- 标题 ---- */
  if (hasTitle){
    ctx.textBaseline = 'top';
    ctx.font = '600 ' + titleFs + 'px ' + CANVAS_FONT;
    ctx.fillStyle = '#000000';

    let displayTitle = title;
    let tw = ctx.measureText(displayTitle).width;
    while (tw > maxTextW && displayTitle.length > 1){
      displayTitle = displayTitle.slice(0, -1);
      tw = ctx.measureText(displayTitle + '…').width;
    }
    if (displayTitle !== title) displayTitle = displayTitle + '…';

    let titleX, titleY;
    if (only){
      titleX = (w - tw) / 2;
      titleY = (h - titleFs) / 2;
    } else if (state.align === 'center'){
      titleX = (w - tw) / 2;
      titleY = pad;
    } else {
      titleX = pad;
      titleY = pad;
    }
    ctx.fillText(displayTitle, titleX, titleY);
  }

  /* ---- 正文（与原页面一致：正文行恒从左侧留白处起排） ---- */
  if (showContent){
    ctx.textBaseline = 'top';
    ctx.font = fsRow + 'px ' + CANVAS_FONT;
    for (const info of rowInfos){
      if (info.isEmpty) continue;
      ctx.fillStyle = info.style.fg;
      ctx.fillText(info.text, pad, info.y);
    }
  }
}

/* ============================================================
   3. 抖动
   ============================================================ */
const PALETTES = { bw: [[0,0,0],[255,255,255]], bwr: [[0,0,0],[255,255,255],[255,0,0]] };
const KERNELS = {
  floyd:    [[1,0,7/16], [-1,1,3/16], [0,1,5/16], [1,1,1/16]],
  atkinson: [[1,0,1/8], [2,0,1/8], [-1,1,1/8], [0,1,1/8], [1,1,1/8], [0,2,1/8]],
  stucki:   [[1,0,8/42], [2,0,4/42], [-2,1,2/42], [-1,1,4/42], [0,1,8/42], [1,1,4/42], [2,1,2/42],
             [-2,2,1/42], [-1,2,2/42], [0,2,4/42], [1,2,2/42], [2,2,1/42]],
  jarvis:   [[1,0,7/48], [2,0,5/48], [-2,1,3/48], [-1,1,5/48], [0,1,7/48], [1,1,5/48], [2,1,3/48],
             [-2,2,1/48], [-1,2,3/48], [0,2,5/48], [1,2,3/48], [2,2,1/48]]
};
const BAYER4 = [[0,8,2,10],[12,4,14,6],[3,11,1,9],[15,7,13,5]];

function nearestIndex(pal, r, g, b){
  let best = 0, bestD = Infinity;
  for (let i = 0; i < pal.length; i++){
    const p = pal[i];
    const dr = r - p[0], dg = g - p[1], db = b - p[2];
    const d = dr * dr + dg * dg + db * db;
    if (d < bestD){ bestD = d; best = i; }
  }
  return best;
}

function applyDither(ctx, w, h, mode, algo, threshold){
  const pal = PALETTES[mode] || PALETTES.bw;
  const bias = 128 - clamp(threshold, 0, 255);
  const img = ctx.getImageData(0, 0, w, h);
  const data = img.data;

  if (algo === 'bayer'){
    for (let y = 0; y < h; y++){
      for (let x = 0; x < w; x++){
        const i = (y * w + x) * 4;
        if (data[i + 3] === 0) continue;
        const off = (BAYER4[y & 3][x & 3] / 16 - 0.5) * 90;
        const r = clamp(data[i] + bias + off, 0, 255);
        const g = clamp(data[i + 1] + bias + off, 0, 255);
        const b = clamp(data[i + 2] + bias + off, 0, 255);
        const p = pal[nearestIndex(pal, r, g, b)];
        data[i] = p[0]; data[i + 1] = p[1]; data[i + 2] = p[2]; data[i + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    return;
  }

  const kernel = KERNELS[algo];
  if (!kernel){
    for (let i = 0; i < data.length; i += 4){
      if (data[i + 3] === 0) continue;
      const r = clamp(data[i] + bias, 0, 255);
      const g = clamp(data[i + 1] + bias, 0, 255);
      const b = clamp(data[i + 2] + bias, 0, 255);
      const p = pal[nearestIndex(pal, r, g, b)];
      data[i] = p[0]; data[i + 1] = p[1]; data[i + 2] = p[2]; data[i + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    return;
  }

  const buf = new Float32Array(w * h * 3);
  for (let i = 0, j = 0; i < data.length; i += 4, j += 3){
    buf[j] = data[i] + bias;
    buf[j + 1] = data[i + 1] + bias;
    buf[j + 2] = data[i + 2] + bias;
  }
  for (let y = 0; y < h; y++){
    for (let x = 0; x < w; x++){
      const j = (y * w + x) * 3;
      const r = clamp(buf[j], 0, 255), g = clamp(buf[j + 1], 0, 255), b = clamp(buf[j + 2], 0, 255);
      const p = pal[nearestIndex(pal, r, g, b)];
      const er = r - p[0], eg = g - p[1], eb = b - p[2];
      const i = (y * w + x) * 4;
      data[i] = p[0]; data[i + 1] = p[1]; data[i + 2] = p[2]; data[i + 3] = 255;
      for (const kk of kernel){
        const nx = x + kk[0], ny = y + kk[1];
        if (nx < 0 || nx >= w || ny >= h) continue;
        const nj = (ny * w + nx) * 3;
        buf[nj] += er * kk[2]; buf[nj + 1] += eg * kk[2]; buf[nj + 2] += eb * kk[2];
      }
    }
  }
  ctx.putImageData(img, 0, 0);
}

/* ============================================================
   4. 位图打包（与原上位机一致）
   ============================================================ */
function canvas2bytesRow(canvas, type){
  const d = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
  const arr = []; let buffer = [];
  for (let y = 0; y < canvas.height; y++){
    for (let x = 0; x < canvas.width; x++){
      const i = (canvas.width * 4 * y) + x * 4;
      let bit;
      if (type === 'bwr') bit = d[i] > 0 && d[i + 1] === 0 && d[i + 2] === 0 ? 1 : 0;
      else bit = d[i] > 0 && d[i + 1] > 0 && d[i + 2] > 0 ? 1 : 0;
      buffer.push(bit);
      if (buffer.length === 8){ arr.push(parseInt(buffer.join(''), 2)); buffer = []; }
    }
  }
  return arr;
}
function canvas2bytesRot(canvas, type){
  const d = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
  const arr = []; let buffer = [];
  for (let x = canvas.width - 1; x >= 0; x--){
    for (let y = 0; y < canvas.height; y++){
      const i = (canvas.width * 4 * y) + x * 4;
      let bit;
      if (type === 'bwr') bit = d[i] > 0 && d[i + 1] === 0 && d[i + 2] === 0 ? 1 : 0;
      else bit = d[i] > 0 && d[i + 1] > 0 && d[i + 2] > 0 ? 1 : 0;
      buffer.push(bit);
      if (buffer.length === 8){ arr.push(parseInt(buffer.join(''), 2)); buffer = []; }
    }
  }
  return arr;
}

/* ============================================================
   5. 蓝牙
   ============================================================ */
function updateConnectionUI(){
  const badge = $('connBadge');
  badge.classList.toggle('on', connected);
  badge.classList.toggle('busy', uploading);
  $('connText').textContent = connected ? '已连接' : (uploading ? '上传中' : '未连接');
  $('infoState').textContent = connected ? '已连接' : '未连接';
  $('infoName').textContent = bleDevice ? (bleDevice.name || 'NRF 设备') : '—';
  $('appbarDevice').textContent = bleDevice ? (bleDevice.name || 'NRF 设备') : '未选择设备';
  buttonText('btnConnect', connected ? '断开连接' : (connectionBusy ? '正在连接…' : '连接墨水屏'));
  buttonDisabled('btnConnect', uploading || connectionBusy || controlBusy);
  buttonDisabled('btnReconnect', !bleDevice || uploading || connectionBusy || controlBusy);
  buttonDisabled('btnUpload', !connected || uploading || connectionBusy || controlBusy);
  ['btnSetTime','btnSleepOn','btnSleepOff','btnLut','btnChePai'].forEach(id => { buttonDisabled(id, !connected || !rxtxChar || uploading || connectionBusy || controlBusy); });
  document.querySelectorAll('.chip[data-cmd]').forEach(b => { buttonDisabled(b, !connected || !rxtxChar || uploading || connectionBusy || controlBusy); });
  if (!uploading){
    setStatusLine(connected
      ? '已连接 <b>' + (bleDevice ? escapeHtml(bleDevice.name || '墨水屏') : '墨水屏') + '</b> · 输入文字后即可上屏'
      : '未连接 · 输入文字后即可上传');
  }
}

async function openGatt(){
  if (Native.available) return nativeConnect('connectLast');
  if (!bleDevice) throw new Error('没有选择设备');
  if (epdChar && gattServer && gattServer.connected){ connected = true; updateConnectionUI(); return; }

  log('正在连接 ' + (bleDevice.name || '设备') + ' …');
  gattServer = await bleDevice.gatt.connect();
  log('GATT 已连接', 'ok');

  const svc = await gattServer.getPrimaryService(EPD_SERVICE);
  epdChar = await svc.getCharacteristic(EPD_CHAR);
  log('图像通道就绪', 'ok');

  try {
    await epdChar.startNotifications();
    epdChar.addEventListener('characteristicvaluechanged', ev => {
      const n = parseInt(bytesToHex(ev.target.value.buffer) || '0', 16);
      if (n) log('屏幕回应：已接收 ' + n + ' 字节');
    });
  } catch (e){ log('通知订阅失败（不影响传图）'); }

  try {
    const rsvc = await gattServer.getPrimaryService(RXTX_SERVICE);
    rxtxChar = await rsvc.getCharacteristic(RXTX_CHAR);
    log('控制通道就绪', 'ok');
  } catch (e){
    rxtxChar = null;
    log('控制通道不可用：模式切换会失败', 'err');
  }

  connected = true; reconnectTries = 0;
  updateConnectionUI();
  saveState();
}

function onDisconnected(){
  connected = false; epdChar = null; rxtxChar = null; gattServer = null;
  updateConnectionUI();
  log('连接已断开', 'err');
  scheduleReconnect();
}
function scheduleReconnect(){
  if (!autoReconnect || !bleDevice || reconnectTries >= 6 || reconnectTimer) return;
  reconnectTries++;
  log('第 ' + reconnectTries + ' 次尝试重连…');
  reconnectTimer = setTimeout(async () => {
    reconnectTimer = null;
    if (!autoReconnect) return;
    try { await openGatt(); } catch(e){ log('重连未成功：' + e.message); scheduleReconnect(); }
  }, 800 + reconnectTries * 700);
}
async function nativeConnect(method){
  if (nativeConnectionTask) return nativeConnectionTask;
  if (connected && method === 'connectLast') return;
  clearTimeout(reconnectTimer); reconnectTimer = null;
  connectionBusy = true; updateConnectionUI();
  nativeConnectionTask = (async () => {
    const info = await Native.call(method, {}, method === 'selectConnect' ? 180000 : 35000);
    bleDevice = { id:info.id, name:info.name };
    nativeMaxPayload = Math.max(20, Math.min(244, info.maxPayload || 20));
    epdChar = {}; rxtxChar = info.control ? {} : null; gattServer = {connected:true};
    connected = true; reconnectTries = 0;
    log('已连接 ' + info.name + ' · 每包最多 ' + nativeMaxPayload + ' 字节', 'ok');
    if (!info.control) log('控制通道不可用，仍可传图');
  })();
  try { return await nativeConnectionTask; }
  finally { nativeConnectionTask = null; connectionBusy = false; updateConnectionUI(); }
}

async function attachDevice(dev){
  bleDevice = dev;
  dev.addEventListener('gattserverdisconnected', onDisconnected);
  await openGatt();
}

async function pickAndConnect(){
  if (Native.available){
    try { await nativeConnect('selectConnect'); }
    catch(e){ log('连接失败：' + e.message, 'err'); if(e.code !== 'cancelled') toast(e.message, true); }
    return;
  }
  if (!('bluetooth' in navigator)){
    toast('当前浏览器不支持 Web Bluetooth，请使用 Chrome / Edge', true);
    log('浏览器不支持 Web Bluetooth', 'err');
    return;
  }
  try {
    buttonDisabled('btnConnect', true);
    const dev = await navigator.bluetooth.requestDevice({
      filters: [{ namePrefix: 'NRF-' }],
      optionalServices: OPTIONAL_SERVICES
    });
    try { localStorage.setItem('epd.lastDevice', dev.id || dev.name || ''); } catch (e){}
    await attachDevice(dev);
  } catch (e){
    if (e && e.name === 'NotFoundError') log('已取消选择设备');
    else {
      log('连接失败：' + (e && e.message ? e.message : e), 'err');
      toast('连接失败：' + (e && e.message ? e.message : e), true);
    }
  } finally {
    buttonDisabled('btnConnect', false);
    updateConnectionUI();
  }
}

async function tryAutoConnect(){
  if (Native.available){
    if (!autoReconnect) return;
    try {
      const last = await Native.call('lastDevice');
      bleDevice = {id:last.id, name:last.name};
      updateConnectionUI();
      await nativeConnect('connectLast');
    } catch(e){ if(e.code !== 'no_device'){ log(e.message); scheduleReconnect(); } }
    return;
  }
  if (!('bluetooth' in navigator)){ log('此浏览器不支持 Web Bluetooth'); return; }
  if (!autoReconnect){ log('已关闭自动重连'); return; }
  if (typeof navigator.bluetooth.getDevices !== 'function'){
    log('当前浏览器不支持自动重连，请点击「连接墨水屏」');
    return;
  }
  try {
    const list = await navigator.bluetooth.getDevices();
    if (!list || !list.length){ log('尚未授权任何设备，请点击「连接墨水屏」'); return; }
    let last = null;
    try { last = localStorage.getItem('epd.lastDevice'); } catch (e){}
    const dev = (last && list.find(d => d.id === last)) ||
                list.find(d => (d.name || '').indexOf('NRF-') === 0) || list[0];
    if (!dev) return;
    log('发现已授权设备 ' + (dev.name || dev.id) + '，自动连接中…');
    await attachDevice(dev);
  } catch (e){
    log('自动连接未启用：' + (e && e.message ? e.message : e));
  }
}

async function epdWrite(bytes){
  if (Native.available){ if (!connected) throw new Error('墨水屏未连接'); return Native.call('write', {channel:'image', hex:bytesToHex(bytes)}); }
  if (!epdChar) throw new Error('墨水屏未连接');
  if (typeof epdChar.writeValueWithResponse === 'function') await epdChar.writeValueWithResponse(bytes);
  else await epdChar.writeValue(bytes);
}
async function rxWrite(bytes){
  if (Native.available){ if (!rxtxChar) throw new Error('控制通道不可用，请重新连接'); return Native.call('write', {channel:'control', hex:bytesToHex(bytes)}); }
  if (!rxtxChar) throw new Error('控制通道不可用，请重新连接');
  if (typeof rxtxChar.writeValueWithResponse === 'function') await rxtxChar.writeValueWithResponse(bytes);
  else await rxtxChar.writeValue(bytes);
}

/* ============================================================
   6. 上传
   ============================================================ */
function setProgress(done, total){
  const pct = total ? Math.round((done / total) * 100) : 0;
  $('progressBar').style.width = pct + '%';
  $('progress').classList.add('show');
}
function hideProgress(){
  setTimeout(() => { $('progress').classList.remove('show'); $('progressBar').style.width = '0%'; }, 600);
}

function planeStepHex(){ return Native.available ? Math.max(2, (nativeMaxPayload - 4) * 2) : 480; }
async function sendPlane(hexStr, type, onStep){
  const STEP = planeStepHex();
  const code = type === 'bwr' ? '00' : 'ff';
  let cod = '03';
  if (hexStr.length === 7000 || hexStr.length === 18000) cod = '04';

  for (let i = 0; i < hexStr.length; i += STEP){
    await epdWrite(hexToBytes(cod + code + intToHex(i / 2, 2) + hexStr.substring(i, i + STEP)));
    if (onStep) onStep();
  }
}

async function uploadImage(){
  if (uploading || controlBusy) return;
  if (!connected || !epdChar){ toast('请先连接墨水屏', true); return; }
  if (!state.body.trim() && !state.title.trim()){ toast('请先输入文字', true); return; }

  uploading = true;
  buttonDisabled('btnUpload', true);
  $('progress').classList.add('show');
  setProgress(0, 1);
  updateConnectionUI();

  const t0 = performance.now();
  try {
    renderFramebuffer();
    const cfg = screen();
    const packFn = cfg.pack === 'rot' ? canvas2bytesRot : canvas2bytesRow;
    const perPlane = Math.ceil((cfg.w * cfg.h / 8) * 2 / planeStepHex());
    const totalSteps = perPlane * cfg.planes.length;
    let step = 0;

    const planes = cfg.planes.map(plane => ({plane, bytes:packFn(fb, plane)}));
    for (const {plane, bytes} of planes){
      log('发送' + (plane === 'bwr' ? '红色平面' : '黑白平面') + '：' + fmtBytes(bytes.length) + ' 字节');
      await sendPlane(bytesToHex(bytes), plane, () => {
        step++;
        setProgress(step, totalSteps);
        setStatusLine('正在上传 <b>' + Math.round(step / totalSteps * 100) + '%</b> · 请勿离开本页');
      });
    }

    await delay(300);
    await epdWrite(hexToBytes(cfg.finish));
    const secs = ((performance.now() - t0) / 1000).toFixed(1);
    log('上传完成，用时 ' + secs + ' 秒', 'ok');
    toast('已上传到墨水屏');
    $('infoLast').textContent = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    setProgress(1, 1);
  } catch (e){
    log('上传失败：' + (e && e.message ? e.message : e), 'err');
    toast('上传失败：' + (e && e.message ? e.message : e), true);
  } finally {
    uploading = false;
    buttonDisabled('btnUpload', false);
    hideProgress();
    updateConnectionUI();
  }
}

/* ============================================================
   7. 帧缓冲
   ============================================================ */
function renderFramebuffer(){
  const cfg = screen();
  const W = cfg.w, H = cfg.h;
  if (fb.width !== W || fb.height !== H){ fb.width = W; fb.height = H; }
  const ctx = fb.getContext('2d');

  const rot = ((state.orient % 360) + 360) % 360;
  const lw = (rot === 90 || rot === 270) ? H : W;
  const lh = (rot === 90 || rot === 270) ? W : H;

  const tmp = document.createElement('canvas');
  tmp.width = lw; tmp.height = lh;
  drawTextPage(tmp.getContext('2d'), lw, lh);

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, W, H);
  ctx.save();
  ctx.translate(W / 2, H / 2);
  ctx.rotate(rot * Math.PI / 180);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(tmp, -lw / 2, -lh / 2);
  ctx.restore();

  const mode = cfg.planes.indexOf('bwr') >= 0 ? 'bwr' : 'bw';
  applyDither(ctx, W, H, mode, state.algo, state.threshold);

  $('previewMeta').textContent = '预览 · ' + W + ' × ' + H + (rot ? ' · 旋转 ' + rot + '°' : '');
  $('previewBytes').textContent = fmtBytes(W * H / 8) + ' B × ' + cfg.planes.length;
  $('frameTag').textContent = W + ' × ' + H;
  $('modeTag').textContent = mode === 'bwr' ? '红黑白' : '黑白';
  $('infoScreen').textContent = cfg.label;
}

/* ============================================================
   8. 界面联动
   ============================================================ */
function renderLineStyles(){
  const wrap = $('lineStyles');
  wrap.innerHTML = '';
  const lines = bodyLines().slice(0, LIMITS.rows);
  lines.forEach((line, idx) => {
    if (!line.trim()) return;
    const row = document.createElement('div');
    row.className = 'line-style-row';

    const ln = document.createElement('span');
    ln.className = 'ln';
    ln.textContent = '第' + (idx + 1) + '行';
    row.appendChild(ln);

    const sel = document.createElement('select');
    STYLES.forEach(st => {
      const o = document.createElement('option');
      o.value = st.id;
      o.textContent = st.label;
      if ((state.lineStyles[idx] || 'black') === st.id) o.selected = true;
      sel.appendChild(o);
    });
    sel.addEventListener('change', () => {
      state.lineStyles[idx] = sel.value;
      saveState();
      scheduleRender();
    });
    row.appendChild(sel);
    wrap.appendChild(row);
  });
}

let renderTimer = null;
function scheduleRender(){
  if (renderTimer) clearTimeout(renderTimer);
  renderTimer = setTimeout(() => { renderTimer = null; renderFramebuffer(); }, 90);
}

function saveState(){
  try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch (e){}
}
function loadState(){
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return;
    const obj = JSON.parse(raw);
    Object.keys(state).forEach(k => {
      if (Object.prototype.hasOwnProperty.call(obj, k) && obj[k] !== null && obj[k] !== undefined) state[k] = obj[k];
    });
  } catch (e){}
}

function syncControls(){
  $('titleInput').value = state.title;
  $('bodyInput').value = state.body;
  $('thresholdRange').value = state.threshold;
  $('algoSelect').value = state.algo;
  $('orientSelect').value = String(state.orient);
  $('screenSelect').value = state.screenId;
  $('rssUrl').value = state.rssUrl || DEFAULT_RSS;
  document.querySelectorAll('#alignSeg button').forEach(b => {
    b.classList.toggle('on', b.dataset.align === state.align);
  });
  $('bodyInput').disabled = state.align === 'only';
}

/* 输入限制：与原「墨水屏文字」页面一致（标题 6 字、每行 15 字、最多 6 行） */
function enforceLimits(text){
  const raw = text.split('\n');
  let clipped = raw.length > LIMITS.rows;
  const lines = raw.slice(0, LIMITS.rows).map(l => {
    const chars = Array.from(l);
    if (chars.length > LIMITS.row){ clipped = true; return chars.slice(0, LIMITS.row).join(''); }
    return l;
  });
  return { text: lines.join('\n'), clipped: clipped };
}

/* ============================================================
   9. 控制指令
   ============================================================ */
function guardControl(action){
  return async event => {
    if (uploading || controlBusy || !connected) return;
    controlBusy = true; updateConnectionUI();
    try { await action(event); }
    finally { controlBusy = false; updateConnectionUI(); }
  };
}
async function sendModeCmd(hex, doRefresh){
  await rxWrite(hexToBytes(hex));
  if (doRefresh){ await delay(300); await rxWrite(hexToBytes('e2')); }
  log('指令 ' + hex + ' 已发送');
}

async function setTimeToNow(){
  const now = new Date();
  const unixNow = Math.round(Date.now() / 1000) - now.getTimezoneOffset() * 60;
  const payload = 'dd' + intToHex(unixNow, 4) + intToHex(now.getFullYear(), 2) +
                  intToHex(now.getMonth() + 1, 1) + intToHex(now.getDate(), 1) + intToHex(now.getDay() || 7, 1);
  await rxWrite(hexToBytes(payload));
  await delay(300);
  await rxWrite(hexToBytes('e2'));
  log('时间已设置为 ' + now.toLocaleString('zh-CN', { hour12: false }), 'ok');
}

function pad2(v){
  const n = clamp(parseInt(v, 10) || 0, 0, 99);
  return (n > 9 ? '' : '0') + n;
}

/* ============================================================
   10. 侧边导航：滚动定位
   ============================================================ */
function initNav(){
  const workspace = $('workspace');
  const items = Array.prototype.slice.call(document.querySelectorAll('.nav-item'));

  items.forEach(item => {
    item.addEventListener('click', () => {
      const el = $(item.dataset.target);
      if (!el) return;
      items.forEach(i => i.classList.toggle('active', i === item));
      const top = el.getBoundingClientRect().top - workspace.getBoundingClientRect().top + workspace.scrollTop - 12;
      workspace.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
    });
  });

  let ticking = false;
  workspace.addEventListener('scroll', () => {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => {
      ticking = false;
      const base = workspace.getBoundingClientRect().top + 24;
      let current = items[0];
      items.forEach(item => {
        const el = $(item.dataset.target);
        if (el && el.getBoundingClientRect().top <= base) current = item;
      });
      items.forEach(i => i.classList.toggle('active', i === current));
    });
  }, { passive: true });
}

/* ============================================================
   11. RSS 自动填充
   ============================================================ */
function rssPad(n){ return n < 10 ? '0' + n : String(n); }

/* 标题格式：[月]-[日] AI早报 */
function todayTitle(){
  const d = new Date();
  return (d.getMonth() + 1) + '-' + d.getDate() + ' AI早报';
}

/* 单条超长按字数截断（按码点计，避免截断 emoji） */
function truncateTo(s, n){
  const chars = Array.from(String(s));
  return chars.length > n ? chars.slice(0, n).join('') : String(s);
}

function cleanBullet(text){
  let t = String(text || '').replace(/\s+/g, ' ').trim();
  t = t.replace(/\s*#\d+\s*$/, '').replace(/\s*[↗→]\s*$/, '').trim();
  return t;
}

function splitSummary(desc){
  return String(desc || '').split(/[；;]/).map(cleanBullet).filter(s => s.length > 0);
}

function bulletsFromContent(html){
  if (!html) return [];
  const holder = document.createElement('div');
  holder.innerHTML = html;
  return Array.prototype.map.call(holder.querySelectorAll('li'), li => cleanBullet(li.textContent))
    .filter(s => s.length > 0);
}

function parseFeed(xmlText){
  const doc = new DOMParser().parseFromString(xmlText, 'text/xml');
  if (doc.getElementsByTagName('parsererror').length) throw new Error('RSS 格式无法解析');
  const items = Array.prototype.slice.call(doc.getElementsByTagName('item'));
  if (!items.length) throw new Error('RSS 中没有条目');

  const latest = items[0];
  const pubEl = latest.getElementsByTagName('pubDate')[0];
  const issue = pubEl ? new Date(pubEl.textContent.trim()) : null;

  const encEl = latest.getElementsByTagName('content:encoded')[0];
  let lines = bulletsFromContent(encEl ? encEl.textContent : '');
  if (!lines.length){
    const descEl = latest.getElementsByTagName('description')[0];
    lines = splitSummary(descEl ? descEl.textContent : '');
  }
  return { lines: lines, issue: issue };
}

function setRssStatus(msg, kind){
  const el = $('rssStatus');
  el.hidden = false;
  el.className = 'rss-status' + (kind ? ' ' + kind : '');
  el.textContent = msg;
}

/* RSS 开启时标题可长于 6 字，关闭后恢复原限制 */
function applyTitleLimit(on){
  $('titleInput').maxLength = on ? 40 : LIMITS.title;
  $('titleHint').textContent = on ? 'RSS 标题可超过 6 字' : '至多 6 个汉字';
}

async function checkNetwork(){
  try { return Native.available ? !!(await Native.call('network')).online : navigator.onLine !== false; }
  catch { return false; }
}
function updateNetworkBanner(online){
  if (typeof online === 'object') online = !!online.online;
  $('networkBanner').textContent = online
    ? '已联网 · 可刷新 RSS · 蓝牙可离线使用'
    : '未联网 · 已跳过 RSS · 编辑与蓝牙仍可使用';
  $('networkBanner').classList.toggle('offline', !online);
}
async function refreshInApp(){
  saveState(); renderFramebuffer();
  if (!rssOn){
    updateNetworkBanner(await checkNetwork());
    toast('预览已刷新 · RSS 自动填充已关闭');
    return;
  }
  await loadRss();
}
async function readFeed(url){
  if (Native.available) return (await Native.call('rss', {url}, 15000)).text;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(url, {cache:'no-store', signal:controller.signal});
    if (!response.ok) throw new Error('HTTP ' + response.status);
    return await response.text();
  } finally { clearTimeout(timer); }
}
async function loadRss(){
  if (rssLoading) return;
  const version = rssRequestVersion;
  const url = (($('rssUrl').value || '').trim()) || DEFAULT_RSS;
  const draft = {title:state.title, body:state.body};
  rssLoading = true;
  buttonDisabled('btnRssFetch', true);
  buttonDisabled('btnRefresh', true);
  try {
    const online = await checkNetwork();
    updateNetworkBanner(online);
    if (!online){ setRssStatus('未联网，已跳过 RSS；可点击「不退出应用刷新」重试。'); log('未联网，跳过 RSS'); return; }
    if (!url.startsWith('https://')) throw new Error('请使用 HTTPS RSS 地址');
    setRssStatus('正在获取 RSS…');
    const parsed = parseFeed(await readFeed(url));
    if (!rssOn || version !== rssRequestVersion || url !== (($('rssUrl').value || '').trim() || DEFAULT_RSS)) return;
    if (state.title !== draft.title || state.body !== draft.body){
      setRssStatus('获取期间文字已修改，已保留编辑；如需填充 RSS，请再次刷新。');
      return;
    }
    const seen = new Set();
    const rows = [];
    for (const line of parsed.lines){
      const clipped = truncateTo(line, LIMITS.row);
      if (!clipped || seen.has(clipped)) continue;
      seen.add(clipped); rows.push(clipped);
      if (rows.length >= LIMITS.rows) break;
    }
    if (!rows.length) throw new Error('RSS 中没有可用文字');
    state.title = todayTitle(); state.body = rows.join('\n');
    $('titleInput').value = state.title; $('bodyInput').value = state.body;
    renderLineStyles(); saveState(); scheduleRender();
    const issue = parsed.issue && !isNaN(parsed.issue.getTime()) ? parsed.issue.toLocaleDateString('zh-CN') : '最新一期';
    setRssStatus('已填充 ' + rows.length + ' 条（' + issue + '）', 'ok');
    log('RSS 已填充 ' + rows.length + ' 条', 'ok');
  } catch(e){
    if (version !== rssRequestVersion || !rssOn) return;
    const message = e.code === 'offline' ? '未联网，已跳过 RSS' : '本次 RSS 已跳过：' + (e.name === 'AbortError' ? '请求超时' : e.message);
    setRssStatus(message + '；已保留当前文字，可点击「不退出应用刷新」重试。');
    log(message);
    updateNetworkBanner(await checkNetwork());
  } finally {
    rssLoading = false;
    buttonDisabled('btnRssFetch', false);
    buttonDisabled('btnRefresh', false);
  }
}

/* ============================================================
   12. 竖屏：拖动 / 轻点收起编辑区
   ============================================================ */
function initSheet(){
  const card = $('editorCard');
  const handle = $('sheetHandle');
  if (!card || !handle) return;

  const headEl = card.querySelector('.card-head');
  const isPortrait = () => matchMedia('(orientation: portrait)').matches;

  let dragging = false, startY = 0, startH = 0, moved = false, lastH = 0;
  let collapsedH = 60;                       /* 仅露出标题时的高度（缓存，避免压扁后测偏） */

  function defaultHeight(){ return Math.round(Math.min(innerHeight * 0.52, 560)); }
  function maxHeight(){ return Math.round(innerHeight * 0.9); }
  function compactBelow(){ return collapsedH + 96; }

  function measureCollapsed(){
    collapsedH = headEl ? Math.ceil(headEl.getBoundingClientRect().height + 26) : 60;
    return collapsedH;
  }
  function syncDock(){
    document.documentElement.style.setProperty('--dock-h', Math.round(card.getBoundingClientRect().height) + 'px');
  }
  /* 直接把高度写进内联样式：跟随指针实时变化，无过渡、无吸附 */
  function setHeight(h){
    const v = Math.round(Math.max(collapsedH, Math.min(maxHeight(), h)));
    lastH = v;
    card.style.minHeight = '0px';
    card.style.height = v + 'px';
    card.classList.toggle('compact', v <= compactBelow());
    document.documentElement.style.setProperty('--dock-h', v + 'px');
    return v;
  }
  function expand(h){
    measureCollapsed();
    setHeight(h || defaultHeight());
  }
  function collapse(){
    setHeight(measureCollapsed());
  }

  handle.addEventListener('pointerdown', ev => {
    if (!isPortrait()) return;
    dragging = true;
    moved = false;
    startY = ev.clientY;
    measureCollapsed();
    startH = Math.max(collapsedH, card.getBoundingClientRect().height || defaultHeight());
    try { handle.setPointerCapture(ev.pointerId); } catch (e){}
    ev.preventDefault();
  });

  handle.addEventListener('pointermove', ev => {
    if (!dragging) return;
    const dy = startY - ev.clientY;          /* 手指/鼠标上移为正 */
    if (Math.abs(dy) > 3) moved = true;
    setHeight(startH + dy);
  });

  function endDrag(ev){
    if (!dragging) return;
    dragging = false;
    try { handle.releasePointerCapture(ev.pointerId); } catch (e){}
    if (moved) return;                       /* 拖动：停在松手处，不做吸附 */
    /* 轻点：在「只露标题」和默认高度之间切换 */
    if (card.getBoundingClientRect().height <= collapsedH + 8) expand();
    else collapse();
  }
  handle.addEventListener('pointerup', endDrag);
  handle.addEventListener('pointercancel', () => { dragging = false; });

  handle.addEventListener('keydown', ev => {
    if (ev.key === 'Enter' || ev.key === ' '){
      ev.preventDefault();
      if (card.getBoundingClientRect().height <= collapsedH + 8) expand();
      else collapse();
    }
  });

  window.addEventListener('resize', () => {
    if (!isPortrait()){
      card.style.height = '';
      card.style.minHeight = '';
      card.classList.remove('compact');
      document.documentElement.style.removeProperty('--dock-h');
      return;
    }
    measureCollapsed();
    if (card.style.height) setHeight(parseInt(card.style.height, 10) || defaultHeight());
    else syncDock();
  });

  measureCollapsed();
  if (isPortrait()) syncDock();
}

/* ============================================================
   13. 初始化
   ============================================================ */
function buildScreenOptions(){
  const sel = $('screenSelect');
  sel.innerHTML = '';
  SCREENS.forEach(s => {
    const o = document.createElement('option');
    o.value = s.id;
    o.textContent = s.label;
    sel.appendChild(o);
  });
}

function bindEvents(){
  const onControl = (id, action) => $(id).addEventListener('click', guardControl(action));
  $('titleInput').addEventListener('input', e => {
    if (composing) return;
    state.title = e.target.value;
    saveState(); scheduleRender();
  });

  $('bodyInput').addEventListener('compositionstart', () => { composing = true; });
  $('bodyInput').addEventListener('compositionend', e => {
    composing = false;
    applyBody(e.target.value);
  });
  $('bodyInput').addEventListener('input', e => {
    if (composing) return;
    applyBody(e.target.value);
  });

  function applyBody(value){
    const before = bodyLines().filter(s => s.trim()).length;
    const res = enforceLimits(value);
    if (res.clipped){
      toast('已限制为每行至多 ' + LIMITS.row + ' 字、至多 ' + LIMITS.rows + ' 行');
      $('bodyInput').value = res.text;
    }
    state.body = res.text;
    const after = res.text.split('\n').filter(s => s.trim()).length;
    saveState();
    if (before !== after) renderLineStyles();
    scheduleRender();
  }

  document.querySelectorAll('#alignSeg button').forEach(b => {
    b.addEventListener('click', () => {
      state.align = b.dataset.align;
      document.querySelectorAll('#alignSeg button').forEach(x => x.classList.toggle('on', x === b));
      $('bodyInput').disabled = state.align === 'only';
      saveState(); scheduleRender();
    });
  });

  $('thresholdRange').addEventListener('input', e => {
    state.threshold = parseInt(e.target.value, 10);
    saveState(); scheduleRender();
  });
  $('algoSelect').addEventListener('change', e => { state.algo = e.target.value; saveState(); scheduleRender(); });
  $('orientSelect').addEventListener('change', e => { state.orient = parseInt(e.target.value, 10) || 0; saveState(); scheduleRender(); });
  $('screenSelect').addEventListener('change', e => { state.screenId = e.target.value; saveState(); renderFramebuffer(); });

  $('btnRefresh').addEventListener('click', refreshInApp);
  $('btnPreview').addEventListener('click', () => { renderFramebuffer(); log('预览已刷新'); });
  $('btnUpload').addEventListener('click', uploadImage);

  $('btnConnect').addEventListener('click', async () => {
    if (connected){
      autoReconnect = false;
      state.autoReconnect = false; saveState();
      $('autoReconnectSwitch').checked = false;
      clearTimeout(reconnectTimer); reconnectTimer = null;
      try { if (Native.available) await Native.call('disconnect'); else if (bleDevice && bleDevice.gatt.connected) bleDevice.gatt.disconnect(); } catch(e){ log(e.message, 'err'); }
      return;
    }
    autoReconnect = $('autoReconnectSwitch').checked;
    await pickAndConnect();
  });

  $('btnReconnect').addEventListener('click', async () => {
    try { updateConnectionUI(); await openGatt(); log('重连成功', 'ok'); }
    catch (e){ log('重连失败：' + (e && e.message ? e.message : e), 'err'); }
  });

  document.querySelectorAll('.chip[data-cmd]').forEach(btn => {
    btn.addEventListener('click', guardControl(async () => {
      try { await sendModeCmd(btn.dataset.cmd, btn.dataset.refresh === '1'); }
      catch (e){ log('指令失败：' + (e && e.message ? e.message : e), 'err'); }
    }));
  });

  onControl('btnSetTime', async () => {
    try { await setTimeToNow(); } catch (e){ log('设置时间失败：' + e.message, 'err'); }
  });
  onControl('btnSleepOn', async () => {
    try {
      const cmd = 'FB01' + pad2($('sleepFrom').value) + pad2($('sleepTo').value);
      await rxWrite(hexToBytes(cmd));
      log('已开启休眠段 ' + cmd, 'ok');
    } catch (e){ log('指令失败：' + e.message, 'err'); }
  });
  onControl('btnSleepOff', async () => {
    try {
      const cmd = 'FB00' + pad2($('sleepFrom').value) + pad2($('sleepTo').value);
      await rxWrite(hexToBytes(cmd));
      log('已关闭休眠段 ' + cmd, 'ok');
    } catch (e){ log('指令失败：' + e.message, 'err'); }
  });
  onControl('btnLut', async () => {
    const v = ($('lutInput').value || '').replace(/[^0-9a-fA-F]/g, '');
    if (!v){ toast('请输入 01~f0 的校准值', true); return; }
    try { await rxWrite(hexToBytes('E6' + v)); log('局刷校准参数 ' + v + ' 已发送', 'ok'); }
    catch (e){ log('指令失败：' + e.message, 'err'); }
  });
  onControl('btnChePai', async () => {
    const num = ($('cpInput').value || '').trim();
    if (!num){ toast('请输入停车牌号码', true); return; }
    let cp = '';
    for (const ch of num) cp += ch + ch;
    try {
      await rxWrite(hexToBytes('EF' + cp));
      await delay(500);
      await rxWrite(hexToBytes('e2'));
      log('停车牌号码已发送', 'ok');
    } catch (e){ log('指令失败：' + e.message, 'err'); }
  });

  $('btnClearLog').addEventListener('click', () => { logBox.innerHTML = ''; });

  $('autoReconnectSwitch').addEventListener('change', e => {
    autoReconnect = e.target.checked;
    state.autoReconnect = autoReconnect; saveState();
    if (!autoReconnect){ clearTimeout(reconnectTimer); reconnectTimer = null; }
    log(autoReconnect ? '已开启断线自动重连' : '已关闭断线自动重连');
  });

  /* RSS 自动填充 */
  $('rssSwitch').addEventListener('change', e => {
    rssOn = e.target.checked;
    rssRequestVersion++; state.rssEnabled = rssOn; saveState();
    $('rssSource').hidden = !rssOn;
    $('rssStatus').hidden = !rssOn;
    applyTitleLimit(rssOn);
    if (rssOn) loadRss();
    else log('已关闭 RSS 自动填充');
  });
  $('btnRssFetch').addEventListener('click', loadRss);
  $('rssUrl').addEventListener('change', () => {
    state.rssUrl = ($('rssUrl').value || '').trim() || DEFAULT_RSS;
    saveState();
  });
  $('rssUrl').addEventListener('keydown', e => {
    if (e.key === 'Enter'){ e.preventDefault(); state.rssUrl = ($('rssUrl').value || '').trim() || DEFAULT_RSS; saveState(); loadRss(); }
  });

  document.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter'){ e.preventDefault(); uploadImage(); }
  });
}

function init(){
  try { window.materialButtons.mount(); } catch(e){ console.error(e); }
  if (Native.available){
    Native.on('disconnected', onDisconnected);
    Native.on('notification', hex => { const n = parseInt(hex || '0', 16); if(n) log('屏幕回应：已接收 ' + n + ' 字节'); });
    Native.on('log', msg => log(msg));
    Native.on('network', updateNetworkBanner);
  }
  buildScreenOptions();
  loadState();
  autoReconnect = state.autoReconnect !== false;
  $('autoReconnectSwitch').checked = autoReconnect;
  syncControls();
  rssOn = state.rssEnabled !== false;
  $('rssSwitch').checked = rssOn;
  $('rssSource').hidden = !rssOn;
  applyTitleLimit(rssOn);
  renderLineStyles();
  bindEvents();
  initNav();
  // Android uses one continuous scroll layout to keep every control reachable.
  renderFramebuffer();
  updateConnectionUI();
  log('就绪。首次使用请点击「连接墨水屏」，之后可自动重连。');

  if (!Native.available && typeof navigator.bluetooth === 'undefined'){
    log('当前浏览器不支持 Web Bluetooth；请使用 Chrome / Edge（file:// 或 https 均可）', 'err');
    setStatusLine('当前浏览器不支持 Web Bluetooth');
  } else {
    setTimeout(tryAutoConnect, 600);
  }
  checkNetwork().then(updateNetworkBanner);
  if (rssOn) loadRss();
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();
