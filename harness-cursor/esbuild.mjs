import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');
const production = process.env.NODE_ENV === 'production';

/** The watch:ext background task in .vscode/tasks.json waits for these two lines. */
const watchMarkers = {
  name: 'watch-markers',
  setup(build) {
    build.onStart(() => console.log('[watch] build started'));
    build.onEnd((result) => {
      for (const e of result.errors) {
        console.error(`✘ [ERROR] ${e.text}${e.location ? ` (${e.location.file}:${e.location.line}:${e.location.column})` : ''}`);
      }
      console.log('[watch] build finished');
    });
  },
};

const options = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  outfile: 'dist/extension.js',
  external: ['vscode'],
  sourcemap: !production,
  minify: production,
  logLevel: watch ? 'warning' : 'info',
  plugins: watch ? [watchMarkers] : [],
};

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
} else {
  await esbuild.build(options);
}
