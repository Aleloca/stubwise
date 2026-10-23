// Cattura gli screenshot per la revisione visiva in `.impeccable/review/`
// (ignorata da git). Avvia `preview:web` da sé, o riusa quello già in ascolto
// sulla 5174. Richiede Chromium di Playwright già installato
// (`pnpm exec playwright install chromium`).
//
//   node apps/desktop/scripts/capture.mjs
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = resolve(root, ".impeccable/review");
const PORT = 5174;
const BASE = `http://localhost:${PORT}/`;

async function isUp() {
  try {
    return (await fetch(BASE)).ok;
  } catch {
    return false;
  }
}

async function ensureServer() {
  if (await isUp()) return null;
  const child = spawn("pnpm", ["run", "preview:web"], { cwd: root, stdio: "ignore" });
  for (let i = 0; i < 100; i++) {
    if (await isUp()) return child;
    await new Promise((r) => setTimeout(r, 300));
  }
  child.kill();
  throw new Error("preview:web non è partito entro 30 s");
}

const WIDE = { width: 1440, height: 900 };
const NARROW = { width: 1024, height: 680 };

async function main() {
  await mkdir(outDir, { recursive: true });
  const server = await ensureServer();
  const browser = await chromium.launch();
  try {
    async function open(scheme, viewport, hash) {
      const context = await browser.newContext({
        viewport,
        colorScheme: scheme,
        reducedMotion: "reduce",
        deviceScaleFactor: 1,
      });
      const page = await context.newPage();
      await page.goto(`${BASE}#${hash}`);
      await page.getByRole("heading", { level: 1 }).first().waitFor();
      // Latenza simulata dei dati finti (150–400 ms): lascia assestare.
      await page.waitForTimeout(900);
      return { page, context };
    }
    const shot = async (page, name) => {
      await page.screenshot({ path: resolve(outDir, name) });
      console.log("scritto", name);
    };

    for (const scheme of ["light", "dark"]) {
      const { page, context } = await open(scheme, WIDE, "/home");
      await shot(page, `desktop-${scheme}.png`);
      await context.close();
    }

    {
      const { page, context } = await open("dark", NARROW, "/p/AUD/tasks");
      await shot(page, "narrow.png");
      await context.close();
    }

    {
      const { page, context } = await open("dark", WIDE, "/p/MKX/overview");
      await shot(page, "project-marketing.png");
      await context.close();
    }

    for (const scheme of ["dark", "light"]) {
      const suffix = scheme === "light" ? "-light" : "";
      {
        const { page, context } = await open(scheme, WIDE, "/home");
        await page.getByRole("button", { name: "Search and commands" }).click();
        await page.getByRole("dialog", { name: "Search and commands" }).waitFor();
        await page.getByRole("combobox").fill("cbv");
        await page.getByRole("group", { name: "Projects" }).waitFor();
        await page.waitForTimeout(400);
        await shot(page, `palette-open${suffix}.png`);
        await context.close();
      }
      {
        const { page, context } = await open(scheme, WIDE, "/home");
        await page.getByRole("button", { name: /^Notifications/ }).click();
        const panel = page.getByRole("dialog", { name: "Notifications" });
        await panel.waitFor();
        await panel.getByRole("listitem").first().waitFor();
        await page.waitForTimeout(400);
        await shot(page, `notifications-open${suffix}.png`);
        await context.close();
      }
    }

    {
      const { page, context } = await open("dark", WIDE, "/home");
      await page.getByRole("button", { name: "Profile and settings" }).click();
      await page.waitForTimeout(500);
      await shot(page, "profile-menu.png");
      await context.close();
    }
  } finally {
    await browser.close();
    server?.kill();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
