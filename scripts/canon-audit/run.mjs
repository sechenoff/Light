/**
 * Gaffer CRM Canon Parity Audit — Sprint 2 Wave A
 * Captures app screenshots at 390/768/1280 and mockup screenshots.
 * Not committed — output only.
 */

import { chromium } from "playwright";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(__dirname, "../../docs/qa/playwright-2026-04-20-canon");
fs.mkdirSync(OUT, { recursive: true });

const WIDTHS = [390, 768, 1280];
const APP_BASE = "http://localhost:3000";
const API_BASE = "http://localhost:4000";
const MOCKUP_DIR = path.resolve(__dirname, "../../docs/mockups");

const AUDIT_EMAIL = "audit@example.com";

// Known IDs from seed
const PROJECT_ID = "cmo7nt7ai0003vafeftzgr4dm";
const CLIENT_ID = "cmo7nsx0j0001vaee84idvohu";
const TEAM_ID = "cmo7nt7ag0001vafen9e51nr5";

async function getSessionToken() {
  const resp = await fetch(`${API_BASE}/api/gaffer/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: AUDIT_EMAIL }),
  });
  const data = await resp.json();
  if (!data.token) throw new Error(`Login failed: ${JSON.stringify(data)}`);
  console.log("Session token acquired");
  return data.token;
}

async function screenshot(page, name) {
  const p = path.join(OUT, `${name}.png`);
  await page.screenshot({ path: p, fullPage: true });
  console.log(`  saved: ${name}.png`);
}

// Capture app page at given width, using a fresh browser context with session cookie
async function captureAppPage(browser, id, url, width, sessionToken) {
  const ctx = await browser.newContext({ viewport: { width, height: 900 } });
  await ctx.addCookies([{
    name: "gaffer_session",
    value: sessionToken,
    domain: "localhost",
    path: "/",
    httpOnly: false,
    secure: false,
  }]);
  const page = await ctx.newPage();
  try {
    await page.goto(`${APP_BASE}${url}`, { waitUntil: "networkidle", timeout: 30000 });
    await page.waitForTimeout(1500);
    await screenshot(page, `${id}-${width}`);
  } catch (err) {
    console.error(`  ERROR app ${id}@${width}: ${err.message}`);
    try { await screenshot(page, `${id}-${width}`); } catch (_) {}
  } finally {
    await ctx.close();
  }
}

// Capture unauthenticated app page
async function capturePublicPage(browser, id, url, width) {
  const ctx = await browser.newContext({ viewport: { width, height: 900 } });
  const page = await ctx.newPage();
  try {
    await page.goto(`${APP_BASE}${url}`, { waitUntil: "networkidle", timeout: 30000 });
    await page.waitForTimeout(1000);
    await screenshot(page, `${id}-${width}`);
  } catch (err) {
    console.error(`  ERROR public ${id}@${width}: ${err.message}`);
    try { await screenshot(page, `${id}-${width}`); } catch (_) {}
  } finally {
    await ctx.close();
  }
}

// Capture a section from gaffer-crm.html by section index
async function captureMockupSection(browser, htmlFile, sectionIdx, id, width) {
  const fileUrl = `file://${MOCKUP_DIR}/${htmlFile}`;
  const ctx = await browser.newContext({ viewport: { width, height: 900 } });
  const page = await ctx.newPage();
  try {
    await page.goto(fileUrl, { waitUntil: "domcontentloaded", timeout: 15000 });
    await page.waitForTimeout(300);

    const sections = await page.locator(".screen-heading").all();
    if (sectionIdx >= 0 && sectionIdx < sections.length) {
      await sections[sectionIdx].scrollIntoViewIfNeeded();
      await page.waitForTimeout(200);
      const parentHandle = await sections[sectionIdx].evaluateHandle(el => {
        let p = el.parentElement;
        while (p && !p.classList.contains("frame-row")) p = p.parentElement;
        return p || el;
      });
      const box = await parentHandle.asElement()?.boundingBox();
      if (box) {
        const pad = 20;
        await page.screenshot({
          path: path.join(OUT, `${id}-mockup-${width}.png`),
          clip: {
            x: Math.max(0, box.x - pad),
            y: Math.max(0, box.y - pad),
            width: Math.min(width + pad * 2, box.width + pad * 2),
            height: Math.min(box.height + pad * 2, 5000),
          },
        });
        console.log(`  saved: ${id}-mockup-${width}.png`);
        return;
      }
    }
    await screenshot(page, `${id}-mockup-${width}`);
  } catch (err) {
    console.error(`  ERROR mockup ${id}@${width}: ${err.message}`);
  } finally {
    await ctx.close();
  }
}

// Capture full-page mockup HTML file
async function captureMockupFull(browser, htmlFile, id, width) {
  const fileUrl = `file://${MOCKUP_DIR}/${htmlFile}`;
  const ctx = await browser.newContext({ viewport: { width, height: 900 } });
  const page = await ctx.newPage();
  try {
    await page.goto(fileUrl, { waitUntil: "domcontentloaded", timeout: 15000 });
    await page.waitForTimeout(300);
    await screenshot(page, id);
  } catch (err) {
    console.error(`  ERROR mockup-full ${id}@${width}: ${err.message}`);
  } finally {
    await ctx.close();
  }
}

async function main() {
  console.log("Starting canon parity audit...\n");
  const sessionToken = await getSessionToken();
  const browser = await chromium.launch({ headless: true });

  // Screen matrix
  const screens = [
    { id: "01",    route: "/gaffer/login",                public: true,  mockupFile: "gaffer-crm.html", sectionIdx: 0 },
    { id: "01b",   route: "/gaffer/register",             public: true,  mockupFile: "gaffer-crm.html", sectionIdx: 1 },
    { id: "01c",   route: "/gaffer/welcome",              public: false, mockupFile: "gaffer-crm.html", sectionIdx: 2 },
    { id: "02",    route: "/gaffer",                      public: false, mockupFile: "gaffer-crm.html", sectionIdx: 3 },
    { id: "03",    route: "/gaffer/projects",             public: false, mockupFile: "gaffer-crm.html", sectionIdx: 4 },
    { id: "04",    route: `/gaffer/projects/${PROJECT_ID}`, public: false, mockupFile: "gaffer-crm.html", sectionIdx: 5 },
    { id: "05",    route: `/gaffer/contacts/${CLIENT_ID}`,  public: false, mockupFile: "gaffer-crm.html", sectionIdx: 6 },
    { id: "06",    route: `/gaffer/contacts/${TEAM_ID}`,    public: false, mockupFile: "gaffer-crm.html", sectionIdx: 7 },
    { id: "07",    route: "/gaffer/contacts",             public: false, mockupFile: "gaffer-crm.html", sectionIdx: 8 },
    { id: "08",    route: "/gaffer/projects/new",         public: false, mockupFile: "gaffer-crm.html", sectionIdx: 9 },
    { id: "bonus", route: "/gaffer/obligations",          public: false, mockupFile: null, sectionIdx: -1 },
  ];

  for (const screen of screens) {
    console.log(`\n=== Screen ${screen.id}: ${screen.route} ===`);
    for (const width of WIDTHS) {
      if (screen.public) {
        await capturePublicPage(browser, screen.id, screen.route, width);
      } else {
        await captureAppPage(browser, screen.id, screen.route, width, sessionToken);
      }
      if (screen.mockupFile) {
        await captureMockupSection(browser, screen.mockupFile, screen.sectionIdx, screen.id, width);
      }
    }
  }

  // Extra mockup files
  console.log("\n=== Extra mockup files ===");
  for (const width of WIDTHS) {
    await captureMockupFull(browser, "gaffer-crm-project-card-full.html", `04-project-card-full-mockup-${width}`, width);
    await captureMockupFull(browser, "gaffer-crm-project-header.html", `04-project-header-mockup-${width}`, width);
    await captureMockupFull(browser, "gaffer-crm-member-projects-variants.html", `05-member-projects-variants-mockup-${width}`, width);
    await captureMockupFull(browser, "gaffer-crm-team-variants.html", `06-team-variants-mockup-${width}`, width);
  }

  await browser.close();
  console.log("\nDone! Screenshots saved to:", OUT);
}

main().catch(err => {
  console.error("FATAL:", err);
  process.exit(1);
});
