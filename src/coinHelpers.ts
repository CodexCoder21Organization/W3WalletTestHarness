/**
 * Reusable Playwright drivers for the coin-collector demo UI.
 *
 * The JavaScript and JVM coin-collector demos share the same DOM contract:
 *   - `#mint-btn`           : button that mints a new coin
 *   - `.coin-card[data-id]` : one card per coin (data-id == coin id)
 *   - `.coin-value-display` : per-card text "<n>¢" showing the coin's value
 *   - `#coin-count`         : top-level integer counter
 *   - `#capability-count`   : top-level integer counter
 *   - `#total-value`        : top-level "<n>¢" text
 *
 * Tests in either demo can use the helpers below directly rather than
 * re-implementing them in their own test directory.
 */

import { Page, expect } from '@playwright/test';

/** Click `#mint-btn` and wait until exactly one new coin card appears. */
export async function mintCoinAndWait(page: Page): Promise<string> {
  const before = await listCoinCards(page);
  await page.click('#mint-btn');
  await expect
    .poll(async () => (await listCoinCards(page)).length, {
      message: 'coin-list did not grow after click on #mint-btn',
      timeout: 15_000,
    })
    .toBe(before.length + 1);
  const after = await listCoinCards(page);
  const added = after.filter((id) => !before.includes(id));
  if (added.length !== 1) {
    throw new Error(
      `Expected exactly one new coin after mint, but coin-card data-id sets ` +
        `differed by ${JSON.stringify(added)}. before=${JSON.stringify(before)} ` +
        `after=${JSON.stringify(after)}`,
    );
  }
  return added[0];
}

/** List every coin card's `data-id` attribute, in DOM order. */
export async function listCoinCards(page: Page): Promise<string[]> {
  return page.$$eval('.coin-card[data-id]', (cards) =>
    cards.map((c) => c.getAttribute('data-id') ?? ''),
  );
}

/** Read the cents value of a single coin card (e.g. "25¢" → 25). */
export async function getCoinValue(
  page: Page,
  coinId: string,
): Promise<number> {
  const text = await page.textContent(
    `.coin-card[data-id="${coinId}"] .coin-value-display`,
  );
  if (!text) {
    throw new Error(
      `coin-value-display element missing for coin '${coinId}'. ` +
        `Are you sure that coin exists in the current page?`,
    );
  }
  const match = text.trim().match(/^(\d+)¢$/);
  if (!match) {
    throw new Error(
      `coin-value-display text '${text}' did not match the expected '<n>¢' format.`,
    );
  }
  return parseInt(match[1], 10);
}

/** Read the integer in the top-level `#coin-count` stat. */
export async function readCoinCount(page: Page): Promise<number> {
  return readIntegerStat(page, '#coin-count');
}

/** Read the integer in the top-level `#capability-count` stat. */
export async function readCapabilityCount(page: Page): Promise<number> {
  return readIntegerStat(page, '#capability-count');
}

/** Read the cents value in the top-level `#total-value` stat. */
export async function readTotalValueCents(page: Page): Promise<number> {
  const text = (await page.textContent('#total-value'))?.trim() ?? '';
  const match = text.match(/^(\d+)¢$/);
  if (!match) {
    throw new Error(
      `#total-value text '${text}' did not match the expected '<n>¢' format.`,
    );
  }
  return parseInt(match[1], 10);
}

async function readIntegerStat(page: Page, selector: string): Promise<number> {
  const text = (await page.textContent(selector))?.trim() ?? '';
  const n = Number.parseInt(text, 10);
  if (Number.isNaN(n)) {
    throw new Error(
      `Selector '${selector}' text '${text}' is not a base-10 integer.`,
    );
  }
  return n;
}

/**
 * Wait for `window.w3wallet` to be defined. The W3WalletExtension content
 * script injects this asynchronously, so DOMContentLoaded does not guarantee
 * it is present.
 */
export async function waitForW3Wallet(
  page: Page,
  timeoutMs: number = 10_000,
): Promise<void> {
  await page.waitForFunction(
    () =>
      typeof (window as unknown as { w3wallet?: unknown }).w3wallet !==
      'undefined',
    undefined,
    { timeout: timeoutMs },
  );
}

/** Wait until the demo's connection banner flips to `Wallet Connected`. */
export async function waitForConnectedStatus(
  page: Page,
  timeoutMs: number = 15_000,
): Promise<void> {
  await page.waitForSelector('#connection-status.connected', {
    timeout: timeoutMs,
  });
  await page.waitForSelector('#mint-btn:not([disabled])', {
    timeout: timeoutMs,
  });
}
