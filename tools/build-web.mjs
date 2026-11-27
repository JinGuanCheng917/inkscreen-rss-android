import { build } from 'esbuild';
import { copyFile, mkdir } from 'node:fs/promises';
await mkdir('app/src/main/assets', { recursive: true });
await build({ entryPoints: ['web/material-ui.jsx'], bundle: true, minify: true, outfile: 'app/src/main/assets/material-ui.js', target: 'chrome90', define: { 'process.env.NODE_ENV': '"production"' }, legalComments: 'linked' });
for (const name of ['index.html', 'native-bridge.js', 'app.js', 'material.css']) await copyFile('web/' + name, 'app/src/main/assets/' + name);
