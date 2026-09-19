import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';

const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const baseUrl = process.env.TAO_BASE_URL ?? 'http://127.0.0.1:3000';
const dataRoot = '/tmp/PS1-latest/01_data';
const files = [
  '01_LINES.csv', '02_STATIONS.csv', '03_SECTORS.csv', '04_LOCATION_SUPPLY.csv',
  '05_BUFFER_LOCATION.csv', '06_PARAMETERS.csv', '07_PROJECT_DETAILS.csv', '08_ACTIVITY_DETAILS.csv',
].map((name) => `${dataRoot}/${name}`);
const invalidFiles = await Promise.all(files.map(async (path) => ({
  name: path.split('/').pop(),
  mimeType: 'text/csv',
  buffer: path.endsWith('08_ACTIVITY_DETAILS.csv') ? Buffer.from('bad_header\nbad_value\n') : await readFile(path),
})));

const browser = await chromium.launch({ executablePath: chrome, headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await page.goto(`${baseUrl}/mockup`, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'Skip intro' }).click();
  await page.getByRole('button', { name: 'Open settings' }).click();
  await page.getByLabel('Optimisation seconds per policy').fill('1');
  await page.getByRole('button', { name: /Extended/ }).click();
  await page.getByRole('button', { name: /Policy A/ }).click();
  await page.getByRole('button', { name: 'Done' }).click();
  await page.getByText('1s per policy', { exact: true }).waitFor();
  await page.locator('input[type="file"]').setInputFiles(files);
  await page.getByRole('button', { name: 'Process dataset' }).click();

  const resultsButton = page.getByRole('button', { name: 'See results' });
  await resultsButton.waitFor({ state: 'visible', timeout: 120_000 });
  await assert.doesNotReject(() => resultsButton.click({ timeout: 120_000 }));
  await page.getByRole('heading', { name: 'Programme workspace' }).waitFor({ timeout: 30_000 });

  await assert.doesNotReject(() => page.getByText('Fixed supply', { exact: true }).first().waitFor());
  await assert.doesNotReject(() => page.getByText('Zero overrun', { exact: true }).first().waitFor());
  await assert.doesNotReject(() => page.getByText('Balanced capacity', { exact: true }).first().waitFor());
  assert.equal(await page.locator('[class*="liveMetrics"]').count(), 1);
  assert.ok(await page.locator('[class*="liveLineRow"]').count() > 0, 'railway lines should render from uploaded data');
  assert.ok(await page.locator('[class*="liveGanttRow"]').count() > 1, 'real scheduled activities should render');

  const lineLabel = page.locator('[class*="liveLineTitle"] span').first();
  const lineHeight = await lineLabel.evaluate((element) => getComputedStyle(element).lineHeight);
  assert.notEqual(lineHeight, 'normal', 'line names should use explicit readable line spacing');

  await page.getByLabel('Disruption instruction').fill('block A001 in week 30');
  await page.getByRole('button', { name: 'Replan + validate' }).click();
  await page.getByText('Independent validator passed', { exact: true }).waitFor({ timeout: 120_000 });
  assert.equal(await page.getByRole('button', { name: /Download REPLAN_RESULTS\.csv/ }).isVisible(), true);

  const repairPage = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await repairPage.goto(`${baseUrl}/mockup`, { waitUntil: 'networkidle' });
  await repairPage.getByRole('button', { name: 'Skip intro' }).click();
  await repairPage.locator('input[type="file"]').setInputFiles('/Users/sohlinhan/Desktop/ps1-app/docs/UI_USER_FLOW.md');
  await repairPage.getByRole('alert').filter({ hasText: 'Some files need attention before processing' }).waitFor();
  await repairPage.getByRole('button', { name: 'Review unmatched files' }).click();
  await repairPage.getByRole('heading', { name: 'Match each file to its CSV number' }).waitFor();
  await repairPage.getByRole('button', { name: /01_LINES\.csv/ }).click();
  await repairPage.getByRole('button', { name: 'Confirm name mapping' }).click();
  await repairPage.getByText('1', { exact: true }).first().waitFor();
  assert.equal(await repairPage.getByRole('heading', { name: 'AI-assisted data repair' }).count(), 0);
  await repairPage.close();

  const recoveryPage = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await recoveryPage.goto(`${baseUrl}/mockup`, { waitUntil: 'networkidle' });
  await recoveryPage.getByRole('button', { name: 'Skip intro' }).click();
  await recoveryPage.locator('input[type="file"]').setInputFiles(invalidFiles);
  await recoveryPage.getByRole('button', { name: 'Process dataset' }).click();
  await recoveryPage.getByRole('heading', { name: 'Pipeline recovery' }).waitFor({ timeout: 30_000 });
  assert.equal(await recoveryPage.getByRole('button', { name: 'Retry deterministic pipeline' }).isVisible(), true);
  assert.equal(await recoveryPage.getByRole('button', { name: 'Return to dataset intake' }).isVisible(), true);
  await recoveryPage.getByRole('button', { name: 'Explain evidence' }).click();
  await recoveryPage.getByText('Deterministic explanation', { exact: true }).waitFor({ timeout: 30_000 });
  await recoveryPage.getByRole('button', { name: 'Review data with AI assistance' }).click();
  await recoveryPage.getByRole('heading', { name: 'AI-assisted data repair' }).waitFor();
  assert.equal(await recoveryPage.getByRole('button', { name: 'Create untrusted draft' }).isDisabled(), true);
  assert.match(await recoveryPage.locator('[class*="aiDisclosure"]').innerText(), /Gemini on Google Cloud Vertex AI/);
  await recoveryPage.close();

  console.log('E2E PASS: solve, replan, recovery/explainer and consent-gated conversion screens');
} finally {
  await browser.close();
}
