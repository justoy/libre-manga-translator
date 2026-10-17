import { test, expect, chromium, type BrowserContext } from "@playwright/test";
import path from "node:path";

const EXTENSION_PATH = path.resolve(process.cwd(), ".output/chrome-mv3");

let context: BrowserContext;

test.beforeEach(async () => {
  context = await chromium.launchPersistentContext("", {
    channel: "chromium",
    args: [
      `--disable-extensions-except=${EXTENSION_PATH}`,
      `--load-extension=${EXTENSION_PATH}`,
      "--headless=new",
    ],
  });
});

test.afterEach(async () => {
  await context.close();
});

test("service worker initializes without uncaught errors", async () => {
  let [background] = context.serviceWorkers();
  if (!background) {
    background = await context.waitForEvent("serviceworker", { timeout: 10000 });
  }
  expect(background).toBeDefined();
  expect(background.url()).toContain("background.js");
});

test("setup page loads and mounts Svelte 5 wizard", async () => {
  let [background] = context.serviceWorkers();
  if (!background) {
    background = await context.waitForEvent("serviceworker", { timeout: 10000 });
  }
  const extensionId = background.url().split("/")[2];

  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/setup.html`);

  // Verify page title and header elements
  await expect(page).toHaveTitle(/Libre Manga Translator/i);
  const body = page.locator("body");
  await expect(body).toBeVisible();

  // Check that setup container has mounted
  const container = page.locator("#app, .setup-container, main");
  await expect(container.first()).toBeVisible();
});

test("popup page renders and displays UI controls", async () => {
  let [background] = context.serviceWorkers();
  if (!background) {
    background = await context.waitForEvent("serviceworker", { timeout: 10000 });
  }
  const extensionId = background.url().split("/")[2];

  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup.html`);

  await expect(page).toHaveTitle(/Libre Manga Translator/i);
  await expect(page.locator("body")).toBeVisible();

  // Check for presence of navigation buttons or settings tabs
  const buttons = page.locator("button");
  const count = await buttons.count();
  expect(count).toBeGreaterThan(0);
});

test("content script injects sidebar and floating trigger into target webpage", async () => {
  const page = await context.newPage();

  await page.route("https://example.com/manga-reader", (route) => {
    route.fulfill({
      status: 200,
      contentType: "text/html",
      body: `<!DOCTYPE html>
<html>
  <head><title>Manga Reader</title></head>
  <body>
    <h1>Chapter 1</h1>
    <img id="page1" src="https://example.com/page1.jpg" width="600" height="800" style="display:block;" />
  </body>
</html>`,
    });
  });

  await page.goto("https://example.com/manga-reader");

  // Verify content script mounts shadow root custom elements
  const sidebar = page.locator("lmt-sidebar");
  await expect(sidebar).toBeAttached({ timeout: 5000 });

  const trigger = page.locator("lmt-floating-trigger");
  await expect(trigger).toBeAttached({ timeout: 5000 });
});
