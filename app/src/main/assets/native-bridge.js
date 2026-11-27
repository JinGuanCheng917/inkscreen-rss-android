(() => {
  'use strict';
  const pending = new Map();
  let sequence = 0;
  const listeners = new Map();
  const port = window.InkNative;
  window.Native = {
    available: !!port,
    call(method, params = {}, timeout = 20000) {
      if (!port) return Promise.reject(new Error('原生接口不可用'));
      return new Promise((resolve, reject) => {
        const id = String(++sequence);
        const timer = setTimeout(() => { pending.delete(id); reject(new Error('操作超时，请重试')); }, timeout);
        pending.set(id, { resolve, reject, timer });
        port.postMessage(JSON.stringify({ id, method, params }));
      });
    },
    on(event, callback) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event).add(callback);
    }
  };
  if (port) port.onmessage = ({ data }) => {
    let message;
    try { message = JSON.parse(data); } catch { return; }
    if (message.event) {
      for (const callback of listeners.get(message.event) || []) callback(message.data);
      return;
    }
    const item = pending.get(message.id);
    if (!item) return;
    clearTimeout(item.timer);
    pending.delete(message.id);
    if (message.error) { const error = new Error(message.error.message); error.code = message.error.code; item.reject(error); }
    else item.resolve(message.result);
  };
})();
