import { chromium } from 'playwright';
import { mkdir, writeFile, copyFile } from 'node:fs/promises';
import { join } from 'node:path';

const out = 'tutorial-output';
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport: { width: 1920, height: 1080 },
  deviceScaleFactor: 1,
  recordVideo: { dir: out, size: { width: 1920, height: 1080 } }
});
const page = await context.newPage();
const evidence = { startedAt: new Date().toISOString(), steps: [], verified: false };
const step = async (name, fn) => {
  await fn();
  await page.screenshot({ path: join(out, String(evidence.steps.length + 1).padStart(2, '0') + '-' + name + '.png'), fullPage: false });
  evidence.steps.push({ name, url: page.url(), time: new Date().toISOString() });
};
try {
  const base = process.env.PORTOL_BASE_URL || 'https://portol.me';
  if (!process.env.PORTOL_TUTORIAL_EMAIL || !process.env.PORTOL_TUTORIAL_PASSWORD) throw new Error('Dedicated tutorial account credentials missing');
  await step('landing', async () => page.goto(base, { waitUntil: 'domcontentloaded' }));
  const email = page.getByRole('textbox', { name: /email/i }).or(page.locator('input[type="email"]')).first();
  if (await email.isVisible().catch(() => false)) {
    await step('login', async () => {
      await email.fill(process.env.PORTOL_TUTORIAL_EMAIL);
      await page.locator('input[type="password"]').first().fill(process.env.PORTOL_TUTORIAL_PASSWORD);
      await page.getByRole('button', { name: /sign in|log in/i }).first().click();
      await page.waitForLoadState('domcontentloaded');
    });
  }
  const prompt = 'I walked 2.5 miles today in 42 minutes. Save this as a walking tracker entry.';
  await step('chat', async () => {
    const input = page.getByRole('textbox', { name: /message|chat|ask/i }).or(page.locator('textarea')).first();
    await input.waitFor({ state: 'visible', timeout: 15000 });
    await input.fill(prompt);
    await input.press('Enter');
    await page.waitForTimeout(6000);
  });
  await step('trackers', async () => {
    await page.getByRole('link', { name: /trackers/i }).or(page.getByRole('button', { name: /trackers/i })).first().click();
    await page.waitForTimeout(2500);
  });
  await step('walking-history', async () => {
    await page.getByText(/walk/i).first().click();
    await page.waitForTimeout(1800);
    const content = await page.locator('body').innerText();
    if (!/2\.5/.test(content) || !/42/.test(content)) throw new Error('Tracker history does not visibly confirm both 2.5 miles and 42 minutes');
  });
  evidence.verified = true;
} catch (error) {
  evidence.error = String(error);
  process.exitCode = 1;
} finally {
  evidence.finishedAt = new Date().toISOString();
  await writeFile(join(out, 'verification.json'), JSON.stringify(evidence, null, 2));
  const video = page.video();
  await context.close();
  if (video) {
    try { await copyFile(await video.path(), join(out, 'raw.webm')); } catch {}
  }
  await browser.close();
}
