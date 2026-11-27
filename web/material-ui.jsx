import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { Button, ThemeProvider, createTheme } from '@mui/material';
let theme = createTheme({
  palette: { primary: { main: '#365e9d' }, background: { default: '#f9f9ff' } },
  typography: { fontFamily: 'Roboto, "Noto Sans", "Microsoft YaHei", sans-serif', button: { textTransform: 'none', fontWeight: 600 } },
  shape: { borderRadius: 16 }
});
const records = new WeakMap();
const mounted = new Set();
function capture(record) {
  const button = record.host.querySelector('button');
  if (!button) return;
  record.attributes = Object.fromEntries(Array.from(button.attributes).filter(a => !['style','class','disabled','type'].includes(a.name)).map(a => [a.name,a.value]));
  record.className = button.className.split(' ').filter(x => !x.startsWith('Mui') && !x.startsWith('css-')).join(' ');
  record.disabled = button.disabled;
  record.label = button.querySelector('.button-label')?.innerHTML ?? record.label;
}
window.materialButtons = {
  mount() {
    document.querySelectorAll('button').forEach(old => {
      if (old.classList.contains('utility-backdrop') || records.has(old)) return;
      const host = document.createElement('span');
      host.className = 'mui-button-host';
      const attributes = Object.fromEntries(Array.from(old.attributes).filter(a => !['style', 'class', 'disabled', 'type'].includes(a.name)).map(a => [a.name, a.value]));
      const record = { host, root: createRoot(host), attributes, label: old.innerHTML, disabled: old.disabled, className: old.className, variant: old.matches('.btn-pill,.tbtn-primary') ? 'contained' : old.matches('.nav-item,.seg button') ? 'text' : 'outlined' };
      old.replaceWith(host);
      draw(record);
      records.set(host.querySelector('button'), record);
      mounted.add(record);
    });
  },
  update(button, patch) {
    const record = records.get(button);
    if (!record) { if ('disabled' in patch) button.disabled = patch.disabled; if ('text' in patch) button.textContent = patch.text; return; }
    capture(record);
    if ('text' in patch) record.label = patch.text;
    if ('disabled' in patch) record.disabled = patch.disabled;
    record.className = button.className.split(' ').filter(x => !x.startsWith('Mui') && !x.startsWith('css-')).join(' ');
    draw(record);
  },
  setPalette(colors) {
    theme = createTheme({
      palette: {
        mode:'light', primary:{main:colors.primary,contrastText:colors.onPrimary},
        background:{default:colors.background,paper:colors.surface},
        text:{primary:colors.onSurface,secondary:colors.onSurfaceVariant}, divider:colors.outline
      },
      typography: {fontFamily:'Roboto, "Noto Sans", "Microsoft YaHei", sans-serif',button:{textTransform:'none',fontWeight:600}},
      shape:{borderRadius:16}
    });
    for (const record of mounted) { capture(record); draw(record); }
  }
};
function draw(record) {
  flushSync(() => record.root.render(
    <ThemeProvider theme={theme}>
      <Button {...record.attributes} type="button" className={record.className} disabled={record.disabled} variant={record.variant} disableElevation
        sx={{ minHeight: 44, borderRadius: '22px', fontSize: 13, paddingInline: '16px', whiteSpace: 'nowrap', lineHeight: 1.4 }}>
        <span className="button-label" dangerouslySetInnerHTML={{ __html: record.label }} />
      </Button>
    </ThemeProvider>
  ));
}
