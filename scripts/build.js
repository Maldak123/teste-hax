import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';

execFileSync(process.execPath, ['scripts/check.js'], { stdio: 'inherit' });
const port = Number(process.env.PORT ?? 8787);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT inválido');
await mkdir('dist', { recursive: true });
const modules = ['src/domain/balance.js', 'src/domain/statistics.js', 'src/domain/chat.js', 'src/app/browser.js'];
const fragments = [];
for (const file of modules) {
  let code = await readFile(file, 'utf8');
  code = code.replace(/^import .*;\n/gm, '').replace(/^export /gm, '');
  if (file.endsWith('/browser.js')) code = code.replace('new URL(import.meta.url).origin', `'http://127.0.0.1:${port}'`);
  fragments.push(`// ${file}\n${code}`);
}
const bundle = `(() => {\n${fragments.join('\n')}\nvoid boot().catch(console.error);\n})();\n`;
if (/^import |^export |import\.meta/gm.test(bundle)) throw new Error('Bundle contém módulos não resolvidos');
await writeFile('dist/bootstrap.js', bundle);
execFileSync(process.execPath, ['--check', 'dist/bootstrap.js'], { stdio: 'inherit' });
console.log('Generated dist/bootstrap.js.');
