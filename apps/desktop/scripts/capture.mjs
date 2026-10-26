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
  // `detached`: il figlio guida un proprio gruppo di processi (pnpm → vite),
  // che a fine corsa si uccide intero con `-pid`; senza, resta vivo vite.
  const child = spawn("pnpm", ["run", "preview:web"], { cwd: root, stdio: "ignore", detached: true });
  for (let i = 0; i < 100; i++) {
    if (await isUp()) return child;
    await new Promise((r) => setTimeout(r, 300));
  }
  stopServer(child);
  throw new Error("preview:web non è partito entro 30 s");
}

function stopServer(child) {
  if (!child?.pid) return;
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill();
  }
}

/** Fa avanzare l'orologio fermo di `ms`, a passi, lasciando respirare React. */
async function drive(page, ms) {
  for (let done = 0; done < ms; done += 50) {
    await page.clock.runFor(50);
    await page.waitForTimeout(10);
  }
}

/** Come `drive`, finché `locator` non compare (al massimo 10 s di orologio). */
async function driveUntil(page, locator) {
  for (let t = 0; t < 10_000; t += 50) {
    if (await locator.isVisible()) return;
    await page.clock.runFor(50);
    await page.waitForTimeout(10);
  }
  throw new Error("elemento non comparso con l'orologio fermo");
}

const WIDE = { width: 1440, height: 900 };
const NARROW = { width: 1024, height: 680 };

