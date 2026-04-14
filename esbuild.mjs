import * as esbuild from 'esbuild';
import { cpSync } from 'fs';

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

const extensionConfig = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'out/extension.js',
  external: ['vscode', 'node-pty'],
  format: 'cjs',
  platform: 'node',
  target: 'ES2022',
  sourcemap: !production,
  minify: production,
};

const webviewConfig = {
  entryPoints: ['src/webview/main.ts'],
  bundle: true,
  outdir: 'out',
  entryNames: 'webview',
  format: 'esm',
  platform: 'browser',
  target: 'ES2022',
  sourcemap: !production,
  minify: production,
};

const daemonConfig = {
  entryPoints: ['src/daemon/server.ts'],
  bundle: true,
  outfile: 'out/daemon.js',
  external: ['node-pty'],
  format: 'cjs',
  platform: 'node',
  target: 'ES2022',
  sourcemap: !production,
  minify: production,
};

async function main() {
  if (watch) {
    const ctx1 = await esbuild.context(extensionConfig);
    const ctx2 = await esbuild.context(webviewConfig);
    const ctx3 = await esbuild.context(daemonConfig);
    await Promise.all([ctx1.watch(), ctx2.watch(), ctx3.watch()]);
    console.log('Watching for changes...');
  } else {
    await Promise.all([
      esbuild.build(extensionConfig),
      esbuild.build(webviewConfig),
      esbuild.build(daemonConfig),
    ]);
    // Copy static assets that the webview needs
    cpSync('node_modules/@vscode/codicons/dist/codicon.css', 'out/codicon.css');
    cpSync('node_modules/@vscode/codicons/dist/codicon.ttf', 'out/codicon.ttf');
    cpSync('node_modules/@xterm/xterm/css/xterm.css', 'out/xterm.css');
    console.log('Build complete.');
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
