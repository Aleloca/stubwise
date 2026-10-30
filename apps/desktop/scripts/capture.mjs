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
      // «Vedi come» col proprietario di AUT-1 scelto: il menu del profilo aperto.
      ["view-as-matteo", "/home", {
        persona: "Matteo",
        steps: async (p) => {
          await p.getByRole("button", { name: /^(Profile and settings|Profilo e impostazioni)/ }).click();
          await p.getByRole("radiogroup").first().waitFor();
          await p.waitForTimeout(300);
        },
      }],
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
      // Scollegare l'account Google: le cartelle, e con l'account anche Posta e Calendario (area 9a).
      ["drive-google-disconnect", "/p/MKX/drive", {
        persona: "Giulia",
        narrow: true,
        steps: async (p) => {
          await p.getByRole("button", { name: /^(Profile and settings|Profilo e impostazioni)/ }).click();
          await p.getByRole("button", { name: /^(Google account|Account Google)$/ }).click();
          const dialog = p.getByRole("dialog");
          await dialog.waitFor();
          await dialog.getByRole("button", { name: /^(Disconnect|Scollega)$/ }).click();
          await p.waitForTimeout(600);
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
      // Ondata finale (revisione visiva del 26 ott): i due blocchi della Home
      // portati in vista, Day, Week col pannello e a 1024, Month.
      ...["Upcoming", "Important email"].map((block) => [
        `home-${block === "Upcoming" ? "upcoming" : "important-mail"}`,
        "/home",
        {
          persona: "Giulia",
          steps: async (p) => {
            const region = p.getByRole("region", {
              name: block === "Upcoming" ? /^(Upcoming|Prossimi appuntamenti)$/ : /^(Important email|Email importanti)$/,
            });
            await region.waitFor();
            await region.evaluate((el) => el.scrollIntoView({ block: "start" }));
            await p.waitForTimeout(400);
          },
        },
      ]),
      ["calendar-day", "/calendar?view=day&date=2026-10-28", { persona: "Giulia", narrow: true }],
      [
        "calendar-week-panel",
        `/calendar?date=2026-10-28&event=${NEXT_REVIEW}`,
        { persona: "Giulia", narrow: true },
      ],
      ["calendar-week-overlap", "/calendar?date=2026-10-28", { persona: "Giulia", narrow: true }],
      ["calendar-month", "/calendar?view=month", { persona: "Giulia", narrow: true }],
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

    // Area 7: Automations (elenco, automazione, esecuzione, sorgenti), come
    // Roberta (admin: vede tutto e ha `integrations.manage`).
    const expandLog = async (p) => {
      await p.getByRole("button", { name: /^(Expand all|Espandi tutto)$/ }).last().click();
      await p.waitForTimeout(300);
      await p.locator("[data-run-log]").evaluate((el) => el.scrollIntoView({ block: "start" }));
      await p.waitForTimeout(300);
    };
    /**
     * Matteo non è fra le persone di «Vedi come»: per vedere «Decide» con le
     * sue decisioni le si danno a Roberta, rendendola proprietaria di AUD-A1
     * e AUT-1 nel livello dati finto della pagina (lo stesso modulo che usa
     * l'app, servito da vite), poi si rilegge la Home.
     */
    async function robertaDecides(p) {
      await p.evaluate(async () => {
        const { state } = await import("/data/store.ts");
        for (const a of state.automations) {
          if (a.code === "AUD-A1" || a.code === "AUT-1") a.ownerId = "p-roberta";
        }
      });
      await p.evaluate(() => {
        window.location.hash = "/automations";
      });
      await p.waitForTimeout(500);
      await p.evaluate(() => {
        window.location.hash = "/home";
      });
      await p.waitForTimeout(900);
    }
    const AREA7 = [
      // Task 8, i punti d'ingresso: «Decide» e la Home di Matteo (approva
      // l'email di AUD-A1 #1, sceglie il progetto di AUT-1 #2), la sezione
      // del progetto, l'origine di una task, ⌘K.
      ["entry-decide", "/home", { steps: robertaDecides }],
      ["entry-home-block", "/home", { steps: async (p) => {
        await robertaDecides(p);
        await p.getByRole("button", { name: /^(Customize|Personalizza)$/ }).click();
        const mine = p.getByRole("menuitem", { name: /^(My Home|La mia Home)$/ });
        if (await mine.count()) await mine.click();
        await p.getByRole("button", { name: /^(Add block|Aggiungi blocco)$/ }).click();
        await p.getByRole("menuitem", { name: /^(Automations|Automazioni)$/ }).click();
        await p.getByRole("button", { name: /^(Done|Fatto)$/ }).click();
        await p.waitForTimeout(600);
        const block = p.getByRole("region", { name: /^(Automations|Automazioni)$/ });
        await block.scrollIntoViewIfNeeded();
        await p.waitForTimeout(300);
      } }],
      ["entry-project", "/p/AUD/automations", {}],
      ["entry-project-sara", "/p/CBV/automations", { persona: "Sara" }],
      ["entry-task-origin", "/p/CBV/tasks?task=CBV-6", {}],
      ["entry-task-origin-sara", "/p/CBV/tasks?task=CBV-6", { persona: "Sara" }],
      ["entry-palette", "/home", { steps: async (p) => {
        await p.getByRole("button", { name: /^(Search and commands|Cerca e comandi)/ }).click();
        await p.getByRole("combobox").fill("aud-a1");
        await p.getByRole("group", { name: /^(Automations|Automazioni)$/ }).waitFor();
        await p.waitForTimeout(400);
      } }],
      ["automations-list", "/automations", {}],
      ["automations-runs", "/automations?view=runs", {}],
      ["automations-attention", "/automations?view=attention", {}],
      ["automation-detail", "/automations/AUD-A1", {}],
      ["automation-detail-general", "/automations/AUT-1", {}],
      ["automation-detail-draft", "/automations/STW-A1", {}],
      ["automation-detail-paused", "/automations/BTG-A1", {}],
      ["run-approval", "/automations/AUD-A1/runs/1", {}],
      ["run-waiting", "/automations/AUD-A1/runs/2", {}],
      ["run-done", "/automations/AUT-1/runs/1", { steps: expandLog }],
      ["run-failed", "/automations/BTG-A1/runs/1", {}],
      ["run-project", "/automations/AUT-1/runs/2", {}],
      ["sources", "/automations/sources", {}],
      ["sources-panel", "/automations/sources?source=src-hubspot", {}],
      ["sources-webhook", "/automations/sources?source=src-webhook", {}],
      // Task 6: il costruttore. Il momento focale è il passo di Claude di AUT-1.
      ["builder-general", "/automations/AUT-1/edit?step=0", {}],
      ["builder-client", "/automations/AUD-A1/edit?step=3/then/0", {}],
      ["builder-start", "/automations/AUD-A1/edit?step=trigger", {}],
      ["builder-draft", "/automations/STW-A1/edit?step=0/bug/0", {}],
      [
        "builder-problem",
        "/automations/AUT-1/edit",
        {
          // Claude scende sotto il traguardo: il dato del traguardo non c'è più.
          steps: async (p) => {
            await p.locator('[data-tree-row="nc-read"]').focus();
            await p.keyboard.press("Alt+ArrowDown");
            await p.waitForTimeout(900);
            await p.locator('[data-tree-row="nc-milestone"] [id="row-text-nc-milestone"]').click();
            await p.waitForTimeout(300);
          },
        },
      ],
      // Task 7: la prova (Roberta, admin). AUD-A1 è accesa: si prova la versione 1,
      // col proprietario di adesso (Matteo, che ha la casella).
      ["test-example", "/automations/AUD-A1/test", { steps: async (p) => {
        await p.locator("[data-example]").first().waitFor();
        await p.waitForTimeout(300);
      } }],
      ["test-wait", "/automations/AUD-A1/test", { steps: async (p) => {
        await testStart(p, "Cantina Bellavista");
        await p.locator("[data-next-step]").click();
        await p.locator("[data-stop-primary]").click();
        await p.locator("[data-reply-composer] textarea").fill("Gli orari di apertura sono dalle 9 alle 18.");
        await p.waitForTimeout(300);
      } }],
      // Il momento focale: l'approvazione nella prova, con l'email intera e chi approverebbe davvero.
      ["test-stop", "/automations/AUD-A1/test", { steps: async (p) => {
        await testStart(p, "Cantina Bellavista");
        await p.locator("[data-next-step]").click();
        await p.locator("[data-stop-primary]").click();
        await p.locator("[data-reply-composer] textarea").fill("Gli orari di apertura sono dalle 9 alle 18.");
        await p.locator("[data-reply-composer] [type=submit]").click();
        await p.waitForTimeout(400);
        await p.locator("[data-run-to-stop]").click();
        await p.locator("[data-real-approver]").waitFor();
        await p.waitForTimeout(400);
      } }],
      ["test-final", "/automations/AUD-A1/test", { steps: async (p) => {
        await testStart(p, "Cantina Bellavista");
        await p.locator("[data-next-step]").click();
        await p.locator("[data-stop-primary]").click();
        await p.locator("[data-reply-composer] textarea").fill("I numeri da collegare sono 0577 000111 e 0577 000112; gli orari di apertura dalle 9 alle 18; il messaggio di benvenuto: «Benvenuti in cantina».");
        await p.locator("[data-reply-composer] [type=submit]").click();
        await p.waitForTimeout(400);
        await p.locator("[data-run-to-stop]").click();
        await p.locator("[data-test-final]").waitFor();
        await p.waitForTimeout(400);
      } }],
      // Nuovo contratto provato da Roberta (la bozza: il proprietario sarebbe lei): i giri e l'email che fallirebbe.
      ["test-rounds", "/automations/AUT-1/test", { steps: async (p) => {
        await testStart(p, 2);
        await p.locator("[data-run-to-stop]").click();
        await p.locator("[data-real-approver]").waitFor();
        // A 1024 il pannello sovrapposto copre il flusso: si chiude prima.
        if (await p.locator('[data-mode="overlay"]').count()) await p.keyboard.press("Escape");
        await p.getByRole("button", { name: /^(All rounds|Tutti i giri)$/ }).click();
        await p.waitForTimeout(400);
      } }],
      // Ondata finale: l'approvazione che fallirebbe (Roberta senza casella), e dove si ferma.
      ["test-fail-stop", "/automations/AUT-1/test", { steps: async (p) => {
        await testStart(p, 2);
        await p.locator("[data-run-to-stop]").click();
        await p.locator("[data-preview-failure]").waitFor();
        await p.waitForTimeout(400);
      } }],
      ["test-fail-end", "/automations/AUT-1/test", { steps: async (p) => {
        await testStart(p, 2);
        await p.locator("[data-run-to-stop]").click();
        await p.locator("[data-preview-failure]").waitFor();
        await p.locator("[data-stop-primary]").click();
        await p.locator("[data-test-stopped]").waitFor();
        await p.waitForTimeout(400);
      } }],
      // «Where» a righe, e il chip «Add step here» al passaggio del puntatore.
      ["builder-where", "/automations/STW-A1/edit?step=tr-bug", { steps: async (p) => {
        await p.getByRole("radiogroup", { name: /^(Where|Dove)$/ }).scrollIntoViewIfNeeded();
        await p.locator(`[data-tree-row="tr-bug"] > div`).first().hover().catch(() => {});
        await p.waitForTimeout(300);
      } }],
    ];
    /** La prova: l'esempio `index` fra i recenti, poi «Start test». */
    async function testStart(p, which) {
      // Un indice, o il nome del cliente (gli esempi stanno dal più recente).
      const example =
        typeof which === "number"
          ? p.locator(`[data-example="${which}"]`)
          : p.locator("[data-example]").filter({ hasText: which });
      await example.click();
      await p.locator("[data-start-test]").click();
      await p.locator("[data-example-line]").waitFor();
      await p.waitForTimeout(300);
    }
    for (const [name, hash, o] of AREA7) {
      if (only && !only.test(name)) continue;
      const variants = [];
      for (const scheme of ["light", "dark"]) {
        for (const lang of ["en", "it"]) variants.push([scheme, lang, WIDE, `a7-${name}-${scheme}-${lang}.png`]);
      }
      variants.push(["light", "en", NARROW, `a7-${name}-narrow.png`]);
      for (const [scheme, lang, viewport, file] of variants) {
        const { page, context } = await open(scheme, viewport, hash, {
          lang,
          persona: o.persona ?? "Roberta",
          viaHome: true,
        });
        if (o.steps) await o.steps(page);
        await shot(page, file);
        await context.close();
      }
    }

    // Area 8a, Task 7: gli avvisi — Preferenze → Notifiche, il popover del
    // progetto, «⋯» nel pannello delle notifiche.
    const AREA8A_ALERTS = [
      ["alerts-prefs", "/preferences/notifications", { persona: "Laura" }],
      ["alerts-prefs-marco", "/preferences/notifications", { persona: "Marco" }],
      // Roberta (admin): ~50 progetti, gli altri chiusi con la sintesi.
      ["alerts-prefs-50", "/preferences/notifications", { persona: "Roberta", steps: async (p) => {
        await p.locator('[data-group-header="AUD"]').click();
        await p.locator('[data-group-header="STW"]').click();
        await p.waitForTimeout(300);
      } }],
      ["alerts-copy", "/preferences/notifications", { persona: "Laura", steps: async (p) => {
        await p.getByRole("button", { name: /^(Alert actions for AUD|Azioni sugli avvisi di AUD)$/ }).click();
        await p.getByRole("menuitem", { name: /^(Same as another project…|Come un altro progetto…)$/ }).click();
        await p.getByRole("menuitem", { name: /ELS/ }).click();
        await p.waitForTimeout(400);
      } }],
      ["alerts-popover", "/p/AUD/overview", { persona: "Laura", steps: async (p) => {
        await p.getByRole("button", { name: /^(Alerts for AUD|Avvisi di AUD)$/ }).click();
        await p.waitForTimeout(400);
      } }],
      ["alerts-panel-menu", "/home", { persona: "Laura", steps: async (p) => {
        await p.getByRole("button", { name: /^(Notifications|Notifiche)/ }).first().click();
        const item = p.locator('[data-notification="n-a8-4"]');
        await item.hover();
        await item.getByRole("button", { name: /^(More actions|Altre azioni)$/ }).click();
        await p.waitForTimeout(400);
      } }],
      ["alerts-panel-mandatory", "/home", { persona: "Laura", steps: async (p) => {
        await p.getByRole("button", { name: /^(Notifications|Notifiche)/ }).first().click();
        const item = p.locator('[data-notification="n-a8-5"]');
        await item.scrollIntoViewIfNeeded();
        await item.hover();
        await item.getByRole("button", { name: /^(More actions|Altre azioni)$/ }).click();
        await p.waitForTimeout(400);
      } }],
    ];
    for (const [name, hash, o] of AREA8A_ALERTS) {
      if (only && !only.test(name)) continue;
      const variants = [];
      for (const scheme of ["light", "dark"]) {
        for (const lang of ["en", "it"]) variants.push([scheme, lang, WIDE, `a8-${name}-${scheme}-${lang}.png`]);
      }
      variants.push(["light", "en", NARROW, `a8-${name}-narrow.png`]);
      variants.push(["dark", "it", NARROW, `a8-${name}-narrow-dark-it.png`]);
      for (const [scheme, lang, viewport, file] of variants) {
        const { page, context } = await open(scheme, viewport, hash, { lang, persona: o.persona, viaHome: true });
        if (o.steps) await o.steps(page);
        await shot(page, file);
        await context.close();
      }
    }

    // Area 8a, Task 8: la sezione Releases — lista a due gruppi, il due tempi
    // del merge, il pannello di una PR, il rilascio fallito col log, la
    // riparazione, le impostazioni del repository, il blocco Home.
    const AREA8A_RELEASES = [
      ["releases", "/p/AUD/releases", { persona: "Laura" }],
      ["releases-marco", "/p/AUD/releases", { persona: "Marco" }],
      ["releases-confirm", "/p/AUD/releases", { persona: "Laura", steps: async (p) => {
        await p.locator("[data-merge-start]").first().click();
        await p.waitForTimeout(400);
      } }],
      ["releases-pr", "/p/AUD/releases?pr=opr-aud-246", { persona: "Marco" }],
      // Una PR di Stubwise: «Request changes» apre una sessione della task (m3).
      ["releases-pr-stubwise", "/p/AUD/releases?pr=opr-aud-244", { persona: "Marco", steps: async (p) => {
        await p.locator("[data-detail-panel]").getByText(/^(What should change|Cosa deve cambiare)$/).scrollIntoViewIfNeeded();
        await p.waitForTimeout(300);
      } }],
      ["release-failed", "/p/AUD/releases/AUD-V3", { persona: "Laura" }],
      ["release-log-all", "/p/AUD/releases/AUD-V3", { persona: "Laura", steps: async (p) => {
        await p.getByRole("button", { name: /^(Show all|Vedi tutto)$/ }).click();
        await p.getByRole("button", { name: /^(Find in log|Cerca nel log)$/ }).click();
        await p.keyboard.type("vat_number");
        await p.waitForTimeout(500);
      } }],
      ["release-fix", "/p/AUD/releases/AUD-V3", { persona: "Marco", steps: async (p) => {
        await p.getByRole("button", { name: /^(Fix it with Claude|Fai sistemare a Claude)$/ }).click();
        await p.waitForTimeout(400);
      } }],
      ["release-stw", "/p/STW/releases/STW-V2", { persona: "Laura" }],
      ["releases-settings", "/p/AUD/settings", { persona: "Laura", steps: async (p) => {
        await p.locator('[data-repository="audin/audin-app"]').scrollIntoViewIfNeeded();
        await p.waitForTimeout(300);
      } }],
      ["releases-home", "/home", { persona: "Laura", steps: async (p) => {
        await p.getByRole("region", { name: /^(Releases|Rilasci)/ }).scrollIntoViewIfNeeded();
        await p.waitForTimeout(300);
      } }],
      ["docs-release-notes", "/p/STW/docs/stubwise/releases", { persona: "Laura" }],
    ];
    for (const [name, hash, o] of AREA8A_RELEASES) {
      if (only && !only.test(name)) continue;
      const variants = [];
      for (const scheme of ["light", "dark"]) {
        for (const lang of ["en", "it"]) variants.push([scheme, lang, WIDE, `a8-${name}-${scheme}-${lang}.png`]);
      }
      variants.push(["light", "en", NARROW, `a8-${name}-narrow.png`]);
      variants.push(["dark", "it", NARROW, `a8-${name}-narrow-dark-it.png`]);
      for (const [scheme, lang, viewport, file] of variants) {
        const { page, context } = await open(scheme, viewport, hash, { lang, persona: o.persona, viaHome: true });
        if (o.steps) await o.steps(page);
        await shot(page, file);
        await context.close();
      }
    }
    // Area 8a, Task 9: la sezione Support — elenco per stato, il dettaglio
    // con la bozza di Claude, l'anteprima del cliente, chi legge soltanto, il
    // triage, «Apri la richiesta», i widget, il blocco Home.
    const AREA8A_SUPPORT = [
      ["support", "/p/ACQ/support/ACQ-S2", { persona: "Matteo" }],
      ["support-draft", "/p/ACQ/support/ACQ-S2", { persona: "Matteo", steps: async (p) => {
        await p.getByRole("button", { name: /^(Use draft|Usa la bozza)$/ }).click();
        await p.waitForTimeout(300);
      } }],
      ["support-preview", "/p/ACQ/support/ACQ-S2", { persona: "Matteo", steps: async (p) => {
        await p.getByRole("button", { name: /^(Customer preview|Anteprima del cliente)$/ }).click();
        await p.waitForTimeout(500);
      } }],
      ["support-sara", "/p/ACQ/support/ACQ-S2", { persona: "Sara" }],
      ["support-triage", "/p/ACQ/support/ACQ-S1", { persona: "Matteo" }],
      ["support-open-request", "/p/ACQ/support/ACQ-S3", { persona: "Matteo", steps: async (p) => {
        await p.getByRole("button", { name: /^(Open the request|Apri la richiesta)$/ }).click();
        await p.waitForTimeout(400);
      } }],
      ["support-widgets", "/p/ACQ/support?view=widgets&widget=wdg-acq-portal", { persona: "Matteo" }],
      // La provenienza nel pannello della richiesta [A 15], con la conversazione aperta.
      ["support-origin", "/p/ACQ/requests?request=req-acq-1", { persona: "Matteo", steps: async (p) => {
        await p.getByRole("button", { name: /^(Show the conversation|Mostra la conversazione)/ }).click();
        await p.getByRole("region", { name: /^(Where it comes from|Da dove nasce)$/ }).scrollIntoViewIfNeeded();
        await p.waitForTimeout(300);
      } }],
      // Il blocco non è nelle Home di default [A 17]: lo si aggiunge dal catalogo.
      ["support-home", "/home", { persona: "Matteo", steps: async (p) => {
        await p.getByRole("button", { name: /^(Customize|Personalizza)$/ }).click();
        // Matteo cura anche la Home del reparto: dal menu, la sua.
        const mine = p.getByRole("menuitem", { name: /^(My Home|La mia Home)$/ });
        if (await mine.count()) await mine.click();
        await p.getByRole("button", { name: /^(Add block|Aggiungi blocco)$/ }).click();
        await p.getByRole("menuitem", { name: /^(Customers waiting|Clienti in attesa)$/ }).click();
        await p.getByRole("button", { name: /^(Done|Fatto)$/ }).click();
        const block = p.getByRole("region", { name: /^(Customers waiting|Clienti in attesa)/ });
        await block.scrollIntoViewIfNeeded();
        await p.waitForTimeout(600);
      } }],
    ];
    for (const [name, hash, o] of AREA8A_SUPPORT) {
      if (only && !only.test(name)) continue;
      const variants = [];
      for (const scheme of ["light", "dark"]) {
        for (const lang of ["en", "it"]) variants.push([scheme, lang, WIDE, `a8-${name}-${scheme}-${lang}.png`]);
      }
      variants.push(["light", "en", NARROW, `a8-${name}-narrow.png`]);
      variants.push(["dark", "it", NARROW, `a8-${name}-narrow-dark-it.png`]);
      for (const [scheme, lang, viewport, file] of variants) {
        const { page, context } = await open(scheme, viewport, hash, { lang, persona: o.persona, viaHome: true });
        if (o.steps) await o.steps(page);
        await shot(page, file);
        await context.close();
      }
    }

    // Area 8b, Task 7: la sezione Servers — l'elenco a gruppi, il dettaglio
    // col riquadro «Now», i grafici col controllo selezionato, le soglie in
    // lettura, il pannello della chiave dell'agente.
    const scrollTo = (part) => async (p) => {
      await p.locator(`#server-${part}`).scrollIntoViewIfNeeded();
      await p.locator(`#server-${part}`).evaluate((el) => el.scrollIntoView({ block: "start" }));
      await p.waitForTimeout(300);
    };
    const AREA8B_SERVERS = [
      ["servers-stw", "/p/STW/servers", { persona: "Roberta" }],
      ["servers-aud", "/p/AUD/servers", { persona: "Laura" }],
      ["server-srv2", "/p/STW/servers/SRV-2", { persona: "Roberta" }],
      ["server-srv1-check", "/p/ACQ/servers/SRV-1?check=chk-srv-1-api&range=7d", { persona: "Marco" }],
      ["server-srv1-services", "/p/ACQ/servers/SRV-1", { persona: "Marco", steps: scrollTo("services") }],
      ["server-srv3-thresholds", "/p/AUD/servers/SRV-3", { persona: "Laura", steps: scrollTo("checks") }],
      ["server-srv1-settings", "/p/ACQ/servers/SRV-1", { persona: "Roberta", steps: scrollTo("thresholds") }],
      ["server-new-key", "/p/STW/servers", { persona: "Roberta", steps: async (p) => {
        await p.locator("[data-new-server]").first().click();
        await p.getByRole("textbox", { name: /^(Name|Nome)$/ }).fill("stw-worker-01");
        await p.locator("[data-create-server]").click();
        await p.locator("[data-agent-key]").waitFor();
        await p.waitForTimeout(400);
      } }],
      // Task 8: gli accessi SSH (shape server-access.md).
      ["access-link", "/p/AUD/servers/SRV-4", { persona: "Roberta", steps: scrollTo("access") }],
      ["access-command", "/p/AUD/servers/SRV-3", { persona: "Roberta", steps: scrollTo("access") }],
      ["access-read-writes", "/p/AUD/servers/SRV-3", { persona: "Roberta", steps: async (p) => {
        await p.locator("[data-prototype-only]").filter({ hasText: /Next verification|Prossima verifica/ }).locator("select").selectOption("read_writes");
        await p.waitForTimeout(300);
        await p.getByRole("button", { name: /^(Verify|Verifica)$/ }).click();
        await p.getByRole("alert").first().waitFor();
        await scrollTo("access")(p);
      } }],
      ["access-verified", "/p/ACQ/servers/SRV-1", { persona: "Roberta", steps: scrollTo("access") }],
      ["access-regenerate", "/p/ACQ/servers/SRV-1", { persona: "Roberta", steps: async (p) => {
        await p.locator("#server-access [aria-haspopup='menu']").click();
        await p.getByRole("menuitem", { name: /^(Regenerate keys|Rigenera le chiavi)/ }).click();
        await p.getByRole("dialog").waitFor();
        await p.waitForTimeout(300);
      } }],
      // R-L8: con la sola lettura funzionante si promette solo quella.
      ["access-regenerating-partial", "/p/ACQ/servers/SRV-1", { persona: "Roberta", steps: async (p) => {
        await p.locator("[data-prototype-only]").filter({ hasText: /Next verification|Prossima verifica/ }).locator("select").selectOption("fix_fails");
        await p.waitForTimeout(300);
        await p.locator("#server-access [aria-haspopup='menu']").click();
        await p.getByRole("menuitem", { name: /^(Verify again|Verifica di nuovo)$/ }).click();
        await p.waitForTimeout(600);
        await p.locator("#server-access [aria-haspopup='menu']").click();
        await p.getByRole("menuitem", { name: /^(Regenerate keys|Rigenera le chiavi)/ }).click();
        await p.getByRole("dialog").getByRole("button", { name: /^(Regenerate|Rigenera)$/ }).click();
        await p.locator("#server-access [data-command]").waitFor();
        await scrollTo("access")(p);
      } }],
      ["access-regenerating", "/p/ACQ/servers/SRV-1", { persona: "Roberta", steps: async (p) => {
        await p.locator("#server-access [aria-haspopup='menu']").click();
        await p.getByRole("menuitem", { name: /^(Regenerate keys|Rigenera le chiavi)/ }).click();
        await p.getByRole("dialog").getByRole("button", { name: /^(Regenerate|Rigenera)$/ }).click();
        await p.locator("#server-access [data-command]").waitFor();
        await scrollTo("access")(p);
      } }],
      ["access-revoke", "/p/ACQ/servers/SRV-1", { persona: "Roberta", steps: async (p) => {
        await p.locator("#server-access [aria-haspopup='menu']").click();
        await p.getByRole("menuitem", { name: /^(Revoke access|Revoca l'accesso)/ }).click();
        await p.getByRole("dialog").waitFor();
        await p.waitForTimeout(300);
      } }],
      ["access-removal", "/p/ACQ/servers/SRV-1", { persona: "Roberta", steps: async (p) => {
        await p.locator("#server-access [aria-haspopup='menu']").click();
        await p.getByRole("menuitem", { name: /^(Revoke access|Revoca l'accesso)/ }).click();
        await p.getByRole("dialog").getByRole("button", { name: /^(Revoke access|Revoca l'accesso)$/ }).click();
        await p.locator("#server-access [data-command]").waitFor();
        await scrollTo("access")(p);
      } }],
      ["access-laura", "/p/ACQ/servers/SRV-1", { persona: "Laura", steps: scrollTo("access") }],
    ];
    for (const [name, hash, o] of AREA8B_SERVERS) {
      if (only && !only.test(name)) continue;
      const variants = [];
      for (const scheme of ["light", "dark"]) {
        for (const lang of ["en", "it"]) variants.push([scheme, lang, WIDE, `a8b-${name}-${scheme}-${lang}.png`]);
      }
      variants.push(["light", "en", NARROW, `a8b-${name}-narrow.png`]);
      variants.push(["dark", "it", NARROW, `a8b-${name}-narrow-dark-it.png`]);
      for (const [scheme, lang, viewport, file] of variants) {
        const { page, context } = await open(scheme, viewport, hash, { lang, persona: o.persona, viaHome: true });
        // Il dettaglio: si aspettano i grafici (una lettura a sé, con la sua latenza).
        if (hash.includes("/servers/SRV-")) {
          await page.locator("[data-chart='cpu']").waitFor();
          await page.waitForTimeout(400);
        }
        if (o.steps) await o.steps(page);
        await shot(page, file);
        await context.close();
      }
    }

    // Task 9 dell'8b (shape server-task.md): la task di SRV-1 con la sezione
    // Server, il piano della correzione da approvare, il registro dei comandi
    // col controllo finale, la sessione d'analisi, l'avviso senza accesso.
    const startFix = async (p) => {
      await p.locator("[data-start-fix]").click();
      await p.locator("[data-confirm-start-fix]").click();
      await p.locator("[data-runs-as]").waitFor({ timeout: 15000 });
      // Il piano è arrivato e la riga di stato lo dice (non più «Working»).
      await p.locator("[data-claude-status='awaiting_approval']").waitFor({ timeout: 15000 });
      await p.waitForTimeout(400);
    };
    const AREA8B_TASK = [
      ["task-diagnosis", "/p/ACQ/tasks?task=ACQ-6", { persona: "Roberta" }],
      ["task-start-dialog", "/p/ACQ/tasks?task=ACQ-6", { persona: "Marco", steps: async (p) => {
        await p.locator("[data-start-fix]").click();
        await p.locator("[data-confirm-start-fix]").waitFor();
        await p.waitForTimeout(300);
      } }],
      ["task-laura", "/p/ACQ/tasks?task=ACQ-6", { persona: "Laura", steps: async (p) => {
        await p.locator("[data-server-task-state]").evaluate((el) =>
          el.closest("section")?.scrollIntoView({ block: "start" }),
        );
        await p.waitForTimeout(300);
      } }],
      ["task-plan", "/p/ACQ/tasks?task=ACQ-6", { persona: "Roberta", steps: async (p) => {
        await startFix(p);
        await p.locator("[data-plan]").first().scrollIntoViewIfNeeded();
      } }],
      ["task-commands", "/p/ACQ/tasks?task=ACQ-6", { persona: "Roberta", steps: async (p) => {
        await startFix(p);
        await p.getByRole("button", { name: /^(Approve the plan|Approva il piano)$/ }).click();
        await p.locator("[data-server-check]").waitFor({ timeout: 20000 });
        // Finita la correzione il registro si chiude da sé: lo si riapre.
        const toggle = p.getByRole("button", { name: /^(Commands on|Comandi su) SRV-1/ });
        await p.locator("[data-claude-status='ended'], [data-claude-status='done']").first().waitFor({ timeout: 20000 });
        await p.waitForTimeout(300);
        if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
        await p.locator("[data-command-row]").nth(2).click();
        await p.locator("[data-command-row]").nth(2).scrollIntoViewIfNeeded();
        await p.waitForTimeout(400);
      } }],
      ["task-analysis", "/claude/cv-srv-1-analysis", { persona: "Roberta" }],
      ["task-alert", "/home", { persona: "Roberta", steps: async (p) => {
        await p.getByRole("button", { name: /^(Notifications|Notifiche)/ }).first().click();
        await p.getByRole("button", { name: /^(Link SSH access|Collega l'accesso SSH)$/ }).first().waitFor();
        await p.waitForTimeout(300);
      } }],
    ];
    for (const [name, hash, o] of AREA8B_TASK) {
      if (only && !only.test(name)) continue;
      const variants = [];
      for (const scheme of ["light", "dark"]) {
        for (const lang of ["en", "it"]) variants.push([scheme, lang, WIDE, `a8b-${name}-${scheme}-${lang}.png`]);
      }
      variants.push(["light", "en", NARROW, `a8b-${name}-narrow.png`]);
      variants.push(["dark", "it", NARROW, `a8b-${name}-narrow-dark-it.png`]);
      for (const [scheme, lang, viewport, file] of variants) {
        const { page, context } = await open(scheme, viewport, hash, { lang, persona: o.persona, viaHome: true });
        if (hash.includes("task=")) {
          await page.locator("[data-server-task-state]").waitFor();
          await page.waitForTimeout(300);
        }
        if (o.steps) await o.steps(page);
        await shot(page, file);
        await context.close();
      }
    }

    // Area 9a: l'ingresso (login, secondo fattore, blocco, invito, primo
    // avvio) e il dialogo di riconferma. Si esce dal menu del profilo; la
    // riconferma si scatta dalla pagina vera di Preferenze → Tokens (Task 7):
    // «Create token» la apre, per Roberta col codice e per Sara (senza
    // secondo fattore) con l'iscrizione al volo.
    const signOut = async (p) => {
      await p.getByRole("button", { name: /^(Profile and settings|Profilo e impostazioni)/ }).click();
      await p.getByRole("button", { name: /^(Sign out|Esci)$/ }).click();
      await p.getByRole("heading", { level: 1, name: /^(Sign in to Stubwise|Accedi a Stubwise)$/ }).waitFor();
    };
    const toSecondFactor = async (p) => {
      await signOut(p);
      await p.getByRole("button", { name: "Laura" }).click();
      await p.getByRole("button", { name: /^(Sign in|Accedi)$/ }).click();
      await p.getByRole("heading", { level: 1, name: /^(Two-step verification|Verifica in due passaggi)$/ }).waitFor();
    };
    const tryInvite = (which) => async (p) => {
      await signOut(p);
      await p.getByRole("button", { name: which }).click();
      await p.getByRole("heading", { level: 1 }).filter({ hasNotText: /Sign in|Accedi/ }).waitFor();
      await p.waitForTimeout(500);
    };
    const createTokenAs = (persona) => async (p) => {
      await asPerson(p, persona, "/preferences/tokens");
      await p.getByRole("heading", { level: 1, name: /^(Tokens|Token)$/ }).waitFor();
      await p.getByRole("button", { name: /^(New token|Nuovo token)$/ }).click();
      await p.getByLabel(/^(Name|Nome)$/).fill("my-laptop MCP");
      await p.getByRole("button", { name: /^(Create token|Crea token)$/ }).click();
      await p.getByRole("dialog").waitFor();
      // L'iscrizione prepara la chiave: si aspetta il QR.
      await p.waitForTimeout(900);
      await p.mouse.move(2, 2);
    };
    const AREA9A_ENTRY = [
      ["login", async (p) => {
        await signOut(p);
        await p.mouse.move(2, 2);
        await p.waitForTimeout(500);
      }],
      ["second-factor", async (p) => {
        await toSecondFactor(p);
        await p.waitForTimeout(400);
      }],
      ["locked", async (p) => {
        await toSecondFactor(p);
        const code = p.getByLabel(/^(Code|Codice)$/);
        for (let i = 0; i < 5; i++) {
          await code.fill("000000");
          await p.waitForTimeout(700);
        }
        await p.locator("[data-second-factor-locked]").waitFor();
        await p.waitForTimeout(300);
      }],
      ["invite", tryInvite(/^(pending|in sospeso)$/)],
      ["invite-expired", tryInvite(/^(expired|scaduto)$/)],
      ["setup", async (p) => {
        await p.getByRole("button", { name: /^(Profile and settings|Profilo e impostazioni)/ }).click();
        const reset = p.getByRole("button", { name: /^(Reset to empty instance|Svuota l'istanza)$/ });
        await reset.click();
        await p.getByRole("button", { name: /^(Reset — sure\?|Ripristina — sicuro\?)$/ }).last().click();
        await p.getByRole("heading", { level: 1, name: /^(Set up Stubwise|Configura Stubwise)$/ }).waitFor();
        await p.waitForTimeout(400);
      }],
      ["reauth", createTokenAs("Roberta")],
      ["reauth-enroll", createTokenAs("Sara")],
      // Il link di reset della password (Task 8, giro 1): Roberta lo crea per
      // Marco in People, poi si esce e lo si incolla nel riquadro del login.
      ["reset", async (p) => {
        await asPerson(p, "Roberta", "/admin/people/p-marco");
        await p.getByRole("button", { name: /^(More actions for|Altre azioni per) / }).click();
        await p.getByRole("menuitem", { name: /^(Reset password…|Reimposta la password…)$/ }).click();
        await p.getByRole("button", { name: /^(Create link|Crea il link)$/ }).click();
        const dialog = p.getByRole("dialog").filter({ has: p.getByLabel(/^(Code|Codice)$/) });
        await dialog.getByLabel(/^(Code|Codice)$/).fill("123456");
        await dialog.waitFor({ state: "detached" });
        const link = await p.locator("[data-secret-value]").innerText();
        await p.getByRole("button", { name: /^(Done|Fatto)$/ }).click();
        await signOut(p);
        await p.getByLabel(/^(Password reset link|Link per reimpostare la password)$/).fill(link.trim());
        await p.getByLabel(/^(Password reset link|Link per reimpostare la password)$/).press("Enter");
        await p.getByRole("heading", { level: 1, name: /^(Choose a new password|Scegli una password nuova)$/ }).waitFor();
        await p.mouse.move(2, 2);
        await p.waitForTimeout(400);
      }],
      ["reset-invalid", async (p) => {
        await signOut(p);
        await p.getByLabel(/^(Password reset link|Link per reimpostare la password)$/).fill("made-up-link");
        await p.getByLabel(/^(Password reset link|Link per reimpostare la password)$/).press("Enter");
        await p.getByRole("heading", { level: 1 }).filter({ hasNotText: /Sign in|Accedi/ }).waitFor();
        await p.mouse.move(2, 2);
        await p.waitForTimeout(400);
      }],
    ];
    for (const [name, how] of AREA9A_ENTRY) {
      if (only && !only.test(`a9a-entry-${name}`) && !only.test(name)) continue;
      const variants = [];
      for (const scheme of ["light", "dark"]) {
        for (const lang of ["en", "it"]) variants.push([scheme, lang, WIDE, `a9a-entry-${name}-${scheme}-${lang}.png`]);
      }
      variants.push(["light", "en", NARROW, `a9a-entry-${name}-narrow.png`]);
      variants.push(["dark", "it", NARROW, `a9a-entry-${name}-narrow-dark-it.png`]);
      for (const [scheme, lang, viewport, file] of variants) {
        const { page, context } = await open(scheme, viewport, "/home", { lang });
        await how(page);
        await shot(page, file);
        await context.close();
      }
    }
    // Area 9a, Task 7: le Preferenze personali (shape preferences-account.md).
    // Security e Tokens anche col valore mostrato una volta (`SecretOnce`):
    // la riconferma si passa col codice del prototipo.
    const confirmCode = async (p) => {
      const dialog = p.getByRole("dialog");
      await dialog.getByLabel(/^(Code|Codice)$/).fill("123456");
      await dialog.waitFor({ state: "detached" });
    };
    const AREA9A_PREFS = [
      ["account", "Giulia", "/preferences/account", null],
      ["account-google", "Giulia", "/preferences/account", async (p) => {
        await p.getByRole("heading", { name: /^(Google mailboxes|Caselle Google)$/ }).scrollIntoViewIfNeeded();
      }],
      ["account-disconnect", "Giulia", "/preferences/account", async (p) => {
        await p.getByRole("button", { name: /^(More for|Altro per) / }).click();
        await p.getByRole("menuitem", { name: /^(Disconnect…|Scollega…)$/ }).click();
        await p.getByRole("group", { name: /^(Disconnect — sure\?|Scollega — sicuro\?)$/ }).scrollIntoViewIfNeeded();
      }],
      ["account-connect", "Laura", "/preferences/account", async (p) => {
        await p.getByRole("button", { name: /^(Reconnect|Ricollega)$/ }).click();
        await p.getByRole("radio", { name: /^(Wrong domain|Dominio sbagliato)$/ }).click();
        await p.getByRole("button", { name: /^(Continue on Google|Continua su Google)$/ }).click();
        await p.getByRole("button", { name: /^(Try again|Riprova)$/ }).waitFor();
      }],
      ["security", "Roberta", "/preferences/security", null],
      ["security-off", "Sara", "/preferences/security", null],
      ["security-setup", "Sara", "/preferences/security", async (p) => {
        await p.getByRole("button", { name: /^(Set up now|Attivala ora)$/ }).click();
        await p.getByRole("img", { name: /^(QR code|Codice QR)/ }).waitFor();
      }],
      ["security-codes", "Laura", "/preferences/security", async (p) => {
        await p.getByRole("button", { name: /^(Make new codes|Genera codici nuovi)$/ }).click();
        await p.getByRole("button", { name: /^(Make new codes — sure\?|Genera codici nuovi — sicuro\?)$/ }).click();
        await confirmCode(p);
        await p.getByTestId("secret-once").scrollIntoViewIfNeeded();
      }],
      ["security-passkey", "Laura", "/preferences/security", async (p) => {
        await p.getByRole("button", { name: /^(Add passkey|Aggiungi passkey)$/ }).click();
        await p.getByLabel(/^(Name this passkey|Dai un nome alla passkey)$/).fill("Work laptop");
        await p.getByRole("button", { name: /^(Continue|Continua)$/ }).click();
      }],
      ["tokens", "Laura", "/preferences/tokens", null],
      ["tokens-secret", "Laura", "/preferences/tokens", async (p) => {
        await p.getByRole("button", { name: /^(New token|Nuovo token)$/ }).click();
        await p.getByLabel(/^(Name|Nome)$/).fill("my-laptop MCP");
        await p.getByRole("button", { name: /^(Create token|Crea token)$/ }).click();
        await confirmCode(p);
        await p.getByTestId("secret-once").waitFor();
      }],
      ["claude-code", "Marco", "/preferences/claude-code", null],
      ["claude-code-secret", "Marco", "/preferences/claude-code", async (p) => {
        await p.getByRole("button", { name: /^(Create the command|Crea il comando)$/ }).click();
        await confirmCode(p);
        await p.getByTestId("secret-once").waitFor();
      }],
      ["look", "Giulia", "/preferences/look", null],
    ];
    for (const [name, persona, hash, steps] of AREA9A_PREFS) {
      if (only && !only.test(`a9a-prefs-${name}`)) continue;
      const variants = [];
      for (const scheme of ["light", "dark"]) {
        for (const lang of ["en", "it"]) variants.push([scheme, lang, WIDE, `a9a-prefs-${name}-${scheme}-${lang}.png`]);
      }
      variants.push(["light", "en", NARROW, `a9a-prefs-${name}-narrow.png`]);
      variants.push(["dark", "it", NARROW, `a9a-prefs-${name}-narrow-dark-it.png`]);
      for (const [scheme, lang, viewport, file] of variants) {
        const { page, context } = await open(scheme, viewport, hash, { lang, persona, viaHome: true });
        await page.getByRole("heading", { level: 1 }).first().waitFor();
        await page.waitForTimeout(300);
        if (steps) await steps(page);
        await page.mouse.move(2, 2);
        await page.waitForTimeout(500);
        await shot(page, file);
        await context.close();
      }
    }

    // Area 9a, Task 8: l'Amministrazione (shape admin-people.md): People,
    // la pagina di una persona, «Deactivate…» e «Invite someone».
    const AREA9A_ADMIN = [
      ["people", "Roberta", "/admin/people", null],
      ["detail", "Roberta", "/admin/people/p-marco", null],
      ["deactivate", "Roberta", "/admin/people/p-marco", async (p) => {
        await p.getByRole("button", { name: /^(More actions for|Altre azioni per) / }).click();
        await p.getByRole("menuitem", { name: /^(Deactivate…|Disattiva…)$/ }).click();
        await p.getByRole("dialog").waitFor();
      }],
      ["invite", "Roberta", "/admin/people", async (p) => {
        await p.getByRole("button", { name: /^(Invite someone|Invita qualcuno)$/ }).click();
        const dialog = p.getByRole("dialog");
        await dialog.getByLabel(/^Email$/).fill("federico.r@example.com");
        await dialog.getByRole("button", { name: /^(Add a project|Aggiungi un progetto)/ }).click();
        await p.getByRole("menuitem", { name: /^ACQ / }).click();
        await p.mouse.move(2, 2);
      }],
    ];
    // Giro 1: le task di Simone (disattivato nel seme) dicono «(deactivated)».
    AREA9A_ADMIN.push(["task-deactivated", "Roberta", "/p/STW/tasks", async (p) => {
      const row = p.locator("[data-task-row]", { has: p.locator('[data-person="p-simone"]') }).first();
      await row.waitFor();
      const code = await row.getAttribute("data-task-row");
      await p.evaluate((c) => {
        window.location.hash = `/p/STW/tasks?task=${c}`;
      }, code);
      // Il pannello della task, agganciato a destra (un dialogo solo quando è sovrapposto).
      await p.locator(`text=${code}`).nth(1).waitFor();
      await p.waitForTimeout(600);
      await p.mouse.move(2, 2);
    }]);
    for (const [name, persona, hash, steps] of AREA9A_ADMIN) {
      if (only && !only.test(`a9a-admin-people-${name}`)) continue;
      const variants = [];
      for (const scheme of ["light", "dark"]) {
        for (const lang of ["en", "it"]) variants.push([scheme, lang, WIDE, `a9a-admin-people-${name}-${scheme}-${lang}.png`]);
      }
      variants.push(["light", "en", NARROW, `a9a-admin-people-${name}-narrow.png`]);
      variants.push(["dark", "it", NARROW, `a9a-admin-people-${name}-narrow-dark-it.png`]);
      for (const [scheme, lang, viewport, file] of variants) {
        const { page, context } = await open(scheme, viewport, hash, { lang, persona, viaHome: true });
        await page.getByRole("heading", { level: 1 }).first().waitFor();
        await page.waitForTimeout(300);
        if (steps) await steps(page);
        await page.waitForTimeout(500);
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
