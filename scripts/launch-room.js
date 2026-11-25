import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { loadConfig } from '../src/server/config.js';
import { startService } from '../src/server/index.js';
import { launchChrome } from '../src/launcher/chrome.js';

execFileSync(process.execPath, ['scripts/build.js'], { stdio: 'inherit' });
const config = loadConfig();
const service = await startService(config);
let browser;
try {
  browser = await launchChrome(await readFile('dist/bootstrap.js', 'utf8'));
  console.log('Bot carregado na página Headless. Mantenha este processo e o Chrome abertos.');
} catch (error) {
  await service.close();
  console.error(`Falha ao iniciar a sala: ${error.message}`);
  process.exitCode = 1;
}

if (browser) {
  const close = () => { browser.close(); void service.close(); };
  process.once('SIGINT', close);
  process.once('SIGTERM', close);
}
