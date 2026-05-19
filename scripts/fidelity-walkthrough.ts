/**
 * Warehouse-scan design fidelity walkthrough.
 * Captures screenshots at 375 (mobile) and 1440 (desktop) widths.
 * Run: npx tsx scripts/fidelity-walkthrough.ts
 */

import { chromium, type Browser, type Page } from "playwright";
import * as fs from "fs";
import * as path from "path";
import * as http from "http";
import { execSync } from "child_process";

const BASE = "http://localhost:3000";
const API_BASE = "http://localhost:4000";
const OUT = path.join(__dirname, "../docs/mockups/warehouse-scan/_fidelity");

const WIDTHS = [
  { label: "375", width: 375, height: 812 },
  { label: "1440", width: 1440, height: 900 },
];

// ── Helpers ──────────────────────────────────────────────────────────────────

async function httpGet(url: string, headers: Record<string, string>): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { headers }, (res) => {
      let data = "";
      res.on("data", (chunk: Buffer) => { data += chunk.toString(); });
      res.on("end", () => resolve(data));
    });
    req.on("error", reject);
  });
}

async function httpPost(url: string, headers: Record<string, string>, body: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const opts = {
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname + parsed.search,
      method: "POST",
      headers: { ...headers, "Content-Length": Buffer.byteLength(body) },
    };
    const req = http.request(opts, (res) => {
      let data = "";
      res.on("data", (chunk: Buffer) => { data += chunk.toString(); });
      res.on("end", () => resolve(data));
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

function clearScanSessions(): void {
  // Run the dedicated script via tsx (synchronous, reliable path resolution)
  const repoRoot = path.join(__dirname, "..");
  execSync("npx tsx apps/api/scripts/clear-scan-sessions.ts", {
    cwd: repoRoot,
    stdio: "pipe",
  });
  console.log("  Cleared all scan sessions");
}

async function screenshot(page: Page, name: string): Promise<void> {
  await page.waitForTimeout(600);
  await page.screenshot({ path: path.join(OUT, name), fullPage: true });
  console.log(`  Screenshot: ${name}`);
}

async function waitNet(page: Page): Promise<void> {
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.waitForTimeout(400);
}

async function loginWarehouse(page: Page): Promise<void> {
  await page.goto(`${BASE}/warehouse/scan`);
  await page.waitForLoadState("domcontentloaded");
  const sel = page.locator("select");
  await sel.waitFor({ state: "visible", timeout: 15000 });
  await sel.selectOption({ label: "Иван Кладовщик" });
  await page.locator('input[type="password"]').fill("1234");
  await page.locator('button[type="submit"]').click();
  await page.waitForSelector('button:has-text("Выдача")', { timeout: 15000 });
}

async function runAtWidth(
  browser: Browser,
  widthCfg: { label: string; width: number; height: number }
): Promise<void> {
  const { label, width, height } = widthCfg;
  console.log(`\n=== Width: ${label} ===`);

  // Clear any stale sessions before each viewport run
  clearScanSessions();

  const context = await browser.newContext({
    viewport: { width, height },
    isMobile: width < 600,
  });
  const page = await context.newPage();

  // ──────────────────────────────────────────────────────────────────────────
  // SCREEN 1: Login
  // ──────────────────────────────────────────────────────────────────────────
  console.log("1. Login screen");
  await page.goto(`${BASE}/warehouse/scan`);
  await page.waitForLoadState("domcontentloaded");
  await page.waitForTimeout(1500);
  await screenshot(page, `01-login-${label}.png`);

  // ──────────────────────────────────────────────────────────────────────────
  // Login
  // ──────────────────────────────────────────────────────────────────────────
  const sel = page.locator("select");
  await sel.waitFor({ state: "visible", timeout: 15000 });
  await sel.selectOption({ label: "Иван Кладовщик" });
  await page.locator('input[type="password"]').fill("1234");
  await page.locator('button[type="submit"]').click();
  await page.waitForSelector('button:has-text("Выдача")', { timeout: 15000 });

  // ──────────────────────────────────────────────────────────────────────────
  // SCREEN 2: Operation pick
  // ──────────────────────────────────────────────────────────────────────────
  console.log("2. Operation pick");
  await waitNet(page);
  await screenshot(page, `02-operation-${label}.png`);

  // ──────────────────────────────────────────────────────────────────────────
  // SCREEN 3: Booking list (ISSUE)
  // ──────────────────────────────────────────────────────────────────────────
  console.log("3. Booking list (ISSUE)");
  await page.locator('button:has-text("Выдача")').first().click();
  await page.waitForFunction(
    () => document.body.innerText.includes("Реклама «Орбита»"),
    { timeout: 20000 }
  );
  await waitNet(page);
  await screenshot(page, `03-booking-list-${label}.png`);

  // ──────────────────────────────────────────────────────────────────────────
  // SCREEN 4: Issue checklist
  // ──────────────────────────────────────────────────────────────────────────
  console.log("4. Issue checklist");
  await page.locator('button:has-text("Реклама «Орбита»")').first().click();
  // Wait for checklist items to load (loading skeleton clears, then items appear)
  await page.waitForFunction(
    () => document.body.innerText.includes("Выдать всё разом") ||
          document.body.innerText.includes("Aputure 600D"),
    { timeout: 30000 }
  );
  await waitNet(page);
  await screenshot(page, `04-issue-checklist-${label}.png`);

  // ──────────────────────────────────────────────────────────────────────────
  // SCREEN 5a: Addon search open
  // ──────────────────────────────────────────────────────────────────────────
  console.log("5a. Addon search open");
  // Mobile: bottom bar "＋ Добор (артикул не из заявки)"
  // Desktop: top chip "＋ Добор"
  // Both have aria-label containing "Добор — добавить артикул не из заявки"
  const addonBtns = page.locator('[aria-label="Добор — добавить артикул не из заявки"]');
  const nAddons = await addonBtns.count();
  let addonOpened = false;
  for (let i = 0; i < nAddons; i++) {
    const btn = addonBtns.nth(i);
    if (await btn.isVisible().catch(() => false)) {
      await btn.click();
      addonOpened = true;
      break;
    }
  }
  if (!addonOpened) {
    // Scroll to bottom to reveal the bottom bar on mobile
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(200);
    for (let i = 0; i < nAddons; i++) {
      const btn = addonBtns.nth(i);
      if (await btn.isVisible().catch(() => false)) {
        await btn.click();
        addonOpened = true;
        break;
      }
    }
  }
  if (!addonOpened) {
    console.log("  WARNING: Could not open addon search");
  }
  await page.waitForTimeout(400);
  const addonPanelVisible = await page.locator('[aria-label*="поиск по каталогу"]').isVisible().catch(() => false);
  if (addonPanelVisible) {
    await screenshot(page, `05a-addon-open-${label}.png`);
  } else {
    await screenshot(page, `05a-addon-open-${label}.png`);
    console.log("  Addon panel may not be visible");
  }

  // ──────────────────────────────────────────────────────────────────────────
  // SCREEN 5b: Addon — free result (Manfrotto, free since no conflict booking)
  // ──────────────────────────────────────────────────────────────────────────
  console.log("5b. Addon — free result");
  const si = page.locator("#addon-search-input");
  await si.waitFor({ state: "visible", timeout: 5000 }).catch(() => {});
  await si.fill("Manfrotto");
  await page.waitForTimeout(700);
  await page.waitForFunction(
    () => document.body.innerText.includes("свободно") ||
          document.body.innerText.includes("занято") ||
          document.body.innerText.includes("Ничего не найдено") ||
          document.body.innerText.includes("Manfrotto"),
    { timeout: 8000 }
  ).catch(() => {});
  await screenshot(page, `05b-addon-free-result-${label}.png`);

  // ──────────────────────────────────────────────────────────────────────────
  // SCREEN 5c: Addon — busy result (Astera — fully occupied by conflict booking)
  // ──────────────────────────────────────────────────────────────────────────
  console.log("5c. Addon — busy result");
  await si.fill("Astera");
  await page.waitForTimeout(700);
  await page.waitForFunction(
    () => document.body.innerText.includes("занято") ||
          document.body.innerText.includes("Ничего не найдено"),
    { timeout: 8000 }
  ).catch(() => {});
  await screenshot(page, `05c-addon-busy-result-${label}.png`);

  // ──────────────────────────────────────────────────────────────────────────
  // SCREEN 5d: Addon — conflict warning card
  // ──────────────────────────────────────────────────────────────────────────
  console.log("5d. Addon — conflict warning");
  // Click the busy Astera row
  const listBtns = page.locator("ul li button");
  const nbListBtns = await listBtns.count();
  if (nbListBtns > 0) {
    await listBtns.first().click();
    await page.waitForTimeout(800);
    await page.waitForFunction(
      () => document.body.innerText.includes("Выдать под ответственность") ||
            document.body.innerText.includes("занят"),
      { timeout: 6000 }
    ).catch(() => {});
  }
  await screenshot(page, `05d-addon-conflict-warning-${label}.png`);

  // Close addon search
  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);

  // ──────────────────────────────────────────────────────────────────────────
  // Switch to RETURN flow
  // ──────────────────────────────────────────────────────────────────────────
  console.log("Navigating to RETURN flow...");
  // Back (checklist → booking list)
  let backBtn = page.locator('button[aria-label="Назад"]').first();
  if (await backBtn.isVisible().catch(() => false)) {
    await backBtn.click();
    await page.waitForTimeout(400);
  }
  // Back (booking list → operation picker)
  backBtn = page.locator('button[aria-label="Назад"]').first();
  if (await backBtn.isVisible().catch(() => false)) {
    await backBtn.click();
    await page.waitForTimeout(400);
  }
  // Should see operation picker
  const atOp = await page.locator('button:has-text("Возврат")').isVisible().catch(() => false);
  if (!atOp) {
    // Fallback
    await loginWarehouse(page);
  }

  // Clear sessions before starting return (the issue session may still be active)
  clearScanSessions();

  await page.locator('button:has-text("Возврат")').first().click();
  await page.waitForFunction(
    () => document.body.innerText.includes("Клип «Север»") ||
          document.body.innerText.includes("Нет доступных"),
    { timeout: 20000 }
  ).catch(async () => {
    const txt = await page.evaluate(() => document.body.innerText.slice(0, 300));
    console.log("  Page text after selecting RETURN:", txt);
  });
  await waitNet(page);

  // ──────────────────────────────────────────────────────────────────────────
  // SCREEN 6: Return checklist (collapsed)
  // ──────────────────────────────────────────────────────────────────────────
  console.log("6. Return checklist (collapsed)");
  const returnBookBtn = page.locator('button:has-text("Клип «Север»")').first();
  if (await returnBookBtn.isVisible().catch(() => false)) {
    await returnBookBtn.click();
  } else {
    // May also show Реклама «Орбита» if it has ISSUED units — click any
    const anyBooking = page.locator('button[aria-label*="Бронь"]').first();
    if (await anyBooking.isVisible().catch(() => false)) {
      await anyBooking.click();
    }
  }
  await page.waitForFunction(
    () => document.body.innerText.includes("Принять всё разом") ||
          document.body.innerText.includes("SkyPanel") ||
          document.body.innerText.includes("прибор"),
    { timeout: 25000 }
  ).catch(async () => {
    const txt = await page.evaluate(() => document.body.innerText.slice(0, 400));
    console.log("  Page after selecting return booking:", txt);
  });
  await waitNet(page);
  await screenshot(page, `06-return-checklist-${label}.png`);

  // ──────────────────────────────────────────────────────────────────────────
  // SCREEN 7: Repair panel (amber)
  // ──────────────────────────────────────────────────────────────────────────
  console.log("7. Return row — Repair panel (amber)");
  const repairBtns = page.locator('[aria-label*="отправить в ремонт"]');
  const nRepair = await repairBtns.count();
  console.log(`  Found ${nRepair} repair buttons`);
  if (nRepair > 0) {
    await repairBtns.first().click();
    await page.waitForTimeout(500);
    await page.waitForFunction(
      () => document.body.innerText.includes("сломалось") ||
            document.body.innerText.includes("ремонт"),
      { timeout: 5000 }
    ).catch(() => {});
  }
  await screenshot(page, `07-return-repair-panel-${label}.png`);

  // ──────────────────────────────────────────────────────────────────────────
  // SCREEN 8: Problem panel (rose) with 4 chips
  // ──────────────────────────────────────────────────────────────────────────
  console.log("8. Return row — Problem panel (rose)");
  const probBtns = page.locator('[aria-label*="зарегистрировать проблему"]');
  const nProb = await probBtns.count();
  console.log(`  Found ${nProb} problem buttons`);
  if (nProb >= 2) {
    await probBtns.nth(1).click();
  } else if (nProb === 1) {
    await probBtns.first().click();
  }
  await page.waitForTimeout(500);
  await page.waitForFunction(
    () => document.body.innerText.includes("Остался на площадке"),
    { timeout: 5000 }
  ).catch(() => {});
  await screenshot(page, `08-return-problem-chips-${label}.png`);

  // Select «Остался на площадке» → date field
  const leftOnSiteBtn = page.locator('button[aria-label*="Остался на площадке"]').first();
  if (await leftOnSiteBtn.isVisible().catch(() => false)) {
    await leftOnSiteBtn.click();
    await page.waitForTimeout(300);
    await screenshot(page, `08b-problem-left-on-site-${label}.png`);
  } else {
    await screenshot(page, `08b-problem-left-on-site-${label}.png`);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // SCREEN 9: Completion result
  // ──────────────────────────────────────────────────────────────────────────
  console.log("9. Return completion result");
  // Accept remaining units (3rd and beyond if any)
  const acceptBtns = page.locator('[aria-label*="принять без замечаний"]');
  const nAccept = await acceptBtns.count();
  // Accept the ones not yet in repair/problem state
  for (let i = 0; i < nAccept; i++) {
    const btn = acceptBtns.nth(i);
    const pressed = await btn.getAttribute("aria-pressed");
    if (pressed !== "true") {
      await btn.click({ force: true });
      await page.waitForTimeout(200);
    }
  }

  // Fill repair comment
  const repairArea = page.locator('textarea[placeholder="Что sломалось?"]').first();
  const repairAreaAlt = page.locator('textarea').filter({ hasText: "" }).first();
  if (await repairArea.isVisible().catch(() => false)) {
    await repairArea.fill("Разбит байонет");
  }

  // Fill all textarea (repair + problem comments)
  const allTextareas = page.locator("textarea");
  const nTA = await allTextareas.count();
  for (let i = 0; i < nTA; i++) {
    const ta = allTextareas.nth(i);
    const val = await ta.inputValue();
    if (val.trim() === "" && await ta.isVisible().catch(() => false)) {
      await ta.fill("Комментарий оператора");
    }
  }

  // Ensure a problem reason is selected
  const anyReason = page.locator('[role="radio"][aria-checked="true"]').first();
  if (!(await anyReason.isVisible().catch(() => false))) {
    const lostBtn = page.locator('[aria-label*="Причина: Потерян"]').first();
    if (await lostBtn.isVisible().catch(() => false)) {
      await lostBtn.click();
      await page.waitForTimeout(200);
    }
  }

  const completeBtn = page.locator('button[aria-label*="Завершить приёмку"]').first();
  if (await completeBtn.isVisible().catch(() => false)) {
    await completeBtn.click();
    await page.waitForTimeout(3000);
  }
  await waitNet(page);
  await screenshot(page, `09-return-result-${label}.png`);

  // ──────────────────────────────────────────────────────────────────────────
  // SCREEN 10: Desktop two-pane (1440 only)
  // ──────────────────────────────────────────────────────────────────────────
  if (label === "1440") {
    console.log("10. Desktop two-pane");
    clearScanSessions();
    await loginWarehouse(page);
    await page.locator('button:has-text("Выдача")').first().click();
    await page.waitForFunction(
      () => document.body.innerText.includes("Реклама «Орбита»"),
      { timeout: 15000 }
    );
    // Select the booking — now shows two-pane at 1440
    await page.locator('button:has-text("Реклама «Орбита»")').first().click();
    await page.waitForFunction(
      () => document.body.innerText.includes("Выдать всё разом") ||
            document.body.innerText.includes("Aputure"),
      { timeout: 20000 }
    );
    await waitNet(page);
    await screenshot(page, `10-desktop-two-pane-${label}.png`);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // ──────────────────────────────────────────────────────────────────────────
  // SCREEN 11: /warehouse/problems (Потеряшки registry — admin JWT required)
  // Requires ProblemItems seeded (SEARCHING + EXPECTED) so the registry rows
  // and action buttons are visible.
  // ──────────────────────────────────────────────────────────────────────────
  console.log("11. /warehouse/problems (Потеряшки registry — populated)");

  // Navigate to /login and authenticate as admin (JWT cookie required).
  await page.goto(`${BASE}/login`);
  await page.waitForLoadState("domcontentloaded");
  await page.waitForTimeout(1000);

  const usernameEl = page.locator("input").first();
  const passwordEl = page.locator('input[type="password"]').first();
  if (await usernameEl.isVisible().catch(() => false)) {
    await usernameEl.fill("admin");
    await passwordEl.fill("admin123");
    await page.locator('button[type="submit"]').click();
    // Wait for redirect away from /login — means session cookie is set.
    await page.waitForFunction(
      () => !window.location.pathname.startsWith("/login"),
      { timeout: 10000 },
    ).catch(() => {});
    await waitNet(page);
  }

  await page.goto(`${BASE}/warehouse/problems`);
  await waitNet(page);

  // Wait until the page renders actual rows (not empty state) — the seeded
  // ProblemItems must be visible. Bail if the empty state text appears instead.
  const hasRows = await page.waitForFunction(
    () => {
      // Either the «Найдено»/«Не найдено» buttons are present (rows loaded)
      // or the page still shows loading skeleton / empty state.
      const foundBtns = document.querySelectorAll('button[aria-label*="Найдено"]');
      return foundBtns.length > 0;
    },
    { timeout: 12000 },
  ).then(() => true).catch(() => false);

  const pageText = await page.evaluate(() => document.body.innerText.slice(0, 200));
  console.log(`  Problems page text snippet: ${pageText.replace(/\n/g, " ").slice(0, 120)}`);
  console.log(`  Has rows with action buttons: ${hasRows}`);

  // SCREEN 11: populated registry list
  await screenshot(page, `11-problems-list-${label}.png`);

  // SCREEN 11b: resolve modal — click «Найдено» on the first open row.
  // If hasRows is false the modal cannot be captured honestly; log the blocker.
  const foundBtnLocator = page.locator('button[aria-label*="Найдено"]').first();
  const foundBtnVisible = await foundBtnLocator.isVisible().catch(() => false);

  if (foundBtnVisible) {
    await foundBtnLocator.click();
    // Wait for the dialog to appear (role=dialog is present in ResolveProblemModal).
    await page.waitForFunction(
      () => document.querySelector('[role="dialog"]') !== null,
      { timeout: 5000 },
    ).catch(() => {});
    await page.waitForTimeout(300);

    const dialogVisible = await page.locator('[role="dialog"]').isVisible().catch(() => false);
    console.log(`  ResolveProblemModal dialog visible: ${dialogVisible}`);

    await screenshot(page, `11b-problems-resolve-modal-${label}.png`);
    // Close modal via Escape so state is clean.
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
  } else {
    console.log("  WARNING: «Найдено» button not visible — modal NOT captured.");
    console.log("  This would be a BLOCKER; check that ProblemItems were seeded.");
    await screenshot(page, `11b-problems-resolve-modal-${label}.png`);
  }

  await context.close();
  console.log(`Completed viewport ${label}`);
}

function reseedFidelityData(): void {
  // Re-run the seed to restore ISSUED units (SkyPanel S60) and ISSUED booking
  // after the 375 run completes the return and transitions units to AVAILABLE.
  const repoRoot = path.join(__dirname, "..");
  execSync("npx tsx apps/api/scripts/seed-warehouse-fidelity.ts", {
    cwd: repoRoot,
    stdio: "pipe",
  });
  console.log("  Re-seeded fidelity data (SkyPanel units restored to ISSUED)");
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  try {
    for (let i = 0; i < WIDTHS.length; i++) {
      if (i > 0) {
        // Re-seed between viewport runs to restore return-booking state.
        reseedFidelityData();
      }
      await runAtWidth(browser, WIDTHS[i]);
    }
    console.log("\nAll screenshots captured.");
    console.log(`Output: ${OUT}`);
    console.log(`Screenshots: ${fs.readdirSync(OUT).filter(f => f.endsWith(".png")).length}`);
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  console.error("Fidelity walkthrough FAILED:", e);
  process.exit(1);
});
