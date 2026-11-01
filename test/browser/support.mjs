import { createRequire } from 'node:module';
import { readFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';

export const ROOT = fileURLToPath(new URL('../..', import.meta.url));
export const OUTPUT = resolve(process.env.QA_DIR || join(ROOT, 'test-results/browser'));
export const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
export const launchOptions = {
  headless: true,
  ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : { channel: 'chromium' }),
  args: ['--disable-gpu', ...(process.getuid?.() === 0 ? ['--no-sandbox'] : [])]
};
export async function scripts(page, paths) {
  for (const path of paths) {
    await page.addScriptTag({ content: await readFile(join(ROOT, 'build/ts/src', path), 'utf8') });
  }
}
export async function screenshot(page, name) {
  await mkdir(OUTPUT, { recursive: true });
  await page.screenshot({ path: join(OUTPUT, `${name}.png`), fullPage: true });
}
