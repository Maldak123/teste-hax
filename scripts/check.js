import { readdir, readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

async function files(dir) {
  const result = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) result.push(...await files(file));
    else if (file.endsWith('.js')) result.push(file);
  }
  return result;
}

for (const file of [...await files('src'), ...await files('scripts'), ...await files('tests')]) {
  execFileSync(process.execPath, ['--check', file], { stdio: 'inherit' });
  const content = await readFile(file, 'utf8');
  if (/\t| +$/m.test(content)) throw new Error(`Whitespace inválido: ${file}`);
}
JSON.parse(await readFile('package.json', 'utf8'));
console.log('Syntax and formatting checks passed.');