async function main() {
  await mkdir(outDir, { recursive: true });
  const server = await ensureServer();
  const browser = await chromium.launch();
  try {
    // «Vedi come»: il menu del profilo, poi la persona; Esc può aver chiuso
    // anche il pannello aperto dall indirizzo, che si riscrive.
    async function asPerson(page, persona, hash) {
      await page.getByRole("button", { name: /^(Profile and settings|Profilo e impostazioni)/ }).click();
      await page.getByRole("radio", { name: new RegExp(persona) }).click();
      await page.keyboard.press("Escape");
      await page.evaluate((h) => {
        window.location.hash = h;
      }, hash);
    }
    async function open(scheme, viewport, hash, { lang = "en", persona, frozen = false, viaHome = false } = {}) {
      const context = await browser.newContext({
        viewport,
        colorScheme: scheme,
        reducedMotion: "reduce",
        deviceScaleFactor: 1,
      });
      // `frozen`: orologio della pagina fermo; latenze e pezzi dello stream
      // avanzano solo con `drive`, così lo scatto cade in un punto
      // deterministico del flusso (senza, bastano 900 ms reali).
      if (frozen) {
        await context.clock.install({ time: new Date("2026-10-24T09:00:00Z") });
        await context.clock.pauseAt(new Date("2026-10-24T09:00:01Z"));
      }
      const page = await context.newPage();
      await page.addInitScript((l) => {
        try {
          window.localStorage.setItem("stubwise.language", l);
        } catch {
          /* niente storage: resta la lingua di default */
        }
      }, lang);
      // `viaHome`: la pagina può non esistere per la persona di partenza (una
      // conversazione altrui): si entra dalla Home e si riscrive l indirizzo.
      await page.goto(`${BASE}#${viaHome ? "/home" : hash}`);
      if (frozen) await driveUntil(page, page.getByRole("heading", { level: 1 }).first());
      else await page.getByRole("heading", { level: 1 }).first().waitFor();
      if (persona) {
        // «Vedi come»: il menu del profilo, poi la persona.
        await page.getByRole("button", { name: /^(Profile and settings|Profilo e impostazioni)/ }).click();
        await page.getByRole("radio", { name: new RegExp(persona) }).click();
        await page.keyboard.press("Escape");
        // Esc può aver chiuso anche il pannello aperto dall'indirizzo: lo si riscrive.
        await page.evaluate((h) => {
          window.location.hash = h;
        }, hash);
      }
      // Il puntatore lontano dal binario: sull'avatar del profilo il suo
      // suggerimento coprirebbe la colonna. Nemmeno il fuoco: chiuso il menu
      // del profilo torna sul bottone, che mostrerebbe lo stesso suggerimento.
      await page.mouse.move(viewport.width - 2, viewport.height - 2);
      if (persona) {
        await page.evaluate(() => {
          const active = document.activeElement;
          if (active instanceof HTMLButtonElement) active.blur();
        });
      }
      // Latenza simulata dei dati finti (150–400 ms): lascia assestare.
      if (!frozen) await page.waitForTimeout(900);
      return { page, context };
    }
    const shot = async (page, name) => {
      await page.screenshot({ path: resolve(outDir, name) });
      console.log("scritto", name);
    };

    // Area 3: Claude. `CAPTURE_ONLY=<regex>` ne limita le pagine (revisione
    // mirata); le sessioni dal vivo si scattano con l'orologio fermo.
    const only = process.env.CAPTURE_ONLY ? new RegExp(process.env.CAPTURE_ONLY) : null;
    const AREA3 = [
      // [nome, indirizzo, { persona, frozen, steps(page), narrow }]
      ["claude-landing", "/claude", { narrow: true }],
      ["claude-list-mine", "/claude?scope=mine", {}],
      // Conversazione libera: markdown, codice, citazioni; poi la proposta.
      ["conversation-markdown", "/claude/cv-marco-import", { persona: "Marco", narrow: true }],
      ["conversation-proposal", "/claude/cv-giulia-subjects", { narrow: true }],
      // Sessione di una task dal vivo, ferma a metà del flusso.
      ["session-live", "/claude/cv-run-mkx-11", { frozen: true, steps: (p) => drive(p, 400) }],
      // Carta del piano (Marco non approva: la carta dice chi può) e domanda.
      ["session-plan", "/claude/cv-run-stw-13", { persona: "Marco" }],
      ["session-question", "/claude/cv-run-mkx-11", { frozen: true, steps: (p) => drive(p, 20000) }],
      // Pubblica, letta da chi non è il proprietario: l'appendice privata e il seguito.
      // Giulia continua la sua conversazione già pubblica (coda privata), poi
      // la legge Marco: la pubblica finisce dove si è pubblicato, il resto è privato.
      ["conversation-public", "/claude/cv-giulia-callbacks", {
        steps: async (p) => {
          await p.locator("textarea").last().fill("Explain MKX-3, the media plan, for the same customer");
          await p.keyboard.press("Enter");
          await p.waitForTimeout(3500);
          await asPerson(p, "Marco", "/claude/cv-giulia-callbacks");
          // Dopo il cambio di persona la conversazione si riapre in fondo da sola.
          await p.waitForTimeout(1200);
        },
      }],
      ["conversation-continuation", "/claude/cv-giulia-callbacks", {
        persona: "Marco",
        steps: async (p) => {
          await p.locator("textarea").last().fill("Can you check the same for Stubwise?");
          await p.keyboard.press("Enter");
          await p.waitForTimeout(3500);
        },
      }],
      // La task: sezione Claude, e «Follow here» in forma compatta.
      ["task-claude", "/p/STW/tasks?task=STW-13", {
        persona: "Laura",
        narrow: true,
        // La sezione Claude sta sotto la piega del pannello: la si porta in vista.
        steps: async (p) => {
          await p.locator("[data-claude-status]").first().scrollIntoViewIfNeeded();
          await p.waitForTimeout(300);
        },
      }],
      ["task-follow", "/p/MKX/tasks?task=MKX-11", {
        frozen: true,
        steps: async (p) => {
          const follow = p.getByRole("button", { name: /^(Follow here|Segui qui)$/ });
          await driveUntil(p, follow);
          await follow.click();
          await drive(p, 600);
        },
      }],
      ["refine", "/p/STW/requests?request=req-stw-4&refine=1", {
        persona: "Laura",
        narrow: true,
        // La sessione scrive da sé: si aspetta che la conversazione sia in pagina.
        steps: (p) => p.waitForTimeout(2500),
      }],
      // Due PR su due repository, ognuna col suo ciclo (giro, tetto).
      ["task-claude-cycles", "/p/STW/tasks?task=STW-3", {
        persona: "Laura",
        narrow: true,
        steps: async (p) => {
          await p.locator('[data-pr="58"]').evaluate((el) => el.scrollIntoView({ block: "end" }));
          await p.waitForTimeout(300);
        },
      }],
      // Fallita: il riassunto e il log della fase; i consumi aperti.
      ["task-claude-failed", "/p/STW/tasks?task=STW-7", {
        persona: "Laura",
        steps: async (p) => {
          await p.getByRole("button", { name: /^(Show log|Mostra il log)$/ }).click();
          await p.getByRole("button", { name: /^(AI usage|Consumi AI)/ }).click();
          await p.locator("[data-ai-usage]").evaluate((el) => el.scrollIntoView({ block: "end" }));
          await p.waitForTimeout(300);
        },
      }],
      // La richiesta: il prossimo passo e le proposte dell'intake.
      ["request-suggestions", "/p/MKX/requests?request=req-mkx-2", { narrow: true }],
      ["home-decide", "/home", { persona: "Laura" }],
      // Il report di oggi di STW è più vecchio degli ultimi commit: l'avviso.
      ["by-person", "/projects?view=person", { persona: "Roberta" }],
    ];
    for (const [name, hash, o] of AREA3) {
      if (only && !only.test(name)) continue;
      const variants = [];
      for (const scheme of ["light", "dark"]) {
        for (const lang of ["en", "it"]) variants.push([scheme, lang, WIDE, `a3-${name}-${scheme}-${lang}.png`]);
      }
      if (o.narrow) variants.push(["dark", "en", NARROW, `a3-${name}-narrow.png`]);
      for (const [scheme, lang, viewport, file] of variants) {
        const { page, context } = await open(scheme, viewport, hash, {
          lang,
          persona: o.persona,
          frozen: o.frozen,
          viaHome: Boolean(o.persona),
        });
        if (o.steps) await o.steps(page);
        await shot(page, file);
        await context.close();
      }
    }
    // Area 4: la Chat. Il thread con @Claude si apre dal suo conteggio di
    // risposte; il privato lo guarda Roberta (full admin: nome e membri, mai i messaggi).
    const AREA4 = [
      ["channel", "/chat/ch-aud-releases", { persona: "Laura" }],
      ["thread-claude", "/chat/ch-aud-general", {
        persona: "Marco",
        steps: async (p) => {
          await p.getByText(/^\d+ (replies|reply|risposte|risposta)$/).last().click();
          // Il puntatore via dalla radice: lo scatto mostra la selezione, non il passaggio.
          const size = p.viewportSize();
          await p.mouse.move(size.width - 2, size.height - 2);
          await p.waitForTimeout(500);
        },
      }],
      ["private-roberta", "/chat/ch-aud-pricing", { persona: "Roberta" }],
      ["channel-settings", "/chat/ch-aud-releases?settings=1", { persona: "Laura" }],
      ["search", "/chat?view=search&q=invoice", { persona: "Marco", narrow: true }],
      ["decide-chat", "/home", { persona: "Marco" }],
    ];
    for (const [name, hash, o] of AREA4) {
      if (only && !only.test(name)) continue;
      const variants = [];
      for (const scheme of ["light", "dark"]) {
        for (const lang of ["en", "it"]) variants.push([scheme, lang, WIDE, `a4-${name}-${scheme}-${lang}.png`]);
      }
      variants.push(["dark", "en", NARROW, `a4-${name}-narrow.png`]);
      for (const [scheme, lang, viewport, file] of variants) {
        const { page, context } = await open(scheme, viewport, hash, {
          lang,
          persona: o.persona,
          viaHome: Boolean(o.persona),
        });
        if (o.steps) await o.steps(page);
        // Le schede degli eventi aspettano i loro oggetti (lo scheletro non è lo scatto).
        await page
          .waitForFunction(() => !document.querySelector("[data-event-pending]"), null, { timeout: 4000 })
          .catch(() => console.warn("oggetti degli eventi non letti in tempo:", file));
        await shot(page, file);
        await context.close();
      }
    }
    // Area 5: Docs e Drive. Laura (Project Lead) ha `drive.history` e gestisce
    // il Drive; Giulia ha un account Google collegato (fuori dai progetti).
    const searchBox = (p) => p.getByRole("searchbox", { name: /^(Search files|Cerca nei file)$/ });
    // Il puntatore via dalla lista: lo scatto mostra la selezione, non un passaggio.
    const park = async (p) => {
      // Lo spazio vuoto della colonna del progetto: nessuna riga sotto, nessun suggerimento.
      const size = p.viewportSize();
      await p.mouse.move(180, size.height - 100);
      await p.waitForTimeout(300);
    };
    // L'albero delle pagine non è più lo scheletro: lo scatto è la pagina vera.
    const treeReady = async (p) => {
      // Alla larghezza minima l'albero sta in un pannello chiuso: non c'è da attendere.
      await p.locator('[role="tree"]').first().waitFor({ state: "attached", timeout: 3000 }).catch(() => {});
      await p.locator('[data-testid="doc-tree-skeleton"]').waitFor({ state: "detached" });
      await p.waitForTimeout(400);
    };
    // La home dei Docs non ha l'albero: basta che nessuno scheletro resti.
    const homeReady = async (p) => {
      await p.locator('[data-testid="doc-tree-skeleton"]').waitFor({ state: "detached" });
      await p.waitForTimeout(900);
    };
    // ⌘K dal bottone del binario (la scorciatoia dipende dalla piattaforma).
    const openPaletteButton = async (p) => {
      await p.getByRole("button", { name: /^(Search and commands|Cerca e comandi)$/ }).click();
      await p.getByRole("dialog", { name: /^(Search and commands|Cerca e comandi)$/ }).waitFor();
    };
    const askClaudeAboutContract = async (p) => {
      const lang = await p.evaluate(() => window.localStorage.getItem("stubwise.language"));
      await p.locator("textarea").last().fill(
        lang === "it"
          ? "Cosa dice il contratto col cliente sui tempi di consegna?"
          : "What does the client contract say about delivery times?",
      );
      await p.keyboard.press("Enter");
      await p.waitForTimeout(4500);
    };
    const AREA5 = [
      ["docs-home", "/p/AUD/docs", { persona: "Laura", narrow: true, steps: homeReady }],
      // Sotto i 1200 px la chat scende sotto il contenuto: «Ask the docs».
      ["docs-home-ask", "/p/AUD/docs", {
        persona: "Laura",
        narrowOnly: true,
        steps: async (p) => {
          await homeReady(p);
          await p.getByRole("region", { name: /^(Ask the docs|Chiedi ai docs)/ }).first().scrollIntoViewIfNeeded();
          await p.mouse.move(500, 300);
          await p.mouse.wheel(0, 4000);
          await park(p);
        },
      }],
      ["docs-page", "/p/AUD/docs/audin-app/scheduled-callbacks", { persona: "Laura", narrow: true, steps: treeReady }],
      ["docs-graph", "/p/STW/docs/stubwise/graph", { persona: "Laura", narrow: true, steps: treeReady }],
      ["drive-aud", "/p/AUD/drive", { persona: "Laura", narrow: true, steps: park }],
      ["drive-detail", "/p/AUD/drive?file=AUD-F7", { persona: "Laura", narrow: true, steps: park }],
      // Una cartella scelta (la frase di chi leggerà) e una già collegata in elenco.
      ["drive-link-folder", "/p/MKX/drive", {
        persona: "Giulia",
        narrow: true,
        steps: async (p) => {
          await p.getByRole("button", { name: /^(More Drive actions|Altre azioni del Drive)$/ }).click();
          await p.getByRole("menuitem", { name: /^(Link a Google folder|Collega una cartella Google)$/ }).click();
          const dialog = p.getByRole("dialog");
          await dialog.waitFor();
          await dialog.getByRole("searchbox").fill("ma");
          await dialog.getByRole("option", { name: /materiali/ }).click();
          await p.waitForTimeout(900);
          await park(p);
        },
      }],
      // Giulia ha l'account collegato: in coda «In your Google Drive».
      ["drive-search", "/p/AUD/drive", {
        persona: "Giulia",
        narrow: true,
        steps: async (p) => {
          await searchBox(p).fill("release");
          await p.waitForTimeout(1400);
          await searchBox(p).press("ArrowDown");
          await park(p);
        },
      }],
      // La stessa ricerca, in fondo: il gruppo «In your Google Drive» e la sua nota.
      ["drive-search-google", "/p/AUD/drive", {
        persona: "Giulia",
        narrow: true,
        steps: async (p) => {
          await searchBox(p).fill("release");
          await p.waitForTimeout(1400);
          await p.mouse.move(700, 400);
          await p.mouse.wheel(0, 4000);
          await park(p);
        },
      }],
      ["drive-which-project", "/drive", {
        persona: "Giulia",
        narrow: true,
        steps: async (p) => {
          await searchBox(p).fill("wine club");
          await p.locator("[data-drive-outside]").first().click();
          await p.getByRole("dialog").waitFor();
          await park(p);
          await p.waitForTimeout(900);
        },
      }],
      ["claude-cites-file", "/claude/cv-giulia-callbacks", {
        persona: "Giulia",
        narrow: true,
        steps: askClaudeAboutContract,
      }],
      // ⌘K con i gruppi «Pages» e «Files» insieme (la parola sta in una pagina e in un file).
      ["palette-files-pages", "/p/AUD/drive", {
        persona: "Laura",
        narrow: true,
        steps: async (p) => {
          await openPaletteButton(p);
          await p.getByRole("combobox").fill("export");
          await p.waitForTimeout(1200);
          // Il gruppo «Files» sta sotto «Pages»: lo si porta in vista.
          await p.getByRole("group", { name: /^(Files|File)$/ }).scrollIntoViewIfNeeded();
          await p.waitForTimeout(300);
        },
      }],
      // ⌘K dentro uno spazio Docs: ristretto a quel repository (il gettone «In audin-app docs»).
      ["palette-docs-scoped", "/p/AUD/docs/audin-app", {
        persona: "Laura",
        narrow: true,
        steps: async (p) => {
          await treeReady(p);
          await openPaletteButton(p);
          await p.getByRole("combobox").fill("callback");
          await p.waitForTimeout(1200);
        },
      }],
      // Una riga del Drive al passaggio: le azioni rapide accanto al numero delle aperture.
      ["drive-row-hover", "/p/AUD/drive", {
        persona: "Laura",
        narrow: true,
        steps: async (p) => {
          await p.locator("[data-drive-row]").nth(1).hover();
          await p.waitForTimeout(400);
        },
      }],
      // Una pagina vecchia: l'avviso coi commit successivi.
      ["docs-page-stale", "/p/AUD/docs/audin-app/exporting-the-call-history", {
        persona: "Laura",
        narrow: true,
        steps: treeReady,
      }],
      // La stessa risposta con il chip del file in primo piano: l'anteprima da 320 px.
      ["claude-cites-file-preview", "/claude/cv-giulia-callbacks", {
        persona: "Giulia",
        narrow: true,
        steps: async (p) => {
          await askClaudeAboutContract(p);
          const chip = p.locator('a[data-citation^="drive:"]').first();
          await chip.scrollIntoViewIfNeeded();
          await chip.focus();
          await p.locator('a[data-citation^="drive:"][aria-describedby]').first().waitFor();
          // L'anteprima si apre sotto il chip: si scende per vederla intera.
          await p.mouse.move(700, 300);
          await p.mouse.wheel(0, 600);
          await p.waitForTimeout(500);
        },
      }],
    ];
    for (const [name, hash, o] of AREA5) {
      if (only && !only.test(name)) continue;
      const variants = [];
      if (!o.narrowOnly) {
        for (const scheme of ["light", "dark"]) {
          for (const lang of ["en", "it"]) variants.push([scheme, lang, WIDE, `a5-${name}-${scheme}-${lang}.png`]);
        }
      }
      if (o.narrow || o.narrowOnly) variants.push(["dark", "en", NARROW, `a5-${name}-narrow.png`]);
      for (const [scheme, lang, viewport, file] of variants) {
        const { page, context } = await open(scheme, viewport, hash, {
          lang,
          persona: o.persona,
          viaHome: Boolean(o.persona),
        });
        if (o.steps) await o.steps(page);
        await shot(page, file);
        await context.close();
      }
    }
    // Area 6: Posta e Calendario. Giulia ha la casella e le proposte; l'oggi del
    // seme è fisso (2026-10-23), quindi gli id degli eventi non cambiano.
    const NEXT_REVIEW = "ev-aud-review-2026-10-29";
    const openComposer = async (p, hint) => {
      await p.getByRole("button", { name: /^(Reply|Rispondi)$/ }).first().click();
      await p.getByRole("button", { name: /^(Ask Claude|Chiedi a Claude)$/ }).click();
      const field = p.getByRole("textbox", { name: /What should it say|Cosa deve dire/ });
      await field.fill(hint);
      await field.press("Enter");
      // La bozza si scrive a pezzi: si aspetta che «Ferma» torni «Chiedi».
      await p.getByRole("button", { name: /^(Ask Claude|Chiedi a Claude)$/ }).waitFor({ timeout: 15_000 });
      await p.waitForTimeout(400);
    };
    const AREA6 = [
      ["mail-shared-proposal", "/mail/th-aud-billing-vat", { persona: "Giulia", narrow: true }],
      ["mail-transcript", "/mail/th-gemini-aud-review", { persona: "Giulia" }],
      [
        "mail-compose-claude-draft",
        "/mail/th-aud-billing-vat",
        { persona: "Giulia", steps: (p) => openComposer(p, "tell them it lands on Monday") },
      ],
      ["calendar-week", "/calendar", { persona: "Giulia", narrow: true }],
      ["calendar-new-meeting", "/calendar?newMeeting=1", { persona: "Giulia" }],
      [
        "calendar-meeting-prep",
        `/calendar?event=${NEXT_REVIEW}&date=2026-10-29`,
        {
          persona: "Giulia",
          narrow: true,
          // La scheda sta in fondo al pannello: la si porta in vista, con le tre sezioni caricate.
          steps: async (p) => {
            const sheet = p.getByRole("region", { name: /^(Prepare|Prepara)/ });
            await sheet.waitFor();
            await p.waitForTimeout(900);
            await sheet.evaluate((el) => el.scrollIntoView({ block: "start" }));
            await p.waitForTimeout(300);
          },
        },
      ],
      ["home-mail-blocks", "/home", { persona: "Giulia", narrow: true }],
    ];
    for (const [name, hash, o] of AREA6) {
      if (only && !only.test(name)) continue;
      const variants = [];
      for (const scheme of ["light", "dark"]) {
        for (const lang of ["en", "it"]) variants.push([scheme, lang, WIDE, `a6-${name}-${scheme}-${lang}.png`]);
      }
      if (o.narrow) variants.push(["dark", "en", NARROW, `a6-${name}-narrow.png`]);
      for (const [scheme, lang, viewport, file] of variants) {
        const { page, context } = await open(scheme, viewport, hash, {
          lang,
          persona: o.persona,
          viaHome: Boolean(o.persona),
        });
        if (o.steps) await o.steps(page);
        await shot(page, file);
        await context.close();
      }
    }
    if (only) return; // revisione mirata: salta il resto

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
      // Destinazione senza sottoviste: la colonna in stato neutro.
      const { page, context } = await open("dark", WIDE, "/mail");
      await shot(page, "mail-dark.png");
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

    // Area 2: ogni pagina in chiaro e scuro, inglese e italiano (1440×900);
    // le viste di Tasks e il dettaglio anche alla larghezza minima.
    const AREA2 = [
      ["home", "/home"],
      ["myweek", "/home?view=week"],
      ["tasks-list", "/p/STW/tasks"],
      ["tasks-board", "/p/STW/tasks?view=board"],
      ["tasks-timeline", "/p/STW/tasks?view=timeline"],
      ["task-detail", "/p/STW/tasks?task=STW-3"],
      ["planning", "/p/STW/planning"],
      ["planning-cross", "/planning"],
      ["requests", "/p/STW/requests?request=req-stw-1"],
      ["overview", "/p/STW/overview"],
      ["all-projects", "/projects"],
      ["filter", "/filters/flt-stalled"],
      ["all-filters", "/filters"],
      ["settings-statuses", "/p/STW/settings"],
    ];
    for (const [name, hash] of AREA2) {
      for (const scheme of ["light", "dark"]) {
        for (const lang of ["en", "it"]) {
          const { page, context } = await open(scheme, WIDE, hash, { lang });
          await shot(page, `a2-${name}-${scheme}-${lang}.png`);
          await context.close();
        }
      }
    }
    for (const [name, hash] of AREA2.filter(([n]) => /^(tasks-|task-detail|overview|requests)/.test(n))) {
      const { page, context } = await open("dark", NARROW, hash);
      await shot(page, `a2-${name}-narrow.png`);
      await context.close();
    }
    // Overview sotto la piega: cronologia e registro delle decisioni.
    for (const scheme of ["light", "dark"]) {
      const { page, context } = await open(scheme, WIDE, "/p/STW/overview");
      await page.mouse.move(900, 600);
      await page.mouse.wheel(0, 4000);
      await page.waitForTimeout(400);
      await shot(page, `a2-overview-below-${scheme}-en.png`);
      await context.close();
    }
    // La mia settimana con una storia (Marco: la barra contro la settimana solita).
    for (const scheme of ["light", "dark"]) {
      const { page, context } = await open(scheme, WIDE, "/home?view=week");
      await page.getByRole("button", { name: /^Profile and settings/ }).click();
      await page.getByRole("radio", { name: /Marco/ }).click();
      await page.keyboard.press("Escape");
      await page.waitForTimeout(900);
      await shot(page, `a2-myweek-marco-${scheme}-en.png`);
      await context.close();
    }
    // Senza permessi: Sara (Contributor, senza tickets.edit) su Tasks — il
    // pannello coi campi in sola lettura, la board che non si sposta —,
    // Requests e Settings.
    for (const [name, hash] of [
      ["tasks-list", "/p/STW/tasks?task=STW-3"],
      ["tasks-board", "/p/STW/tasks?view=board"],
      ["requests", "/p/STW/requests?request=req-stw-1"],
      ["settings-statuses", "/p/STW/settings"],
    ]) {
      const { page, context } = await open("light", WIDE, hash, { persona: "Sara" });
      await shot(page, `a2-${name}-sara.png`);
      await context.close();
    }

  } finally {
    await browser.close();
    stopServer(server);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
