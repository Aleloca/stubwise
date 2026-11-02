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

    // Area 10a, Task 11 (`CAPTURE_A10A_TRACE=1`): «Claude on behalf of».
    // Roberta: il registro con Person = Giulia e «Made with Claude» premuto
    // (la voce del seme, l'inversa con «Undid:»); la rassegna di oggi con le
    // righe «with Claude» e la task eliminata; l'Activity del portafoglio.
    // Giulia: la storia di MKX-1 col commento e le righe col prefisso. Marco:
    // la notifica col prefisso e «Undone by». Scatti `a10a-trace-*`.
    if (process.env.CAPTURE_A10A_TRACE) {
      const variants = [
        ...["light", "dark"].flatMap((scheme) =>
          ["en", "it"].map((lang) => ({ scheme, lang, viewport: WIDE, suffix: `${scheme}-${lang}` })),
        ),
        { scheme: "dark", lang: "en", viewport: NARROW, suffix: "narrow-en" },
        { scheme: "light", lang: "it", viewport: NARROW, suffix: "narrow-it" },
      ];
      const only = process.env.CAPTURE_ONLY ? new RegExp(process.env.CAPTURE_ONLY) : null;
      const take = async (page, name, v) => {
        await page.mouse.move(v.viewport.width - 2, v.viewport.height - 2);
        if (!only || only.test(name)) await shot(page, name);
      };
      /** I fatti di oggi fatti con Claude per Giulia (come nel test della rassegna). */
      const seed = (page) =>
        page.evaluate(async () => {
          const store = await import("/data/store.ts");
          const dates = await import("/data/dates.ts");
          const { state } = store;
          const mkx = state.tasks.filter((t) => t.projectId === "prj-mkx");
          state.activity.push(
            {
              id: "act-capture-via",
              taskId: mkx[0].id,
              kind: "field_change",
              authorId: "p-giulia",
              at: `${dates.TODAY}T10:41:00Z`,
              field: "week",
              from: "2026-W45",
              to: "2026-W46",
              via: "claude",
            },
            {
              id: "act-capture-comment",
              taskId: "t-mkx-1",
              kind: "comment",
              authorId: "p-giulia",
              at: `${dates.TODAY}T10:42:00Z`,
              body: "Moved to next week, as asked: the launch post waits for the photos.",
              via: "claude",
            },
          );
          state.deletedTasks.push({
            id: "t-mkx-capture-gone",
            code: "MKX-31",
            projectId: "prj-mkx",
            title: "Prova",
            deletedAt: `${dates.TODAY}T11:02:00Z`,
            deletedById: "p-giulia",
            via: "claude",
          });
          // Una task di OLV di Marco ripianificata da Claude per Giulia: «Your week changed».
          const mut = await import("/data/api-mutations.ts");
          const via = await import("/data/claude/via.ts");
          const task = mut.createTaskAs("p-giulia", {
            projectId: "prj-olv",
            title: "Harvest photos",
            assigneeId: "p-marco",
          });
          via.runAsClaude({ actionId: "ca-capture-plan", undoOfActionId: null }, () =>
            mut.applyActions("p-giulia", [
              {
                fn: "planTask",
                args: { id: task.id, plan: { assigneeId: "p-marco", week: "2026-W46" } },
                summary: "",
              },
            ]),
          );
          return dates.TODAY;
        });
      for (const v of variants) {
        const { page, context } = await open(v.scheme, v.viewport, "/admin/changelog?actor=p-giulia&via=claude", {
          lang: v.lang,
          persona: "Roberta",
        });
        const today = await seed(page);
        await page.waitForTimeout(900);
        await take(page, `a10a-trace-log-${v.suffix}.png`, v);
        // La data di «Undid:»: porta alla voce annullata e la evidenzia.
        await page.locator("[data-undid] button").first().click();
        await page.waitForTimeout(300);
        await take(page, `a10a-trace-log-reveal-${v.suffix}.png`, v);
        await page.evaluate((h) => {
          window.location.hash = h;
        }, `/projects?view=person&date=${today}`);
        await page.locator('[data-person-row="p-giulia"] [data-person-toggle]').click();
        await page.waitForTimeout(600);
        await page.locator('[data-person-row="p-giulia"]').scrollIntoViewIfNeeded();
        await take(page, `a10a-trace-people-${v.suffix}.png`, v);
        await page.evaluate(() => {
          window.location.hash = "/projects";
        });
        await page.getByRole("tab", { name: /^(Activity|Attività)$/ }).click();
        await page.waitForTimeout(900);
        await take(page, `a10a-trace-activity-${v.suffix}.png`, v);
        const blur = () =>
          page.evaluate(() => {
            const active = document.activeElement;
            if (active instanceof HTMLButtonElement) active.blur();
          });
        await asPerson(page, "Giulia", "/p/MKX/tasks?task=MKX-1");
        await page.waitForTimeout(1200);
        await blur();
        await page.locator('[data-activity="comment"]').last().scrollIntoViewIfNeeded();
        await take(page, `a10a-trace-task-${v.suffix}.png`, v);
        await asPerson(page, "Marco", "/home");
        await page.waitForTimeout(900);
        await page.getByRole("button", { name: /^(Notifications|Notifiche)/ }).click();
        await page.waitForTimeout(900);
        await take(page, `a10a-trace-notifications-planned-${v.suffix}.png`, v);
        await page.locator('[data-notification="n-claude-1"]').scrollIntoViewIfNeeded();
        await take(page, `a10a-trace-notifications-${v.suffix}.png`, v);
        await context.close();
      }
      return;
    }

    // Area 10a, Task 10 (`CAPTURE_A10A_DELETE=1`): «Elimina task». Laura in
    // ACQ: il dialogo di una task con due figlie, un collegamento e la
    // richiesta d'origine; poi l'eliminazione (toast, fuoco sulla riga dopo) e
    // la richiesta che lo dice. Il dialogo busy (sessione di Claude). Sara: la
    // voce spenta con la frase e «Who?». Scatti `a10a-delete-*`.
    if (process.env.CAPTURE_A10A_DELETE) {
      const variants = [
        ...["light", "dark"].flatMap((scheme) =>
          ["en", "it"].map((lang) => ({ scheme, lang, viewport: WIDE, suffix: `${scheme}-${lang}` })),
        ),
        { scheme: "dark", lang: "en", viewport: NARROW, suffix: "narrow-en" },
        { scheme: "light", lang: "it", viewport: NARROW, suffix: "narrow-it" },
      ];
      const only = process.env.CAPTURE_ONLY ? new RegExp(process.env.CAPTURE_ONLY) : null;
      const take = async (page, name, v) => {
        await page.mouse.move(v.viewport.width - 2, v.viewport.height - 2);
        if (!only || only.test(name)) await shot(page, name);
      };
      /** Le task della scena, create nel livello dati della pagina. */
      const seed = (page) =>
        page.evaluate(async () => {
          const api = await import("/data/api.ts");
          const mut = await import("/data/api-mutations.ts");
          const store = await import("/data/store.ts");
          const session = await import("/data/session.ts");
          session.setSessionPersonId("p-laura");
          const parent = await api.convertRequest("req-acq-1", { title: "Bill download rework" });
          const child = (title) =>
            mut.createTaskAs("p-laura", { projectId: "prj-acq", title }, {
              links: [{ kind: "parent", taskId: parent.id }],
            });
          child("Export CSV");
          child("PDF layout");
          const other = store.state.tasks.find((t) => t.projectId === "prj-acq" && t.id !== parent.id);
          store.state.tasksById.get(parent.id).links.push({ kind: "relates", taskId: other.id });
          const busy = mut.createTaskAs("p-laura", { projectId: "prj-acq", title: "Fix bill download" });
          const run = store.state.conversations.find((c) => c.kind === "task_run");
          store.state.conversations.push({
            ...structuredClone(run),
            id: "c-capture-delete",
            projectId: "prj-acq",
            taskId: busy.id,
            state: "working",
          });
          const sara = mut.createTaskAs("p-laura", { projectId: "prj-acq", title: "Rate limit copy" });
          return { parent: parent.code, busy: busy.code, sara: sara.code };
        });
      const openDelete = async (page, code) => {
        await page.getByRole("button", { name: new RegExp(`^(More actions for|Altre azioni per) ${code}$`) }).click();
        const item = page.getByRole("menuitem", { name: /^(Delete task…|Elimina task…)/ });
        await item.waitFor();
        await page.waitForTimeout(400);
        return item;
      };
      for (const v of variants) {
        const { page, context } = await open(v.scheme, v.viewport, "/p/ACQ/tasks", {
          lang: v.lang,
          persona: "Laura",
        });
        const codes = await seed(page);
        // Le task del seme sono scritte nello stato senza passare dalle query:
        // si esce e si rientra, così la lista le rilegge e la riga eliminata
        // ha una riga dopo (T10 M6).
        await page.evaluate(() => {
          window.location.hash = "/p/ACQ/overview";
        });
        await page.waitForTimeout(900);
        await page.evaluate((h) => {
          window.location.hash = h;
        }, `/p/ACQ/tasks?task=${codes.parent}`);
        await page.locator(`[data-task-row="${codes.parent}"]`).first().waitFor();
        await page.waitForTimeout(600);
        await (await openDelete(page, codes.parent)).click();
        await page.getByRole("dialog", { name: new RegExp(codes.parent) }).last().waitFor();
        await page.waitForTimeout(600);
        await take(page, `a10a-delete-dialog-${v.suffix}.png`, v);
        const rows = await page.evaluate(() =>
          [...document.querySelectorAll("[data-task-row]")]
            .filter((el) => !el.closest("[data-detail-panel]"))
            .map((el) => el.getAttribute("data-task-row")),
        );
        await page.getByRole("button", { name: new RegExp(`^(Delete|Elimina) ${codes.parent}$`) }).click();
        await page.waitForTimeout(1500);
        // La verifica del fuoco (T10, portato avanti): dove sta dopo l'eliminazione.
        const focused = await page.evaluate(() => {
          const el = document.activeElement;
          const row = el?.closest("[data-task-row]");
          return row ? `row ${row.getAttribute("data-task-row")}` : `${el?.tagName} ${el?.textContent?.slice(0, 40)}`;
        });
        console.log(`fuoco dopo Delete ${codes.parent} (${v.suffix}): ${focused}; righe prima: ${rows.join(",")}`);
        await take(page, `a10a-delete-after-${v.suffix}.png`, v);
        await page.evaluate(() => {
          window.location.hash = "/p/ACQ/requests?request=req-acq-1";
        });
        await page.waitForTimeout(1200);
        await take(page, `a10a-delete-request-${v.suffix}.png`, v);
        await page.evaluate((h) => {
          window.location.hash = h;
        }, `/p/ACQ/tasks?task=${codes.busy}`);
        await page.waitForTimeout(900);
        // Il toast dell'eliminazione di prima se n'è andato (T10 M6).
        await page.locator("[data-toast]").first().waitFor({ state: "detached", timeout: 8000 }).catch(() => {});
        await (await openDelete(page, codes.busy)).click();
        await page.locator("[data-delete-busy]").waitFor();
        await page.waitForTimeout(600);
        await take(page, `a10a-delete-busy-${v.suffix}.png`, v);
        await page.keyboard.press("Escape");
        // Sara (Contributor in ACQ) su una task di Laura: la voce spenta.
        await asPerson(page, "Sara", `/p/ACQ/tasks?task=${codes.sara}`);
        await page.waitForTimeout(900);
        await openDelete(page, codes.sara);
        await take(page, `a10a-delete-menu-${v.suffix}.png`, v);
        await context.close();
      }
      return;
    }

    // Area 10a, Task 6 (`CAPTURE_A10A_DECISION=1`): «Record a decision» aperto
    // dal link di una riga D di Claude, con AUD-4 in testa e il testo vuoto.
    // Marco in AUD (ha `decisions.record`). Scatti `a10a-record-decision-*`.
    if (process.env.CAPTURE_A10A_DECISION) {
      const variants = [
        ...["light", "dark"].flatMap((scheme) =>
          ["en", "it"].map((lang) => ({ scheme, lang, viewport: WIDE, suffix: `${scheme}-${lang}` })),
        ),
        { scheme: "dark", lang: "en", viewport: NARROW, suffix: "narrow-en" },
        { scheme: "light", lang: "it", viewport: NARROW, suffix: "narrow-it" },
      ];
      for (const v of variants) {
        const { page, context } = await open(v.scheme, v.viewport, "/home", {
          lang: v.lang,
          persona: "Marco",
        });
        await page.evaluate(() => {
          window.location.hash = "/p/AUD/overview?recordDecision=1&task=AUD-4";
        });
        await page.getByRole("dialog").waitFor();
        await page.waitForTimeout(900);
        await shot(page, `a10a-record-decision-${v.suffix}.png`);
        await context.close();
      }
      return;
    }

    // Area 10a, ondata finale (`CAPTURE_A10A_UNDOCARD=1`, I1): l'«Annulla» di
    // una scheda che dava OLV-1 a Marco avviserebbe Marco, quindi non parte:
    // la riga dice «Confirm below to undo» e sotto c'è la sua scheda B.
    // Scatti `a10a-actions-undo-card-*`.
    if (process.env.CAPTURE_A10A_UNDOCARD) {
      const variants = [
        ...["light", "dark"].flatMap((scheme) =>
          ["en", "it"].map((lang) => ({ scheme, lang, viewport: WIDE, suffix: `${scheme}-${lang}` })),
        ),
        { scheme: "dark", lang: "en", viewport: NARROW, suffix: "narrow-en" },
        { scheme: "light", lang: "it", viewport: NARROW, suffix: "narrow-it" },
      ];
      for (const v of variants) {
        const { page, context } = await open(v.scheme, v.viewport, "/home", { lang: v.lang });
        const summary =
          v.lang === "it"
            ? "Pianifica OLV-1 Refresh landing page hero copy · Marco Bellini · S45"
            : "Plan OLV-1 Refresh landing page hero copy · Marco Bellini · W45";
        const id = await page.evaluate(async (text) => {
          const api = await import("/data/api.ts");
          const session = await import("/data/session.ts");
          session.setSessionPersonId("p-giulia");
          const c = await api.createConversation({ contextProjectId: "prj-olv" });
          await api.runScript(c.id, [
            {
              step: "event",
              event: {
                type: "proposal",
                proposalId: "prop-capture-undo",
                requesterId: "p-giulia",
                actions: [
                  {
                    fn: "planTask",
                    args: { id: "t-olv-1", plan: { assigneeId: "p-marco", week: "2026-W45" } },
                    summary: text,
                  },
                ],
                status: "open",
                cls: "B",
                reasons: [{ kind: "notifies", personIds: ["p-marco"], more: false }],
              },
            },
          ]);
          await api.confirmProposal(c.id, "prop-capture-undo");
          return c.id;
        }, summary);
        await page.evaluate((h) => {
          window.location.hash = h;
        }, `/claude/${id}`);
        await page.locator("[data-proposal] [data-undo-button]").first().waitFor();
        await page.locator("[data-proposal] [data-undo-button]").first().click();
        await page.locator('[data-undo="confirming"]').first().waitFor();
        await page.waitForTimeout(900);
        await page.mouse.move(v.viewport.width - 2, v.viewport.height - 2);
        await shot(page, `a10a-actions-undo-card-${v.suffix}.png`);
        await context.close();
      }
      return;
    }

    // Area 10a, Task 9 (`CAPTURE_A10A_ACTIONS=1`): le azioni di Claude nella
    // conversazione di Giulia — la riga eseguita con «Undo» (MKX), la scheda B
    // con «Notifies Matteo Conti» (AUD), la scheda di un'eliminazione col
    // Confirm rosso e «Can't be undone», la riga D con il link; poi la riga
    // dopo «Undo». Scatti `a10a-actions-flow-*` e `a10a-actions-undone-*`.
    if (process.env.CAPTURE_A10A_ACTIONS) {
      const variants = [
        ...["light", "dark"].flatMap((scheme) =>
          ["en", "it"].map((lang) => ({ scheme, lang, viewport: WIDE, suffix: `${scheme}-${lang}` })),
        ),
        { scheme: "dark", lang: "en", viewport: NARROW, suffix: "narrow-en" },
        { scheme: "light", lang: "it", viewport: NARROW, suffix: "narrow-it" },
      ];
      const only = process.env.CAPTURE_ONLY ? new RegExp(process.env.CAPTURE_ONLY) : null;
      for (const v of variants) {
        const { page, context } = await open(v.scheme, v.viewport, "/home", { lang: v.lang });
        const texts =
          v.lang === "it"
            ? [
                'crea "Prova" in MKX',
                'crea "Prova" in AUD',
                "Elimina MKX-7",
                "Approva il piano di AUD-4",
                'crea "Foto del raccolto" in OLV',
              ]
            : [
                'create "Prova" in MKX',
                'create "Prova" in AUD',
                "Delete MKX-7",
                "Approve the plan of AUD-4",
                'create "Harvest photos" in OLV',
              ];
        const id = await page.evaluate(async (messages) => {
          const api = await import("/data/api.ts");
          const store = await import("/data/store.ts");
          const session = await import("/data/session.ts");
          // Un'automazione attiva sulle task nuove di AUD: la scheda B ha
          // anche il suo motivo, sotto «Notifies Matteo Conti».
          session.setSessionPersonId("p-roberta");
          const a = await api.automations.createAutomation({
            name: "Welcome new tasks",
            projectId: "prj-aud",
            flow: {
              trigger: { kind: "stubwise", event: "task_created" },
              steps: [{ id: "w", kind: "wait", for: { days: 1 } }],
              titleTemplate: "{{task.codice}}",
            },
          });
          await api.automations.activate(a.id);
          session.setSessionPersonId("p-giulia");
          const c = await api.createConversation({ contextProjectId: "prj-mkx" });
          for (const text of messages) {
            await api.sendMessage(c.id, { text });
            await api.whenIdle(c.id);
          }
          // Marco commenta la task creata in OLV: la sua riga dice «changed it afterwards».
          const olv = store.state.tasks.filter((t) => t.projectId === "prj-olv").at(-1);
          session.setSessionPersonId("p-marco");
          await api.addComment(olv.id, "I'll take the photos on Thursday.");
          session.setSessionPersonId("p-giulia");
          return c.id;
        }, texts);
        await page.evaluate((h) => {
          window.location.hash = h;
        }, `/claude/${id}`);
        await page.locator("[data-executed]").first().waitFor();
        await page.waitForTimeout(1500);
        // Il testo di Claude e la riga eseguita sotto in testa allo scatto, con la scheda B dopo.
        await page.locator("[data-user-message]").first().evaluate((el) => el.scrollIntoView({ block: "start" }));
        await page.waitForTimeout(300);
        await page.mouse.move(v.viewport.width - 2, v.viewport.height - 2);
        const flow = `a10a-actions-flow-${v.suffix}.png`;
        if (!only || only.test(flow)) await shot(page, flow);
        // La riga D (il piano di AUD-4) e la riga di OLV dopo il commento di Marco.
        await page.locator("[data-executed]").last().evaluate((el) => el.scrollIntoView({ block: "end" }));
        await page.waitForTimeout(400);
        await page.mouse.move(v.viewport.width - 2, v.viewport.height - 2);
        const changed = `a10a-actions-changed-${v.suffix}.png`;
        if (!only || only.test(changed)) await shot(page, changed);
        await page.locator("[data-executed] [data-undo-button]").first().click();
        await page.locator('[data-executed] [data-undo="undone"]').first().waitFor();
        await page.locator("[data-user-message]").first().evaluate((el) => el.scrollIntoView({ block: "start" }));
        await page.waitForTimeout(400);
        await page.mouse.move(v.viewport.width - 2, v.viewport.height - 2);
        const undone = `a10a-actions-undone-${v.suffix}.png`;
        if (!only || only.test(undone)) await shot(page, undone);
        await context.close();
      }
      // Dentro il riquadro (ruling del controller, T9): la riga eseguita col
      // rifiuto di «Undo» (permesso tolto), «Didn't run», poi la scheda C.
      // Scatti `a10a-actions-panel-rows-*` e `a10a-actions-panel-card-*`.
      for (const v of variants) {
        const { page, context } = await open(v.scheme, v.viewport, "/p/MKX/tasks", { lang: v.lang });
        await page.getByRole("button", { name: /^(Ask Claude|Chiedi a Claude)$/ }).click();
        const box = page.locator("#claude-panel textarea");
        await box.waitFor();
        const send = async (text) => {
          await box.fill(text);
          await box.press("Enter");
          await page.waitForTimeout(2500);
        };
        await send(v.lang === "it" ? 'crea "Prova" in MKX' : 'create "Prova" in MKX');
        await page.locator("#claude-panel [data-undo-button]").first().waitFor();
        // Giulia perde i permessi sulle task di MKX: «Undo» rifiuta, la prossima non parte.
        await page.evaluate(async () => {
          const viewer = await import("/data/viewer.ts");
          for (const p of ["tickets.edit", "tickets.moderate", "tickets.create"])
            viewer.revokeProjectPermission("p-giulia", "prj-mkx", p);
        });
        await page.locator("#claude-panel [data-undo-button]").first().click();
        await page.waitForTimeout(800);
        await send(v.lang === "it" ? 'crea "Altra" in MKX' : 'create "Another" in MKX');
        await page.locator("#claude-panel [data-executed-failed]").waitFor();
        await page
          .locator("#claude-panel [data-executed]")
          .first()
          .evaluate((el) => el.scrollIntoView({ block: "start" }));
        await page.waitForTimeout(400);
        await page.mouse.move(v.viewport.width - 2, v.viewport.height - 2);
        const rows = `a10a-actions-panel-rows-${v.suffix}.png`;
        if (!only || only.test(rows)) await shot(page, rows);
        // La scheda C: aggiungere Laura a OLV, col codice della verifica in due passaggi.
        const summary =
          v.lang === "it" ? "Aggiungi Laura Costa a OLV come Developer" : "Add Laura Costa to OLV as Developer";
        await page.evaluate(async (text) => {
          const api = await import("/data/api.ts");
          const store = await import("/data/store.ts");
          const c = store.state.conversations
            .filter((x) => x.ownerId === "p-giulia" && x.kind === "free")
            .at(-1);
          const args = { projectId: "prj-olv", personId: "p-laura", roleId: "role-developer" };
          await api.runScript(c.id, [
            {
              step: "event",
              event: {
                type: "proposal",
                proposalId: "prop-capture-c",
                requesterId: "p-giulia",
                actions: [{ fn: "addMember", args, summary: text }],
                status: "open",
                cls: "C",
                reasons: [{ kind: "reauth" }],
              },
            },
          ]);
        }, summary);
        await page.locator("#claude-panel [data-proposal]").last().waitFor();
        await page.waitForTimeout(600);
        await page.mouse.move(v.viewport.width - 2, v.viewport.height - 2);
        const card = `a10a-actions-panel-card-${v.suffix}.png`;
        if (!only || only.test(card)) await shot(page, card);
        // Confirm sulla scheda C: il dialogo della riconferma sopra il riquadro.
        await page
          .locator("#claude-panel [data-proposal]")
          .last()
          .getByRole("button", { name: /^(Confirm|Conferma)$/ })
          .click();
        await page.getByRole("dialog").last().waitFor();
        await page.waitForTimeout(600);
        await page.mouse.move(v.viewport.width - 2, v.viewport.height - 2);
        const reauth = `a10a-actions-panel-reauth-${v.suffix}.png`;
        if (!only || only.test(reauth)) await shot(page, reauth);
        await context.close();
      }
      return;
    }

    // Area 10a, Task 8 (`CAPTURE_A10A_PANEL=1`): il riquadro di Claude. Laura
    // sulle task di ACQ con ACQ-3 aperta nel pannello: il riquadro vuoto col
    // chip e le righe PROVA, poi una conversazione nata dal riquadro. A 1024
    // il pannello della task è sovrapposto e il riquadro sta alla sua
    // sinistra (shape claude-panel.md §4). Scatti `a10a-panel-*`.
    if (process.env.CAPTURE_A10A_PANEL) {
      const variants = [
        ...["light", "dark"].flatMap((scheme) =>
          ["en", "it"].map((lang) => ({ scheme, lang, viewport: WIDE, suffix: `${scheme}-${lang}` })),
        ),
        { scheme: "dark", lang: "en", viewport: NARROW, suffix: "narrow-en" },
        { scheme: "light", lang: "it", viewport: NARROW, suffix: "narrow-it" },
      ];
      const only = process.env.CAPTURE_ONLY ? new RegExp(process.env.CAPTURE_ONLY) : null;
      for (const v of variants) {
        const { page, context } = await open(v.scheme, v.viewport, "/p/ACQ/tasks?task=ACQ-3", {
          lang: v.lang,
          persona: "Laura",
        });
        await page.getByRole("button", { name: /^(Ask Claude|Chiedi a Claude)$/ }).click();
        await page.locator("#claude-panel [data-context-chip]").waitFor();
        await page.waitForTimeout(400);
        const empty = `a10a-panel-empty-${v.suffix}.png`;
        if (!only || only.test(empty)) await shot(page, empty);
        const box = page.locator("#claude-panel textarea");
        await box.fill(v.lang === "it" ? "Pianifica ACQ-3 per la prossima settimana" : "Plan ACQ-3 for next week");
        await box.press("Enter");
        await page.locator("#claude-panel [data-message-context]").waitFor();
        await page.waitForTimeout(2500);
        await page.mouse.move(v.viewport.width - 2, v.viewport.height - 2);
        const name = `a10a-panel-task-${v.suffix}.png`;
        if (!only || only.test(name)) await shot(page, name);
        // Il budget del mese esaurito: la fascia al posto della casella, col
        // testo scritto in sola lettura (shape §6, [CP 12]).
        await page
          .locator("#claude-panel textarea")
          .fill(v.lang === "it" ? "E chi aspetta ACQ-3?" : "And who's waiting on ACQ-3?");
        await page.evaluate(async () => {
          const api = await import("/data/api.ts");
          const session = await import("/data/session.ts");
          const before = session.getSessionPersonId();
          session.setSessionPersonId("p-roberta");
          try {
            await api.instance.simulateBudgetReached(true);
          } finally {
            session.setSessionPersonId(before);
          }
        });
        await page.locator("#claude-panel [data-budget-band]").waitFor();
        await page.waitForTimeout(400);
        const budgetName = `a10a-panel-budget-${v.suffix}.png`;
        if (!only || only.test(budgetName)) await shot(page, budgetName);
        await context.close();
      }
      return;
    }

    // Area 9c, Task 12 (`CAPTURE_A9C_AUDIT=1`): le voci del 9c nel registro,
    // scatti `a9c-audit-*`. Le voci si scrivono dal livello dati della pagina
    // con le funzioni vere (interruttore, account AI poi eliminato, variabile
    // d'ambiente, campo del repository, webhook non riuscito e poi
    // configurato; RNC eliminato e `shop-frontend` collegato ad ACQ da
    // Laura). Roberta legge tutto; Laura (con `changelog.view`) non legge
    // nulla di RNC; Giulia ha RNC «(archived)» nel filtro dei progetti.
    if (process.env.CAPTURE_A9C_AUDIT) {
      const IDS = { Laura: "p-laura", Giulia: "p-giulia", Roberta: "p-roberta" };
      const go = async (page, hash) => {
        await page.evaluate((h) => {
          window.location.hash = h;
        }, hash);
        await page.waitForTimeout(1200);
        await page.mouse.move(2, 2);
      };
      const voices = (persona) => async (page) => {
        await page.evaluate(async (back) => {
          const api = await import("/data/api.ts");
          const session = await import("/data/session.ts");
          const reauth = await import("/data/auth/reauth.ts");
          const store = await import("/data/store.ts");
          const viewer = await import("/data/viewer.ts");
          const ps = api.projectSettings;
          const as = (id) => {
            session.setSessionPersonId(id);
            reauth.markReauthenticated(id);
          };
          as("p-roberta");
          await ps.setProjectAi("prj-acq", { providerId: "prv-backup-max", exclusive: true });
          const current = await ps.getProjectSettings("prj-acq");
          await ps.saveProjectAutomations("prj-acq", {
            switches: { ...current.switches, weeklyBrief: !current.switches.weeklyBrief },
            pulseEveryDays: current.pulseEveryDays,
            correctionCap: current.correctionCap,
          });
          const created = await ps.createEnvFile("repo-acq", { environmentId: "env-acq-prod", path: ".env" });
          if (created.ok) await ps.setEnvVar(created.fileId, "DATABASE_URL", "postgres://prototype");
          await ps.updateRepository("repo-acq", { testCommand: "pnpm test" });
          await ps.simulateNextWebhookSetup("failed");
          await ps.configureRepositoryWebhook("repo-acq");
          await ps.configureRepositoryWebhook("repo-acq");
          await ps.deleteProject("prj-rnc", { confirmCode: "RNC" });
          as("p-laura");
          await api.instance.linkRepository("repo-shop", "prj-acq");
          viewer.grantInstancePermission("p-laura", "changelog.view");
          store.state.instance.providers = store.state.instance.providers.filter(
            (p) => p.id !== "prv-backup-max",
          );
          as(back);
        }, IDS[persona]);
      };
      const projectMenu = async (page) => {
        await page.getByRole("button", { name: /^(Project|Progetto)/ }).first().click();
        await page.getByRole("menu").waitFor();
        // RNC sta in fondo all'elenco: lo si cerca, così lo scatto lo mostra.
        await page.keyboard.type("RN");
        await page.waitForTimeout(300);
      };
      const SCENES = [
        ["audit-admin", "/admin/changelog", { persona: "Roberta", before: voices("Roberta") }],
        ["audit-admin-laura", "/admin/changelog", { persona: "Laura", before: voices("Laura") }],
        ["audit-project", "/p/ACQ/settings/changelog", { persona: "Laura", before: voices("Laura") }],
        ["audit-archived-filter", "/admin/changelog", { persona: "Giulia", after: projectMenu }],
      ];
      const variants = [
        ...["light", "dark"].flatMap((scheme) =>
          ["en", "it"].map((lang) => ({ scheme, lang, viewport: WIDE, suffix: `${scheme}-${lang}` })),
        ),
        { scheme: "dark", lang: "en", viewport: NARROW, suffix: "narrow-en" },
        { scheme: "light", lang: "it", viewport: NARROW, suffix: "narrow-it" },
      ];
      const only = process.env.CAPTURE_ONLY ? new RegExp(process.env.CAPTURE_ONLY) : null;
      for (const [name, hash, opts] of SCENES) {
        if (only && !only.test(name)) continue;
        for (const v of variants) {
          const { page, context } = await open(v.scheme, v.viewport, "/home", {
            lang: v.lang,
            persona: opts.persona,
          });
          if (opts.before) await opts.before(page);
          await go(page, hash);
          if (opts.after) await opts.after(page);
          await shot(page, `a9c-${name}-${v.suffix}.png`);
          await context.close();
        }
      }
      return;
    }

    // Area 9c, Task 11 (`CAPTURE_A9C_ARCHIVE=1`): archiviare, la scheda
    // Archived, la pagina dell'archiviato, Reopen e Delete, il gruppo «Not in
    // any project» di Amministrazione → Repositories (shape
    // project-archive.md), scatti `a9c-archive-*`. Laura in ACQ; Sara in
    // sola lettura; Giulia ex membro di RNC; Roberta full admin. Per il
    // gruppo, RNC lo elimina Roberta prima di aprire la pagina.
    if (process.env.CAPTURE_A9C_ARCHIVE) {
      const IDS = { Laura: "p-laura", Sara: "p-sara", Giulia: "p-giulia", Roberta: "p-roberta" };
      const go = async (page, hash) => {
        await page.evaluate((h) => {
          window.location.hash = h;
        }, hash);
        await page.waitForTimeout(1200);
        await page.mouse.move(2, 2);
      };
      const settle = async (page) => {
        await page.waitForTimeout(500);
        await page.mouse.move(2, 2);
      };
      const click = async (page, name) => {
        await page.getByRole("button", { name }).first().click();
        await settle(page);
      };
      const deleteRnc = (persona) => async (page) => {
        await page.evaluate(async (back) => {
          const api = await import("/data/api.ts");
          const session = await import("/data/session.ts");
          const reauth = await import("/data/auth/reauth.ts");
          session.setSessionPersonId("p-roberta");
          reauth.markReauthenticated("p-roberta");
          await api.projectSettings.deleteProject("prj-rnc", { confirmCode: "RNC" });
          session.setSessionPersonId(back);
        }, IDS[persona]);
      };
      const busy = async (page) => {
        await page.evaluate(async () => {
          const store = await import("/data/store.ts");
          store.state.conversations.find((c) => c.id === "cv-run-acq-3").state = "working";
        });
      };
      const archiveDialog = (page) => click(page, /^(Archive ACQ…|Archivia ACQ…)$/);
      const archiveBusy = async (page) => {
        await archiveDialog(page);
        await page
          .getByRole("dialog")
          .getByRole("button", { name: /^(Archive|Archivia)$/ })
          .click();
        await page.waitForTimeout(1200);
        await settle(page);
      };
      // Il gruppo «Not in any project» sta in fondo: a 1024 va portato in vista.
      const toGroup = async (page) => {
        await page
          .getByRole("heading", { level: 2, name: /^(Not in any project|In nessun progetto)$/ })
          .evaluate((el) => el.scrollIntoView({ block: "center" }));
        await settle(page);
      };
      const rowMenu = (page) => click(page, /^(More for RNC|Altro per RNC)$/);
      const reopenDialog = (page) => click(page, /^(Reopen|Riapri)$/);
      const deleteDialog = (page) => click(page, /^(Delete for good…|Elimina per sempre…)$/);
      const deleteTyped = async (page) => {
        await deleteDialog(page);
        await page.getByRole("dialog").getByRole("textbox").fill("rnc");
        await settle(page);
      };
      const deleteReady = async (page) => {
        await deleteDialog(page);
        await page.getByRole("dialog").getByRole("textbox").fill("RNC");
        await settle(page);
      };
      const linkDialog = async (page) => {
        await toGroup(page);
        await click(page, /^(Link to a project…|Collega a un progetto…)$/);
        await page.getByRole("dialog").getByRole("combobox").selectOption("prj-acq");
        await settle(page);
      };
      const repoDelete = async (page) => {
        await toGroup(page);
        await click(page, /^(More for shop-frontend|Altro per shop-frontend)$/);
        await page.getByRole("menuitem", { name: /^(Delete…|Elimina…)$/ }).click();
        await settle(page);
      };
      const SETTINGS = "/p/ACQ/settings/archive";
      const ARCHIVED = "/projects?view=archived";
      const SCENES = [
        ["archive", SETTINGS, { persona: "Laura" }],
        ["archive-dialog", SETTINGS, { persona: "Laura", after: archiveDialog }],
        ["archive-busy", SETTINGS, { persona: "Laura", before: busy, after: archiveBusy }],
        ["archive-readonly", SETTINGS, { persona: "Sara" }],
        ["archive-list", ARCHIVED, { persona: "Giulia" }],
        ["archive-list-menu", ARCHIVED, { persona: "Giulia", after: rowMenu }],
        ["archive-page", "/archived/RNC", { persona: "Giulia" }],
        ["archive-page-admin", "/archived/RNC", { persona: "Roberta" }],
        ["archive-reopen", "/archived/RNC", { persona: "Giulia", after: reopenDialog }],
        ["archive-delete", "/archived/RNC", { persona: "Roberta", after: deleteDialog }],
        ["archive-delete-typed", "/archived/RNC", { persona: "Roberta", after: deleteTyped }],
        ["archive-delete-ready", "/archived/RNC", { persona: "Roberta", after: deleteReady }],
        ["archive-detached", "/admin/repositories", { persona: "Roberta", before: deleteRnc("Roberta"), after: toGroup }],
        ["archive-detached-laura", "/admin/repositories", { persona: "Laura", before: deleteRnc("Laura"), after: toGroup }],
        ["archive-link", "/admin/repositories", { persona: "Laura", before: deleteRnc("Laura"), after: linkDialog }],
        ["archive-repo-delete", "/admin/repositories", { persona: "Roberta", before: deleteRnc("Roberta"), after: repoDelete }],
        ["archive-git-accounts", "/admin/git-accounts", { persona: "Roberta", before: deleteRnc("Roberta") }],
      ];
      const variants = [
        ...["light", "dark"].flatMap((scheme) =>
          ["en", "it"].map((lang) => ({ scheme, lang, viewport: WIDE, suffix: `${scheme}-${lang}` })),
        ),
        { scheme: "dark", lang: "en", viewport: NARROW, suffix: "narrow-en" },
        { scheme: "light", lang: "it", viewport: NARROW, suffix: "narrow-it" },
      ];
      const only = process.env.CAPTURE_ONLY ? new RegExp(process.env.CAPTURE_ONLY) : null;
      for (const [name, hash, opts] of SCENES) {
        if (only && !only.test(name)) continue;
        for (const v of variants) {
          const { page, context } = await open(v.scheme, v.viewport, "/home", {
            lang: v.lang,
            persona: opts.persona,
          });
          if (opts.before) await opts.before(page);
          await go(page, hash);
          if (opts.after) await opts.after(page);
          await shot(page, `a9c-${name}-${v.suffix}.png`);
          await context.close();
        }
      }
      return;
    }

    // Area 9c, Task 10 (`CAPTURE_A9C_PLUGINS=1`): Progetto → Settings →
    // Plugins (shape project-plugins.md), scatti `a9c-plugins-*`. Laura in
    // STW; Sara in sola lettura; il conflitto con Roberta che salva
    // «dall'altra finestra» fra la lettura e il salvataggio di Laura.
    if (process.env.CAPTURE_A9C_PLUGINS) {
      const go = async (page, hash) => {
        await page.evaluate((h) => {
          window.location.hash = h;
        }, hash);
        await page.waitForTimeout(1200);
        await page.mouse.move(2, 2);
      };
      const skill = (page, name) =>
        page.getByRole("checkbox", { name: new RegExp(`^(Use the skill|Usa la skill) ${name}$`) });
      const save = async (page) => {
        await page.locator("[data-save-bar]").getByRole("button", { name: /^(Save|Salva)$/ }).click();
        await page.waitForTimeout(900);
        await page.mouse.move(2, 2);
      };
      const preset = async (page) => {
        await page.getByRole("button", { name: /^(Apply recommended preset|Applica il preset consigliato)$/ }).click();
        await page.waitForTimeout(300);
        await page.mouse.move(2, 2);
      };
      const edited = async (page) => {
        await skill(page, "brainstorming").click();
        await page.getByRole("checkbox", { name: /SessionStart#0$/ }).click();
        await page.mouse.move(2, 2);
      };
      const saved = async (page) => {
        await skill(page, "brainstorming").click();
        await save(page);
      };
      const conflict = async (page) => {
        await skill(page, "brainstorming").click();
        await skill(page, "writing-plans").click();
        await page.evaluate(async () => {
          const api = await import("/data/api.ts");
          const session = await import("/data/session.ts");
          session.setSessionPersonId("p-roberta");
          const v = await api.projectSettings.getProjectPlugins("prj-stw");
          await api.projectSettings.saveProjectPlugins("prj-stw", {
            version: v.version,
            disabled: [{ plugin: "superpowers", skills: ["brainstorming", "test-driven-development"], hookGroups: [] }],
          });
          session.setSessionPersonId("p-laura");
        });
        await save(page);
      };
      const conflictLeave = async (page) => {
        await conflict(page);
        await page.locator('[data-settings-section="general"]').first().click();
        await page.waitForTimeout(300);
        await page.mouse.move(2, 2);
      };
      const keepMine = async (page) => {
        await conflict(page);
        await page.getByRole("button", { name: /^(Keep my changes on theirs|Tieni le mie modifiche sulle loro)$/ }).click();
        await page.waitForTimeout(300);
        await page.mouse.move(2, 2);
      };
      const bottom = async (page) => {
        await page.getByRole("heading", { level: 2, name: /^(Not in runs|Fuori dalle esecuzioni)$/ }).evaluate((el) =>
          el.scrollIntoView({ block: "center" }),
        );
        await page.waitForTimeout(200);
        await page.mouse.move(2, 2);
      };
      const PLUGINS = "/p/STW/settings/plugins";
      const SCENES = [
        ["plugins", PLUGINS, { persona: "Laura" }],
        ["plugins-edited", PLUGINS, { persona: "Laura", after: edited }],
        ["plugins-preset", PLUGINS, { persona: "Laura", after: preset }],
        ["plugins-saved", PLUGINS, { persona: "Laura", after: saved }],
        ["plugins-conflict", PLUGINS, { persona: "Laura", after: conflict }],
        ["plugins-conflict-leave", PLUGINS, { persona: "Laura", after: conflictLeave }],
        ["plugins-keep-mine", PLUGINS, { persona: "Laura", after: keepMine }],
        ["plugins-not-ready", PLUGINS, { persona: "Laura", after: bottom }],
        ["plugins-readonly", PLUGINS, { persona: "Sara" }],
      ];
      const variants = [
        ...["light", "dark"].flatMap((scheme) =>
          ["en", "it"].map((lang) => ({ scheme, lang, viewport: WIDE, suffix: `${scheme}-${lang}` })),
        ),
        { scheme: "dark", lang: "en", viewport: NARROW, suffix: "narrow-en" },
        { scheme: "light", lang: "it", viewport: NARROW, suffix: "narrow-it" },
      ];
      const only = process.env.CAPTURE_ONLY ? new RegExp(process.env.CAPTURE_ONLY) : null;
      for (const [name, hash, opts] of SCENES) {
        if (only && !only.test(name)) continue;
        for (const v of variants) {
          const { page, context } = await open(v.scheme, v.viewport, "/home", {
            lang: v.lang,
            persona: opts.persona,
          });
          await go(page, hash);
          if (opts.after) await opts.after(page);
          await shot(page, `a9c-${name}-${v.suffix}.png`);
          await context.close();
        }
      }
      return;
    }

    // Area 9c, Task 9 (`CAPTURE_A9C_ENV=1`): i file d'ambiente nella pagina
    // del repository e Progetto → Settings → Integration (shape
    // project-repositories.md), scatti `a9c-env-*` e `a9c-integration-*`.
    // Laura è riconfermata in anticipo (la riconferma ha i suoi scatti, 9a);
    // Marco in sola lettura come al Task 8, Sara Contributor in ACQ.
    if (process.env.CAPTURE_A9C_ENV) {
      async function prepare(page, action) {
        await page.evaluate(async (what) => {
          const viewer = await import("/data/viewer.ts");
          const reauth = await import("/data/auth/reauth.ts");
          if (what === "readOnly") viewer.revokeProjectPermission("p-marco", "prj-acq", "repos.manage");
          if (what === "reauthed") reauth.markReauthenticated("p-laura");
        }, action);
      }
      const go = async (page, hash) => {
        await page.evaluate((h) => {
          window.location.hash = h;
        }, hash);
        await page.waitForTimeout(1200);
        await page.mouse.move(2, 2);
      };
      const it = (page) => page.evaluate(() => document.documentElement.lang === "it");
      const dialog = (page) => page.getByRole("dialog");
      /** Porta in alto la testata di una parte (le parti basse della pagina). */
      const scrollTo = (heading) => async (page) => {
        await page.getByRole("heading", { level: 2, name: heading }).first().evaluate((el) => {
          el.scrollIntoView({ block: "start" });
          el.closest("main, [data-scroll], .overflow-y-auto")?.scrollBy(0, -16);
        });
        await page.waitForTimeout(200);
        await page.mouse.move(2, 2);
      };
      const envHeading = /^(Environment files|File d'ambiente)$/;
      const fileButton = async (page, group, name) => {
        const g = page.getByRole("group", { name: group });
        await g.getByRole("button", { name }).first().click();
        await page.waitForTimeout(300);
      };
      const importOpen = async (page) => {
        await scrollTo(envHeading)(page);
        await fileButton(page, /^TEST/i, /^(Import…|Importa…)$/);
        await dialog(page)
          .locator("textarea")
          .fill(
            "FEATURE_FLAG=on\nDATABASE_URL=postgres://db.internal/stw_test\nthis line is broken\nSMTP_PASSWORD=prototype-only",
          );
        await page.mouse.move(2, 2);
      };
      const importDone = async (page) => {
        await importOpen(page);
        await dialog(page).getByRole("button", { name: /^(Import|Importa)$/ }).click();
        await page.waitForTimeout(1200);
        await page.mouse.move(2, 2);
      };
      const setOpen = async (page) => {
        await scrollTo(envHeading)(page);
        const production = page.getByRole("group", { name: /^PRODUCTION/i });
        await production.getByRole("button", { name: /^(Replace…|Sostituisci…)$/ }).first().click();
        await page.waitForTimeout(300);
        await dialog(page).locator("input[type=password]").fill("postgres://prototype");
        await page.mouse.move(2, 2);
      };
      const deleteOpen = async (page) => {
        await scrollTo(envHeading)(page);
        const production = page.getByRole("group", { name: /^PRODUCTION/i });
        await production.getByRole("button", { name: /^(More for|Altro per)/ }).click();
        await page.getByRole("menuitem").first().click();
        await page.waitForTimeout(300);
        await page.mouse.move(2, 2);
      };
      const regenerateKey = async (page) => {
        const name = (await it(page)) ? "Rigenera la chiave…" : "Regenerate key…";
        await page.getByRole("button", { name }).click();
        await page.waitForTimeout(300);
        await page.mouse.move(2, 2);
      };
      const keyShown = async (page) => {
        await regenerateKey(page);
        await dialog(page).getByRole("button", { name: /^(Regenerate|Rigenera)$/ }).click();
        await page.waitForTimeout(1200);
        await page.mouse.move(2, 2);
      };
      const STW_REPO = "/p/STW/settings/repositories?repo=repo-stw";
      const ACQ_REPO = "/p/ACQ/settings/repositories?repo=repo-acq";
      const INTEGRATION = "/p/ACQ/settings/integration";
      const SCENES = [
        // [nome, indirizzo, { persona, action, after }]
        ["env-files", STW_REPO, { persona: "Laura", after: scrollTo(envHeading) }],
        ["env-readonly", ACQ_REPO, { persona: "Marco", action: "readOnly", after: scrollTo(envHeading) }],
        ["env-import", STW_REPO, { persona: "Laura", action: "reauthed", after: importOpen }],
        ["env-import-done", STW_REPO, { persona: "Laura", action: "reauthed", after: importDone }],
        ["env-set", STW_REPO, { persona: "Laura", after: setOpen }],
        ["env-delete", STW_REPO, { persona: "Laura", after: deleteOpen }],
        ["integration", INTEGRATION, { persona: "Laura" }],
        ["integration-git", INTEGRATION, { persona: "Laura", after: scrollTo(/^(Git webhooks|Webhook git)$/) }],
        ["integration-readonly", INTEGRATION, { persona: "Sara" }],
        ["integration-regenerate", INTEGRATION, { persona: "Laura", after: regenerateKey }],
        ["integration-secret", INTEGRATION, { persona: "Laura", action: "reauthed", after: keyShown }],
      ];
      const variants = [
        ...["light", "dark"].flatMap((scheme) =>
          ["en", "it"].map((lang) => ({ scheme, lang, viewport: WIDE, suffix: `${scheme}-${lang}` })),
        ),
        { scheme: "dark", lang: "en", viewport: NARROW, suffix: "narrow-en" },
        { scheme: "light", lang: "it", viewport: NARROW, suffix: "narrow-it" },
      ];
      const only = process.env.CAPTURE_ONLY ? new RegExp(process.env.CAPTURE_ONLY) : null;
      for (const [name, hash, opts] of SCENES) {
        if (only && !only.test(name)) continue;
        for (const v of variants) {
          const { page, context } = await open(v.scheme, v.viewport, "/home", {
            lang: v.lang,
            persona: opts.persona,
          });
          if (opts.action) await prepare(page, opts.action);
          await go(page, hash);
          if (opts.after) await opts.after(page);
          await shot(page, `a9c-${name}-${v.suffix}.png`);
          await context.close();
        }
      }
      return;
    }

    // Area 9c, Task 8 (`CAPTURE_A9C_REPOS=1`): Progetto → Settings →
    // Repositories, la creazione guidata, la pagina del repository e il
    // webhook (shape project-repositories.md), scatti `a9c-repos-*`. Marco
    // in sola lettura: gli si toglie `repos.manage` in ACQ (ruling (T4)).
    if (process.env.CAPTURE_A9C_REPOS) {
      async function prepare(page, action) {
        await page.evaluate(async (what) => {
          const { state } = await import("/data/store.ts");
          const viewer = await import("/data/viewer.ts");
          if (what === "readOnly") viewer.revokeProjectPermission("p-marco", "prj-acq", "repos.manage");
          if (what === "failed")
            Object.assign(state.repositories.find((r) => r.id === "repo-acq").webhook, {
              state: "failed",
              configuredAt: "2026-10-31T09:00:00Z",
            });
        }, action);
      }
      const go = async (page, hash) => {
        await page.evaluate((h) => {
          window.location.hash = h;
        }, hash);
        await page.waitForTimeout(1200);
        await page.mouse.move(2, 2);
      };
      const it = (page) => page.evaluate(() => document.documentElement.lang === "it");
      const dialog = (page) => page.getByRole("dialog");
      const next = async (page) => {
        await dialog(page).getByRole("button", { name: (await it(page)) ? "Avanti" : "Next" }).click();
        await page.waitForTimeout(300);
      };
      const toRepository = async (page) => {
        await dialog(page).getByRole("radio", { name: /Bitbucket Audin/ }).check();
        await next(page);
        await dialog(page).getByRole("searchbox").fill("a");
        await dialog(page).getByRole("radio", { name: /audin\/fatture-api/ }).check();
        await page.mouse.move(2, 2);
      };
      const verify = (outcome) => async (page) => {
        await toRepository(page);
        await next(page);
        await next(page);
        const box = dialog(page).locator("[data-prototype-only]");
        await box.getByRole("radio").nth(outcome).click();
        await dialog(page).getByRole("button", { name: /^(Verify access|Verifica gli accessi)$/ }).click();
        await page.waitForTimeout(1200);
        if (outcome === 0)
          await dialog(page).getByRole("textbox", { name: /^(Test command|Comando dei test)$/ }).fill("npm test");
        await page.mouse.move(2, 2);
      };
      const edit = async (page) => {
        const field = page.locator("textarea");
        await field.fill("main\n\nrelease/*");
        await page.getByRole("button", { name: /^(Save|Salva)$/ }).click();
        await page.waitForTimeout(1500);
        await page.mouse.move(2, 2);
      };
      const reviewError = async (page) => {
        await page.evaluate(async () => {
          const { state } = await import("/data/store.ts");
          const audin = state.instance.gitAccounts.find((g) => g.id === "git-bitbucket-audin");
          state.instance.gitAccounts.push({ ...audin, id: "git-bitbucket-review", name: "Bitbucket Review" });
          state.repositories.find((r) => r.id === "repo-acq").reviewGitAccountId = "git-bitbucket-review";
        });
        await go(page, "/p/AUD/settings/repositories");
        await go(page, "/p/ACQ/settings/repositories?repo=repo-acq");
        await page.locator("select").first().selectOption("git-bitbucket-review");
        await page.getByRole("button", { name: /^(Save|Salva)$/ }).click();
        await page.waitForTimeout(1500);
        await page.mouse.move(2, 2);
      };
      const SCENES = [
        // [nome, indirizzo, { persona, action, after }]
        ["list", "/p/ACQ/settings/repositories", { persona: "Laura" }],
        ["list-readonly", "/p/ACQ/settings/repositories", { persona: "Marco", action: "readOnly" }],
        ["wizard-account", "/p/ACQ/settings/repositories?new=1", { persona: "Laura" }],
        ["wizard-repository", "/p/ACQ/settings/repositories?new=1", { persona: "Laura", after: toRepository }],
        ["wizard-access-ok", "/p/ACQ/settings/repositories?new=1", { persona: "Laura", after: verify(0) }],
        ["wizard-access-invalid", "/p/ACQ/settings/repositories?new=1", { persona: "Laura", after: verify(1) }],
        ["repo", "/p/ACQ/settings/repositories?repo=repo-acq", { persona: "Laura" }],
        ["repo-bar", "/p/ACQ/settings/repositories?repo=repo-acq", { persona: "Laura", after: edit }],
        ["repo-review-error", "/p/ACQ/settings/repositories?repo=repo-acq", { persona: "Laura", after: reviewError }],
        ["repo-failed", "/p/ACQ/settings/repositories?repo=repo-acq", { persona: "Laura", action: "failed" }],
        ["repo-readonly", "/p/ACQ/settings/repositories?repo=repo-acq", { persona: "Marco", action: "readOnly" }],
        ["repo-releases", "/p/AUD/settings/repositories?repo=repo-aud", { persona: "Laura" }],
      ];
      const variants = [
        ...["light", "dark"].flatMap((scheme) =>
          ["en", "it"].map((lang) => ({ scheme, lang, viewport: WIDE, suffix: `${scheme}-${lang}` })),
        ),
        { scheme: "dark", lang: "en", viewport: NARROW, suffix: "narrow-en" },
        { scheme: "light", lang: "it", viewport: NARROW, suffix: "narrow-it" },
      ];
      const only = process.env.CAPTURE_ONLY ? new RegExp(process.env.CAPTURE_ONLY) : null;
      for (const [name, hash, opts] of SCENES) {
        if (only && !only.test(name)) continue;
        for (const v of variants) {
          const { page, context } = await open(v.scheme, v.viewport, "/home", {
            lang: v.lang,
            persona: opts.persona,
          });
          if (opts.action) await prepare(page, opts.action);
          await go(page, hash);
          if (opts.after) await opts.after(page);
          await shot(page, `a9c-repos-${name}-${v.suffix}.png`);
          await context.close();
        }
      }
      return;
    }

    // Area 9c, Task 7 (`CAPTURE_A9C_SETTINGS=1`): Progetto → Settings →
    // General, AI, Automations, Usage e il segno «View only» (shape
    // project-settings.md), scatti `a9c-settings-*`. Lo stato si prepara dal
    // livello dati della pagina; `after` agisce sulla pagina come chi guarda.
    if (process.env.CAPTURE_A9C_SETTINGS) {
      async function prepare(page, action) {
        await page.evaluate(async (what) => {
          const { state } = await import("/data/store.ts");
          const viewer = await import("/data/viewer.ts");
          if (what === "deleted") state.projectSettings.get("prj-acq").aiProviderId = "prv-gone";
          if (what === "membersOnly")
            viewer.grantProjectPermission("p-sara", "prj-acq", "project.members.manage");
        }, action);
      }
      const go = async (page, hash) => {
        await page.evaluate((h) => {
          window.location.hash = h;
        }, hash);
        await page.waitForTimeout(1200);
        await page.mouse.move(2, 2);
      };
      const it = (page) => page.evaluate(() => document.documentElement.lang === "it");
      const chooseBackup = async (page) => {
        await page.getByRole("radio", { name: /^Backup Max/ }).check();
        await page.getByRole("checkbox", { name: (await it(page)) ? "Usa solo questo account" : "Use only this account" }).check();
        await page.mouse.move(2, 2);
      };
      const discoveryOff = async (page) => {
        const name = (await it(page)) ? "Discovery del backlog" : "Backlog discovery";
        await page.getByRole("switch", { name }).click();
        await page.getByRole("spinbutton").last().fill("0");
        await page.mouse.move(2, 2);
        await page.waitForTimeout(300);
      };
      const emptyName = async (page) => {
        await page.getByRole("textbox").first().fill("");
        await page.getByRole("button", { name: /^(Save|Salva)$/ }).click();
        await page.mouse.move(2, 2);
        await page.waitForTimeout(1500);
      };
      const bottom = async (page) => {
        await page.evaluate(() => {
          for (const el of document.querySelectorAll("main, main *"))
            if (el.scrollHeight > el.clientHeight + 4) el.scrollTop = el.scrollHeight;
        });
        await page.waitForTimeout(300);
      };
      const SCENES = [
        // [nome, indirizzo, { persona, action, after }]
        ["general", "/p/ACQ/settings/general", { persona: "Laura" }],
        ["general-error", "/p/ACQ/settings/general", { persona: "Laura", after: emptyName }],
        ["general-readonly", "/p/ACQ/settings/general", { persona: "Sara" }],
        ["general-members-only", "/p/ACQ/settings/general", { persona: "Sara", action: "membersOnly" }],
        ["ai", "/p/ACQ/settings/ai", { persona: "Laura", after: chooseBackup }],
        ["ai-deleted", "/p/ACQ/settings/ai", { persona: "Laura", action: "deleted" }],
        ["ai-readonly", "/p/ACQ/settings/ai", { persona: "Sara" }],
        ["automations", "/p/ACQ/settings/automations", { persona: "Laura", after: discoveryOff }],
        ["automations-bar", "/p/ACQ/settings/automations", { persona: "Laura", after: async (page) => { await discoveryOff(page); await bottom(page); } }],
        ["automations-readonly", "/p/ACQ/settings/automations", { persona: "Sara" }],
        ["usage", "/p/ACQ/settings/usage", { persona: "Laura" }],
        ["statuses-readonly", "/p/ACQ/settings/statuses", { persona: "Sara" }],
      ];
      const variants = [
        ...["light", "dark"].flatMap((scheme) =>
          ["en", "it"].map((lang) => ({ scheme, lang, viewport: WIDE, suffix: `${scheme}-${lang}` })),
        ),
        { scheme: "dark", lang: "en", viewport: NARROW, suffix: "narrow-en" },
        { scheme: "light", lang: "it", viewport: NARROW, suffix: "narrow-it" },
      ];
      const only = process.env.CAPTURE_ONLY ? new RegExp(process.env.CAPTURE_ONLY) : null;
      for (const [name, hash, opts] of SCENES) {
        if (only && !only.test(name)) continue;
        for (const v of variants) {
          const { page, context } = await open(v.scheme, v.viewport, "/home", {
            lang: v.lang,
            persona: opts.persona,
          });
          if (opts.action) await prepare(page, opts.action);
          await go(page, hash);
          if (opts.after) await opts.after(page);
          await shot(page, `a9c-settings-${name}-${v.suffix}.png`);
          await context.close();
        }
      }
      return;
    }

    // Area 9c, Task 6 (`CAPTURE_A9C_EFFECTS=1`): gli effetti delle impostazioni
    // di progetto nelle altre aree (shape project-effects.md), scatti
    // `a9c-effects-*`. Lo stato si prepara dal livello dati della pagina (gli
    // stessi moduli che l'app ha già caricato), a nome di Roberta; un'azione
    // può restituire l'indirizzo da aprire dopo.
    if (process.env.CAPTURE_A9C_EFFECTS) {
      async function prepare(page, action) {
        const hash = await page.evaluate(async (what) => {
          const api = await import("/data/api.ts");
          const session = await import("/data/session.ts");
          const { state } = await import("/data/store.ts");
          const prev = session.getSessionPersonId();
          session.setSessionPersonId("p-roberta");
          const switches = (id) => state.projectSettings.get(id).switches;
          const ready = (projectId) => {
            const t = state.tasks.find(
              (x) => x.projectId === projectId && x.claude === "none" && x.closedAt === null,
            );
            t.assigneeId = "p-claude";
            return t;
          };
          const general = async () => {
            const a = await api.automations.createAutomation({
              name: "Onboarding request",
              projectId: null,
              flow: {
                trigger: { kind: "manual" },
                titleTemplate: "Onboarding request",
                steps: [
                  { id: "n", kind: "notify", who: { personId: "p-roberta" }, text: "A new request arrived.", approval: { mode: "auto" } },
                  {
                    id: "t",
                    kind: "createTask",
                    title: "Set up the customer portal account",
                    description: "",
                    assignee: null,
                    dueInDays: 3,
                    project: { mode: "fixed", projectId: "prj-acq" },
                    milestoneRef: null,
                    approval: { mode: "auto" },
                  },
                ],
              },
            });
            await api.automations.activate(a.id);
            session.setSessionPersonId("p-laura");
            await api.projectSettings.archiveProject("prj-acq");
            session.setSessionPersonId("p-roberta");
            return state.automations.find((x) => x.id === a.id);
          };
          try {
            if (what === "gltBriefOff") switches("prj-glt").weeklyBrief = false;
            if (what === "stwDocsOff") switches("prj-stw").docsNightly = false;
            if (what === "cbvDocsOff") switches("prj-cbv").docsNightly = false;
            if (what === "audReportOff") switches("prj-aud").dailyReport = false;
            if (what === "cbvQuiet") {
              for (const t of state.tasks.filter((x) => x.projectId === "prj-cbv"))
                state.tasksById.delete(t.id);
              state.tasks = state.tasks.filter((x) => x.projectId !== "prj-cbv");
              state.milestones = state.milestones.filter((m) => m.projectId !== "prj-cbv");
              state.projectsById.get("prj-cbv").signals.claudeWorking = false;
            }
            if (what === "audExclusive") {
              state.instance.models.fix_plan = "sonnet";
              const p = state.instance.providers.find((x) => x.id === "prv-backup-max");
              p.quota = { ...p.quota, limitedUntil: "2099-01-01T00:00:00Z" };
              const t = ready("prj-aud");
              session.setSessionPersonId("p-laura");
              await api.startRun(t.id);
              return `/p/AUD/tasks?task=${t.code}`;
            }
            if (what === "stwSkills" || what === "stwSession") {
              state.instance.models.fix_plan = "sonnet";
              state.instance.queuePauses = [];
              state.projectSettings.get("prj-stw").plugins.disabled = [
                { plugin: "superpowers", skills: ["brainstorming"], hookGroups: [] },
              ];
              const t = ready("prj-stw");
              const c = await api.startRun(t.id);
              return what === "stwSkills" ? `/p/STW/tasks?task=${t.code}` : `/claude/${c.id}`;
            }
            if (what === "builder") return `/automations/${(await general()).code}/edit?step=t`;
            if (what === "run") {
              const a = await general();
              await api.automations.startManual(a.id);
              await api.automations.whenAutomationsIdle();
              return `/automations/${a.code}/runs/1`;
            }
            return null;
          } finally {
            session.setSessionPersonId(prev);
          }
        }, action);
        await page.waitForTimeout(900);
        return hash;
      }
      const go = async (page, hash) => {
        await page.evaluate((h) => {
          window.location.hash = h;
        }, hash);
        await page.waitForTimeout(1200);
        await page.mouse.move(2, 2);
      };
      // La sezione Claude in cima al pannello, con «Skills in this run» aperta.
      const toClaude = (open) => async (page) => {
        await page.evaluate(() => {
          const section = document.querySelector("[data-claude-status]")?.closest("section");
          const scroller = section?.closest("[data-detail-panel] > .overflow-auto");
          if (section && scroller)
            scroller.scrollTop +=
              section.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
        });
        if (open) await page.locator("[data-run-skills] button").first().click();
        await page.mouse.move(2, 2);
        await page.waitForTimeout(300);
      };
      const openSkills = async (page) => {
        await page.locator("[data-run-skills] button").first().click();
        await page.mouse.move(2, 2);
        await page.waitForTimeout(300);
      };
      const SCENES = [
        // [nome, indirizzo, { persona, action, after }]
        ["brief-written", "/p/MKX/overview", { persona: "Giulia" }],
        ["brief-none", "/p/GLT/overview", { persona: "Giulia", action: "gltBriefOff" }],
        ["pulse-off", "/p/CBV/overview", { persona: "Roberta", action: "cbvQuiet" }],
        ["docs-home", "/p/STW/docs", { persona: "Laura", action: "stwDocsOff" }],
        ["releases-empty", "/p/CBV/docs/bellavista-store/releases", { persona: "Roberta", action: "cbvDocsOff" }],
        ["releases-written", "/p/STW/docs/stubwise/releases", { persona: "Laura", action: "stwDocsOff" }],
        ["report-off", "/projects?view=person", { persona: "Roberta", action: "audReportOff" }],
        ["claude-exclusive", "/home", { persona: "Laura", action: "audExclusive", after: toClaude(false) }],
        ["claude-skills", "/home", { persona: "Roberta", action: "stwSkills", after: toClaude(true) }],
        ["session-skills", "/home", { persona: "Roberta", action: "stwSession", after: openSkills }],
        ["servers-archived", "/admin/servers", { persona: "Roberta" }],
        ["automation-builder", "/home", { persona: "Roberta", action: "builder" }],
        ["automation-run", "/home", { persona: "Roberta", action: "run" }],
      ];
      const variants = [
        ...["light", "dark"].flatMap((scheme) =>
          ["en", "it"].map((lang) => ({ scheme, lang, viewport: WIDE, suffix: `${scheme}-${lang}` })),
        ),
        { scheme: "dark", lang: "en", viewport: NARROW, suffix: "narrow-en" },
        { scheme: "light", lang: "it", viewport: NARROW, suffix: "narrow-it" },
      ];
      const only = process.env.CAPTURE_ONLY ? new RegExp(process.env.CAPTURE_ONLY) : null;
      for (const [name, hash, opts] of SCENES) {
        if (only && !only.test(name)) continue;
        for (const v of variants) {
          const { page, context } = await open(v.scheme, v.viewport, "/home", {
            lang: v.lang,
            persona: opts.persona,
          });
          const then = opts.action ? await prepare(page, opts.action) : null;
          await go(page, then ?? hash);
          if (opts.after) await opts.after(page);
          await shot(page, `a9c-effects-${name}-${v.suffix}.png`);
          await context.close();
        }
      }
      return;
    }

    // Area 9b, Task 6 (`CAPTURE_A9B_EFFECTS=1`): gli effetti delle impostazioni
    // d'istanza nelle altre aree (shape instance-effects.md). Lo stato si
    // prepara dal livello dati della pagina stessa (gli stessi moduli che
    // l'app ha già caricato), a nome di Roberta, poi si torna a chi guarda.
    if (process.env.CAPTURE_A9B_EFFECTS) {
      async function asAdmin(page, action) {
        await page.evaluate(async (what) => {
          const api = await import("/data/api.ts");
          const session = await import("/data/session.ts");
          const prev = session.getSessionPersonId();
          session.setSessionPersonId("p-roberta");
          try {
            if (what === "budget") await api.instance.simulateBudgetReached(true);
            if (what === "uploadsOff") await api.instance.setAttachments(false);
            // Avviata con la coda di STW in pausa: la sessione aspetta la ripresa.
            if (what === "startStw") await api.startRun("t-stw-7");
            // La coda di ACQ in pausa, poi un allarme nuovo su SRV-1 (accesso di
            // lettura usabile): l'analisi nasce e aspetta la ripresa.
            if (what === "serverWait") {
              await api.instance.pauseQueue("prj-acq");
              await api.servers.simulateServerRecovery("SRV-1").catch(() => undefined);
              await api.servers.simulateServerAlert("SRV-1", "agent_silent");
            }
            if (what === "run") {
              await api.instance.simulateBudgetReached(true);
              const a = await api.automations.createAutomation({
                name: "Classify the request",
                projectId: "prj-acq",
                flow: {
                  trigger: { kind: "manual" },
                  titleTemplate: "Classify the request",
                  steps: [
                    {
                      id: "c-classify",
                      kind: "claude",
                      instruction: "Classify the request.",
                      inputs: ["avvio.data"],
                      outcomes: ["bug", "feature"],
                      fields: [],
                      branches: {},
                    },
                  ],
                },
              });
              await api.automations.activate(a.id);
              await api.automations.startManual(a.id);
            }
          } finally {
            session.setSessionPersonId(prev);
          }
        }, action);
        await page.waitForTimeout(900);
      }
      const go = async (page, hash) => {
        await page.evaluate((h) => {
          window.location.hash = h;
        }, hash);
        await page.waitForTimeout(1200);
        await page.mouse.move(2, 2);
      };
      // La sezione Claude in cima al pannello, con le sue azioni in vista.
      const toClaude = async (page) => {
        await page.evaluate(() => {
          const section = document.querySelector("[data-claude-status]")?.closest("section");
          const scroller = section?.closest("[data-detail-panel] > .overflow-auto");
          if (section && scroller)
            scroller.scrollTop +=
              section.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
        });
        await page.waitForTimeout(300);
      };
      const SCENES = [
        // [nome, indirizzo, { persona, action, then, after }]
        ["column-queue", "/p/STW/tasks", { persona: "Roberta" }],
        ["projects-queue", "/projects", { persona: "Roberta" }],
        ["task-queue", "/p/STW/tasks?task=STW-7", { persona: "Laura", after: toClaude }],
        ["task-budget", "/p/ACQ/tasks?task=ACQ-3", { persona: "Laura", action: "budget", after: toClaude }],
        ["task-waiting", "/p/STW/tasks?task=STW-7", { persona: "Roberta", action: "startStw", after: toClaude }],
        ["server-waiting", "/home", { persona: "Roberta", action: "serverWait", then: "/p/ACQ/servers/SRV-1" }],
        ["chat-budget", "/claude/cv-giulia-callbacks", { action: "budget" }],
        ["drive-off", "/p/AUD/drive", { persona: "Laura", action: "uploadsOff" }],
        ["run-budget", "/automations", { persona: "Roberta", action: "run", then: "/automations/ACQ-A1/runs/1" }],
        ["runs-budget", "/automations", { persona: "Roberta", action: "run", then: "/automations/ACQ-A1" }],
      ];
      const variants = [
        ...["light", "dark"].flatMap((scheme) =>
          ["en", "it"].map((lang) => ({ scheme, lang, viewport: WIDE, suffix: `${scheme}-${lang}` })),
        ),
        { scheme: "dark", lang: "en", viewport: NARROW, suffix: "narrow-en" },
        { scheme: "light", lang: "it", viewport: NARROW, suffix: "narrow-it" },
      ];
      const only = process.env.CAPTURE_ONLY ? new RegExp(process.env.CAPTURE_ONLY) : null;
      for (const [name, hash, opts] of SCENES) {
        if (only && !only.test(name)) continue;
        for (const v of variants) {
          const { page, context } = await open(v.scheme, v.viewport, opts.then ? "/home" : hash, {
            lang: v.lang,
            persona: opts.persona,
          });
          if (opts.action) await asAdmin(page, opts.action);
          await go(page, opts.then ?? hash);
          if (opts.after) await opts.after(page);
          await shot(page, `a9b-effects-${name}-${v.suffix}.png`);
          await context.close();
        }
      }
      return;
    }

    // Area 9b, Task 13 (`CAPTURE_A9B_STATUS=1`): lo Stato dell'istanza (shape
    // admin-instance.md), scatti `a9b-status-*`. Lo stato si prepara dal
    // livello dati, con le azioni che un utente farebbe: «Rimetti in coda» su
    // STW-7 e «Avvia» su STW-12 con la coda di STW in pausa danno i «2
    // waiting» dello shape; un'automazione di ACQ col budget raggiunto il
    // passo fermo per budget.
    if (process.env.CAPTURE_A9B_STATUS) {
      async function prepare(page, action) {
        await page.evaluate(async (what) => {
          const api = await import("/data/api.ts");
          const session = await import("/data/session.ts");
          const store = await import("/data/store.ts");
          const viewer = await import("/data/viewer.ts");
          const prev = session.getSessionPersonId();
          session.setSessionPersonId("p-roberta");
          try {
            if (what === "waiting" || what === "budget") {
              await api.instance.retryJob("cv-run-stw-7");
              await api.startRun("t-stw-12");
            }
            if (what === "budget") {
              await api.instance.simulateBudgetReached(true);
              const a = await api.automations.createAutomation({
                name: "Triage requests",
                projectId: "prj-acq",
                flow: {
                  trigger: { kind: "manual" },
                  titleTemplate: "Triage",
                  steps: [
                    {
                      id: "c-classify",
                      kind: "claude",
                      instruction: "Classify the request.",
                      inputs: ["avvio.data"],
                      outcomes: ["bug", "feature"],
                      fields: [],
                      branches: {},
                    },
                  ],
                },
              });
              await api.automations.activate(a.id);
              await api.automations.startManual(a.id);
            }
            if (what === "sara") viewer.grantInstancePermission("p-sara", "instance.status.view");
            if (what === "error") store.failNext("instance.getInstanceStatus");
          } finally {
            session.setSessionPersonId(prev);
          }
        }, action);
        await page.waitForTimeout(600);
      }
      const go = async (page, hash) => {
        await page.evaluate((h) => {
          window.location.hash = h;
        }, hash);
        await page.waitForTimeout(1200);
        await page.mouse.move(2, 2);
      };
      const resume = async (page) => {
        await page.getByRole("button", { name: /^(Resume STW's queue|Riprendi la coda di STW)$/ }).click();
        await page.waitForTimeout(400);
      };
      const retry = async (page) => {
        await page.getByRole("button", { name: /^(Retry ACQ-3|Rimetti in coda ACQ-3)$/ }).click();
        await page.waitForTimeout(400);
      };
      // In fondo: il resto della colonna laterale (a 1024 sotto i lavori) e la frase del confine.
      const bottom = async (page) => {
        await page.getByText(/^(Stubwise only changes|Qui Stubwise cambia)/).scrollIntoViewIfNeeded();
        await page.waitForTimeout(300);
      };
      const SCENES = [
        // [nome, indirizzo, { persona, action, after }]
        ["status", "/admin/status", { persona: "Roberta", action: "waiting" }],
        ["status-bottom", "/admin/status", { persona: "Roberta", action: "waiting", after: bottom }],
        ["status-budget", "/admin/status", { persona: "Roberta", action: "budget" }],
        ["status-resume", "/admin/status", { persona: "Roberta", action: "waiting", after: resume }],
        ["status-retry", "/admin/status", { persona: "Roberta", after: retry }],
        ["status-failed", "/admin/status?status=failed", { persona: "Roberta" }],
        ["status-readonly", "/admin/status", { persona: "Sara", action: "sara" }],
        ["status-error", "/admin/status", { persona: "Roberta", action: "error" }],
      ];
      const only = process.env.CAPTURE_ONLY ? new RegExp(process.env.CAPTURE_ONLY) : null;
      const variants = [
        ...["light", "dark"].flatMap((scheme) =>
          ["en", "it"].map((lang) => ({ scheme, lang, viewport: WIDE, suffix: `${scheme}-${lang}` })),
        ),
        { scheme: "dark", lang: "en", viewport: NARROW, suffix: "narrow-en" },
        { scheme: "light", lang: "it", viewport: NARROW, suffix: "narrow-it" },
      ];
      for (const [name, hash, opts] of SCENES) {
        if (only && !only.test(name)) continue;
        for (const v of variants) {
          const { page, context } = await open(v.scheme, v.viewport, "/home", {
            lang: v.lang,
            persona: opts.persona,
          });
          if (opts.action) await prepare(page, opts.action);
          await go(page, hash);
          if (opts.after) await opts.after(page);
          await shot(page, `a9b-${name}-${v.suffix}.png`);
          await context.close();
        }
      }
      return;
    }

    // Area 9b, Task 12 (`CAPTURE_A9B_ESTATE=1`): Servers e Repositories
    // dell'Amministrazione (shape admin-instance.md), scatti `a9b-servers-*` e
    // `a9b-repos-*`. Lo stato si prepara dal livello dati.
    if (process.env.CAPTURE_A9B_ESTATE) {
      async function prepare(page, action) {
        await page.evaluate(async (what) => {
          const api = await import("/data/api.ts");
          const session = await import("/data/session.ts");
          const store = await import("/data/store.ts");
          const viewer = await import("/data/viewer.ts");
          const prev = session.getSessionPersonId();
          session.setSessionPersonId("p-roberta");
          try {
            if (what === "orphan") {
              await api.servers.createServer({ name: "edge-01", environmentId: null });
            }
            if (what === "sara") viewer.grantInstancePermission("p-sara", "monitor.manage");
            if (what === "manyRepos") {
              for (let i = 1; i <= 6; i++)
                store.state.repositories.push({
                  id: `repo-acq-extra-${i}`,
                  projectId: "prj-acq",
                  name: `servizio-${i}`,
                  fullName: `colline/servizio-${i}`,
                  gitAccountId: null,
                });
            }
          } finally {
            session.setSessionPersonId(prev);
          }
        }, action);
        await page.waitForTimeout(400);
      }
      const go = async (page, hash) => {
        await page.evaluate((h) => {
          window.location.hash = h;
        }, hash);
        await page.waitForTimeout(1200);
        await page.mouse.move(2, 2);
      };
      const newServer = async (page) => {
        await page.getByRole("button", { name: /^(New server|Nuovo server)$/ }).click();
        await page.getByLabel(/^(Name|Nome)$/).fill("edge-02");
        await page.waitForTimeout(300);
      };
      const created = async (page) => {
        await newServer(page);
        await page.getByRole("button", { name: /^(Create server|Crea il server)$/ }).click();
        await page.waitForTimeout(500);
      };
      const find = async (page) => {
        await page.getByRole("searchbox").fill("audin");
        await page.waitForTimeout(300);
      };
      const SCENES = [
        // [nome, indirizzo, { persona, action, after }]
        ["servers", "/admin/servers", { persona: "Roberta", action: "orphan" }],
        ["servers-hidden", "/admin/servers", { persona: "Sara", action: "sara" }],
        ["servers-new", "/admin/servers", { persona: "Roberta", after: newServer }],
        ["servers-key", "/admin/servers", { persona: "Roberta", after: created }],
        ["servers-30d", "/admin/servers/SRV-2?range=30d", { persona: "Roberta" }],
        ["servers-90d", "/admin/servers/SRV-1?range=90d", { persona: "Roberta" }],
        ["servers-orphan", "/admin/servers/SRV-5", { persona: "Roberta", action: "orphan" }],
        ["repos", "/admin/repositories", { persona: "Roberta" }],
        ["repos-find", "/admin/repositories", { persona: "Roberta", action: "manyRepos", after: find }],
      ];
      const only = process.env.CAPTURE_ONLY ? new RegExp(process.env.CAPTURE_ONLY) : null;
      const variants = [
        ...["light", "dark"].flatMap((scheme) =>
          ["en", "it"].map((lang) => ({ scheme, lang, viewport: WIDE, suffix: `${scheme}-${lang}` })),
        ),
        { scheme: "dark", lang: "en", viewport: NARROW, suffix: "narrow-en" },
        { scheme: "light", lang: "it", viewport: NARROW, suffix: "narrow-it" },
      ];
      for (const [name, hash, opts] of SCENES) {
        if (only && !only.test(name)) continue;
        for (const v of variants) {
          const { page, context } = await open(v.scheme, v.viewport, "/home", {
            lang: v.lang,
            persona: opts.persona,
          });
          if (opts.action) await prepare(page, opts.action);
          await go(page, hash);
          if (opts.after) await opts.after(page);
          await shot(page, `a9b-${name}-${v.suffix}.png`);
          await context.close();
        }
      }
      return;
    }

    // Area 9b, Task 11 (`CAPTURE_A9B_GSW=1`): Google Workspace, Storage e
    // Outgoing webhooks (shape admin-integrations.md), scatti `a9b-google-*`,
    // `a9b-storage-*` e `a9b-webhook-*`. Lo stato si prepara dal livello dati.
    if (process.env.CAPTURE_A9B_GSW) {
      async function prepare(page, action) {
        await page.evaluate(async (what) => {
          const api = await import("/data/api.ts");
          const session = await import("/data/session.ts");
          const prev = session.getSessionPersonId();
          session.setSessionPersonId("p-roberta");
          try {
            if (what === "storageFailed") {
              await api.instance.simulateNextTest("storage", "unreachable");
              await api.instance.testStorage();
            }
            if (what === "attachmentsOff") await api.instance.setAttachments(false);
            if (what === "webhookFailed") {
              await api.instance.simulateNextTest("webhook", "invalid_credentials");
              await api.instance.testWebhook();
            }
          } finally {
            session.setSessionPersonId(prev);
          }
        }, action);
        await page.waitForTimeout(600);
      }
      const go = async (page, hash) => {
        await page.evaluate((h) => {
          window.location.hash = h;
        }, hash);
        await page.waitForTimeout(1200);
        await page.mouse.move(2, 2);
      };
      const menu = async (page, name, item) => {
        await page.getByRole("button", { name: new RegExp(`^(More for|Altro per) ${name}$`) }).click();
        await page.getByRole("menuitem", { name: item }).click();
        await page.waitForTimeout(300);
      };
      const addApp = async (page) => {
        await page.getByRole("button", { name: /^(Add an app|Aggiungi un'app)$/ }).click();
        await page.getByLabel(/^(Name|Nome)$/).fill("Audin Workspace");
        const domains = page.getByLabel(/^(Email domains|Domini email)$/);
        await domains.fill("audin.it,");
        await domains.fill("audin.com,");
        await page.getByLabel(/^Client ID$/).fill("1234-audin.apps.googleusercontent.com");
        await page.getByLabel(/^Client secret$/).fill("GOCSPX-prototype-7d1e");
        await page.getByRole("button", { name: /^(How to set it up in Google Cloud|Come impostarla su Google Cloud)$/ }).click();
        await page.waitForTimeout(300);
      };
      const replaceKey = async (page) => {
        await page.getByRole("button", { name: /^(Replace|Sostituisci)$/ }).click();
        await page.getByLabel(/^Secret access key$/).fill("s3-prototype-secret-k4q2");
        await page.mouse.move(2, 2);
        await page.waitForTimeout(300);
      };
      const turnOff = async (page) => {
        await page.getByRole("switch", { name: /^(Attachments|Allegati)$/ }).click();
        await page.waitForTimeout(300);
      };
      const jsonPreview = async (page) => {
        await page.getByRole("radio", { name: /^(Generic JSON|JSON generico)$/ }).click();
        await page.getByText(/^(Claude's work failed|Il lavoro di Claude non è riuscito)$/).hover();
        await page.waitForTimeout(300);
      };
      const howTo = async (page) => {
        await page.getByRole("button", { name: /^(How to get the address|Come ottenere l'indirizzo)$/ }).click();
        await page.waitForTimeout(300);
      };
      const showPreview = async (page) => {
        const toggle = page.getByRole("button", { name: /^(Show preview|Mostra l'anteprima)$/ });
        if (await toggle.isVisible()) await toggle.click();
        await page.getByRole("region", { name: /^(Preview|Anteprima)$/ }).scrollIntoViewIfNeeded();
        await page.waitForTimeout(300);
      };
      const SCENES = [
        // [nome, indirizzo, { persona, action, after }]
        ["google", "/admin/google", { persona: "Roberta" }],
        ["google-add", "/admin/google", { persona: "Roberta", after: addApp }],
        ["google-inuse", "/admin/google", { persona: "Roberta", after: (p) => menu(p, "Example", /^(Delete…|Elimina…)$/) }],
        ["storage", "/admin/storage", { persona: "Roberta" }],
        ["storage-replace", "/admin/storage", { persona: "Roberta", after: replaceKey }],
        ["storage-failed", "/admin/storage", { persona: "Roberta", action: "storageFailed" }],
        ["storage-turnoff", "/admin/storage", { persona: "Roberta", after: turnOff }],
        ["storage-off", "/admin/storage", { persona: "Roberta", action: "attachmentsOff" }],
        ["webhook", "/admin/webhooks", { persona: "Roberta" }],
        ["webhook-json", "/admin/webhooks", { persona: "Roberta", after: jsonPreview }],
        ["webhook-howto", "/admin/webhooks", { persona: "Roberta", after: howTo }],
        ["webhook-failed", "/admin/webhooks", { persona: "Roberta", action: "webhookFailed" }],
        ["webhook-preview", "/admin/webhooks", { persona: "Roberta", after: showPreview }],
      ];
      const only = process.env.CAPTURE_ONLY ? new RegExp(process.env.CAPTURE_ONLY) : null;
      const variants = [
        ...["light", "dark"].flatMap((scheme) =>
          ["en", "it"].map((lang) => ({ scheme, lang, viewport: WIDE, suffix: `${scheme}-${lang}` })),
        ),
        { scheme: "dark", lang: "en", viewport: NARROW, suffix: "narrow-en" },
        { scheme: "light", lang: "it", viewport: NARROW, suffix: "narrow-it" },
      ];
      for (const [name, hash, opts] of SCENES) {
        if (only && !only.test(name)) continue;
        for (const v of variants) {
          const { page, context } = await open(v.scheme, v.viewport, "/home", {
            lang: v.lang,
            persona: opts.persona,
          });
          if (opts.action) await prepare(page, opts.action);
          await go(page, hash);
          if (opts.after) await opts.after(page);
          await shot(page, `a9b-${name}-${v.suffix}.png`);
          await context.close();
        }
      }
      return;
    }

    // Area 9b, Task 10 (`CAPTURE_A9B_INTEG=1`): Git accounts e Plugins
    // (shape admin-integrations.md), scatti `a9b-git-*` e `a9b-plugins-*`.
    // Lo stato si prepara dal livello dati della pagina.
    if (process.env.CAPTURE_A9B_INTEG) {
      async function prepare(page, action) {
        await page.evaluate(async (what) => {
          const api = await import("/data/api.ts");
          const viewer = await import("/data/viewer.ts");
          const session = await import("/data/session.ts");
          const reauth = await import("/data/auth/reauth.ts");
          const prev = session.getSessionPersonId();
          session.setSessionPersonId("p-roberta");
          reauth.markReauthenticated("p-roberta");
          try {
            if (what === "saraManages") viewer.grantInstancePermission("p-sara", "git_accounts.manage");
            if (what === "secondGithub")
              await api.instance.createGitAccount({
                name: "GitHub Release",
                provider: "github",
                workspace: null,
                token: "ghp_prototype-release-5c1d",
              });
          } finally {
            session.setSessionPersonId(prev);
          }
        }, action);
        await page.waitForTimeout(600);
      }
      const go = async (page, hash) => {
        await page.evaluate((h) => {
          window.location.hash = h;
        }, hash);
        await page.waitForTimeout(1200);
        await page.mouse.move(2, 2);
      };
      const menu = async (page, name, item) => {
        await page.getByRole("button", { name: new RegExp(`^(More for|Altro per) ${name}$`) }).click();
        await page.getByRole("menuitem", { name: item }).click();
        await page.waitForTimeout(300);
      };
      const newAccount = async (page) => {
        await page.getByRole("button", { name: /^(New account|Nuovo account)$/ }).click();
        await page.getByLabel(/^(Name|Nome)$/).fill("Bitbucket Clienti");
        await page.getByLabel(/^Workspace$/).fill("audin-clienti");
        await page.getByLabel(/^Token$/).fill("bb-prototype-token-9f2c");
        await page.waitForTimeout(300);
      };
      const register = async (page) => {
        await page.getByRole("button", { name: /^(Register plugin|Registra plugin)$/ }).click();
        await page.getByLabel(/^(Repository address|Indirizzo del repository)$/).fill("https://github.com/acme/review-kit");
        await page.getByLabel(/^Ref$/).fill("v1.2.0");
        await page.waitForTimeout(300);
      };
      // Registrato dal dialogo (riconferma già fatta in `prepare`): la riga
      // «Materializing…» prima del passo di 800 ms.
      const materializing = async (page) => {
        await register(page);
        await page.getByRole("checkbox").check();
        await page.getByRole("button", { name: /^(Register|Registra)$/ }).click();
        await page.getByText(/^(Materializing…|In preparazione…)$/).waitFor();
        await page.mouse.move(2, 2);
        await page.waitForTimeout(150);
      };
      const update = async (page) => {
        await page.getByRole("button", { name: /^(Update to ref…|Aggiorna a un ref…)$/ }).click();
        await page.getByLabel(/^Ref$/).fill("v4.1.0");
        await page.getByRole("checkbox").check();
        await page.waitForTimeout(300);
      };
      const SCENES = [
        // [nome, indirizzo, { persona, action, after }]
        ["git", "/admin/git-accounts", { persona: "Roberta" }],
        ["git-readonly", "/admin/git-accounts", { persona: "Marco" }],
        ["git-new", "/admin/git-accounts", { persona: "Roberta", after: newAccount }],
        ["git-reviewer", "/admin/git-accounts", { persona: "Roberta", action: "secondGithub", after: (p) => menu(p, "GitHub Release", /^(Make default reviewer|Rendi revisore predefinito)$/) }],
        ["git-inuse", "/admin/git-accounts", { persona: "Sara", action: "saraManages", after: (p) => menu(p, "Bitbucket Audin", /^(Delete…|Elimina…)$/) }],
        ["plugins", "/admin/plugins", { persona: "Roberta" }],
        ["plugins-register", "/admin/plugins", { persona: "Roberta", after: register }],
        ["plugins-materializing", "/admin/plugins", { persona: "Roberta", action: "reauth", after: materializing }],
        ["plugins-page", "/admin/plugins/plg-superpowers", { persona: "Roberta" }],
        ["plugins-failed", "/admin/plugins/plg-lint-helpers", { persona: "Roberta" }],
        ["plugins-update", "/admin/plugins/plg-superpowers", { persona: "Roberta", after: update }],
      ];
      const integOnly = process.env.CAPTURE_ONLY ? new RegExp(process.env.CAPTURE_ONLY) : null;
      const variants = [
        ...["light", "dark"].flatMap((scheme) =>
          ["en", "it"].map((lang) => ({ scheme, lang, viewport: WIDE, suffix: `${scheme}-${lang}` })),
        ),
        { scheme: "dark", lang: "en", viewport: NARROW, suffix: "narrow-en" },
        { scheme: "light", lang: "it", viewport: NARROW, suffix: "narrow-it" },
      ];
      for (const [name, hash, opts] of SCENES) {
        if (integOnly && !integOnly.test(name)) continue;
        for (const v of variants) {
          const { page, context } = await open(v.scheme, v.viewport, "/home", {
            lang: v.lang,
            persona: opts.persona,
          });
          if (opts.action) await prepare(page, opts.action);
          await go(page, hash);
          if (opts.after) await opts.after(page);
          await shot(page, `a9b-${name}-${v.suffix}.png`);
          await context.close();
        }
      }
      return;
    }

    // Area 9b, Task 8 (`CAPTURE_A9B_AI=1`): la voce AI dell'Amministrazione
    // (shape admin-ai.md). Lo stato si prepara dal livello dati della pagina.
    if (process.env.CAPTURE_A9B_AI) {
      async function prepare(page, action) {
        await page.evaluate(async (what) => {
          const api = await import("/data/api.ts");
          const viewer = await import("/data/viewer.ts");
          const session = await import("/data/session.ts");
          const prev = session.getSessionPersonId();
          session.setSessionPersonId("p-roberta");
          try {
            if (what === "budget") await api.instance.simulateBudgetReached(true);
            if (what === "readOnly") viewer.grantInstancePermission("p-marco", "settings.manage");
            if (what === "usageView") viewer.grantInstancePermission("p-sara", "usage.view");
          } finally {
            session.setSessionPersonId(prev);
          }
        }, action);
        await page.waitForTimeout(600);
      }
      const go = async (page, hash) => {
        await page.evaluate((h) => {
          window.location.hash = h;
        }, hash);
        await page.waitForTimeout(1200);
        await page.mouse.move(2, 2);
      };
      const addDialog = async (page) => {
        await page.getByRole("button", { name: /^(Add account|Aggiungi account)$/ }).click();
        await page.getByLabel(/^(Name|Nome)$/).fill("Team Max 2");
        await page.getByLabel(/^Token$/).fill("sk-ant-oat01-prototype-7f3a");
        await page.waitForTimeout(300);
      };
      // Usage (Task 9): il passaggio su una colonna, i figli aperti, la tabella dei giorni.
      const usageHover = async (page) => {
        const col = page.locator("[data-day]").nth(-3);
        await col.hover();
        await page.waitForTimeout(200);
      };
      const usageOpen = async (page) => {
        const table = page.getByRole("table").last();
        await table.getByRole("button").first().click();
        await table.getByRole("button").nth(1).click();
        await page.waitForTimeout(200);
      };
      const usageTable = async (page) => {
        await page.getByRole("button", { name: /^(Show as table|Mostra come tabella)$/ }).click();
        await page.waitForTimeout(200);
        await page.getByRole("button", { name: /^(Hide the table|Nascondi la tabella)$/ }).scrollIntoViewIfNeeded();
      };
      const usageOther = async (page) => {
        await page.getByText(/^(Other projects|Altri progetti)$/).scrollIntoViewIfNeeded();
        await page.waitForTimeout(200);
      };
      const SCENES = [
        // [nome, indirizzo, { persona, action, after }]
        ["providers","/admin/ai?tab=providers", { persona: "Roberta" }],
        ["providers-readonly", "/admin/ai?tab=providers", { persona: "Marco", action: "readOnly" }],
        ["add", "/admin/ai?tab=providers", { persona: "Roberta", after: addDialog }],
        ["models", "/admin/ai?tab=models", { persona: "Roberta" }],
        ["automation", "/admin/ai?tab=automation", { persona: "Roberta" }],
        ["budget", "/admin/ai?tab=budget", { persona: "Roberta" }],
        ["budget-reached", "/admin/ai?tab=budget", { persona: "Roberta", action: "budget" }],
        ["usage", "/admin/ai?tab=usage", { persona: "Roberta", after: usageHover }],
        ["usage-then", "/admin/ai?tab=usage&range=month&group=model&then=operation", { persona: "Roberta", after: usageOpen }],
        ["usage-custom", "/admin/ai?tab=usage&range=custom&from=2026-10-01&to=2026-10-14", { persona: "Roberta", after: usageTable }],
        ["usage-other", "/admin/ai?tab=usage&range=90d", { persona: "Sara", action: "usageView" }],
        ["usage-other-table", "/admin/ai?tab=usage&range=90d", { persona: "Sara", action: "usageView", after: usageOther }],
      ];
      const aiOnly = process.env.CAPTURE_ONLY ? new RegExp(process.env.CAPTURE_ONLY) : null;
      const variants = [
        ...["light", "dark"].flatMap((scheme) =>
          ["en", "it"].map((lang) => ({ scheme, lang, viewport: WIDE, suffix: `${scheme}-${lang}` })),
        ),
        { scheme: "dark", lang: "en", viewport: NARROW, suffix: "narrow-en" },
        { scheme: "light", lang: "it", viewport: NARROW, suffix: "narrow-it" },
      ];
      for (const [name, hash, opts] of SCENES) {
        if (aiOnly && !aiOnly.test(name)) continue;
        for (const v of variants) {
          const { page, context } = await open(v.scheme, v.viewport, "/home", {
            lang: v.lang,
            persona: opts.persona,
          });
          if (opts.action) await prepare(page, opts.action);
          await go(page, hash);
          if (opts.after) await opts.after(page);
          await shot(page, `a9b-ai-${name}-${v.suffix}.png`);
          await context.close();
        }
      }
      return;
    }

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
      ["releases-settings", "/p/AUD/settings/repositories", { persona: "Laura", steps: async (p) => {
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
        await p.getByLabel(/^(Invite or reset link|Link d'invito o di reset)$/).fill(link.trim());
        await p.getByLabel(/^(Invite or reset link|Link d'invito o di reset)$/).press("Enter");
        await p.getByRole("heading", { level: 1, name: /^(Choose a new password|Scegli una password nuova)$/ }).waitFor();
        await p.mouse.move(2, 2);
        await p.waitForTimeout(400);
      }],
      ["reset-invalid", async (p) => {
        await signOut(p);
        await p.getByLabel(/^(Invite or reset link|Link d'invito o di reset)$/).fill("made-up-link");
        await p.getByLabel(/^(Invite or reset link|Link d'invito o di reset)$/).press("Enter");
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

    // Area 9a, Task 9: Departments (elenco e pannello del reparto) e Roles
    // (elenco e pagina di un ruolo con la barra di salvataggio). Ogni scena a
    // 1440 e 1024, chiaro e scuro, en e it.
    const AREA9A_DEPTS_ROLES = [
      ["departments", "list", "Roberta", "/admin/departments", null],
      ["departments", "panel", "Roberta", "/admin/departments?department=dep-development", async (p) => {
        await p.locator("[data-detail-panel]").waitFor();
      }],
      ["roles", "list", "Roberta", "/admin/roles", null],
      ["roles", "editor", "Roberta", "/admin/roles/role-rm-1", async (p) => {
        await p.getByText(/^(Request corrections|Chiedere correzioni)$/).click();
        await p.getByRole("button", { name: /^(Save role|Salva il ruolo)$/ }).waitFor();
        // La testata in vista: il clic sulla casella aveva fatto scorrere l'area.
        await p.evaluate(() => {
          for (const el of document.querySelectorAll("*")) if (el.scrollTop > 0) el.scrollTop = 0;
        });
      }],
    ];
    for (const [area, name, persona, hash, steps] of AREA9A_DEPTS_ROLES) {
      const scene = `a9a-admin-${area}-${name}`;
      if (only && !only.test(scene)) continue;
      const variants = [];
      for (const [viewport, size] of [[WIDE, ""], [NARROW, "-narrow"]]) {
        for (const scheme of ["light", "dark"]) {
          for (const lang of ["en", "it"]) variants.push([scheme, lang, viewport, `${scene}${size}-${scheme}-${lang}.png`]);
        }
      }
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

    // Area 9a, Task 10: Progetto → Settings con le sezioni nella colonna, e
    // Members (shape admin-roles-members.md): l'elenco, il pannello in
    // modifica (Laura toglie a Marco un permesso che lei non ha), in sola
    // lettura (Marco), e il rifiuto in parole (Laura non può dare a Federico
    // un permesso che non ha). Ogni scena a 1440 e 1024, chiaro e scuro, en e it.
    const opsRow = (p) => p.locator("[data-detail-panel] li[title='servers.operate']");
    const AREA9A_MEMBERS = [
      ["members-list", "Laura", "/p/ACQ/settings/members", null],
      ["members-edit", "Laura", "/p/ACQ/settings/members?member=p-marco", async (p) => {
        await opsRow(p).waitFor();
        await opsRow(p).locator("label").click();
        await p.getByRole("button", { name: /^(Save|Salva)$/ }).waitFor();
      }],
      ["members-readonly", "Marco", "/p/ACQ/settings/members?member=p-federico", async (p) => {
        await opsRow(p).waitFor();
      }],
      ["members-refusal", "Laura", "/p/ACQ/settings/members?member=p-federico", async (p) => {
        await opsRow(p).waitFor();
        await opsRow(p).scrollIntoViewIfNeeded();
      }],
      ["settings-nav-statuses", "Laura", "/p/ACQ/settings", null],
      ["settings-nav-repositories", "Laura", "/p/AUD/settings/repositories", null],
    ];
    for (const [name, persona, hash, steps] of AREA9A_MEMBERS) {
      const scene = `a9a-${name}`;
      if (only && !only.test(scene)) continue;
      const variants = [];
      for (const [viewport, size] of [[WIDE, ""], [NARROW, "-narrow"]]) {
        for (const scheme of ["light", "dark"]) {
          for (const lang of ["en", "it"]) variants.push([scheme, lang, viewport, `${scene}${size}-${scheme}-${lang}.png`]);
        }
      }
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

    // Area 9a, Task 11: il registro delle modifiche (Amministrazione, con
    // «Show details» aperto; Settings del progetto), «Who can?» da un'azione,
    // da una persona e per Claude, e il riquadro «Who?» accanto a un bottone
    // spento (Sara sulle Settings di ACQ). Ogni scena a 1440 e 1024, chiaro e
    // scuro, en e it.
    // Task 12: l'istanza vuota, il primo admin, «Who can» con un'azione di progetto.
    const toEmptyWhoCan = async (p) => {
      await p.getByRole("button", { name: /^(Profile and settings|Profilo e impostazioni)/ }).click();
      await p.getByRole("button", { name: /^(Reset to empty instance|Svuota l'istanza)$/ }).click();
      await p.getByRole("button", { name: /^(Reset — sure\?|Ripristina — sicuro\?)$/ }).last().click();
      await p.getByLabel(/^(Your name|Il tuo nome)$/).fill("Ada Prima");
      await p.getByLabel(/^Email$/).fill("ada@example.com");
      await p.getByLabel(/^Password$/).fill("a-long-one");
      await p.getByLabel(/^(Confirm password|Conferma la password)$/).fill("a-long-one");
      await p.getByRole("button", { name: /^(Create the admin account|Crea l'account amministratore)$/ }).click();
      await p.getByRole("heading", { level: 1, name: "Home" }).waitFor();
      // Il messaggio del primo avvio non è parte della scena: si chiude.
      await p.getByRole("button", { name: /^(Dismiss|Chiudi)$/ }).click();
      await p.evaluate(() => {
        window.location.hash = "/admin/who-can?action=approvePlan";
      });
      await p.getByText(/^(No projects you can see yet\.|Ancora nessun progetto che vedi\.)$/).waitFor();
    };
    const AREA9A_AUDIT = [
      ["changelog", "Roberta", "/admin/changelog", async (p) => {
        await p.locator("[data-change-entry]").first().waitFor();
        await p.getByRole("button", { name: /^(Show details|Mostra i dettagli)$/ }).first().click();
      }],
      ["changelog-project", "Laura", "/p/ACQ/settings/changelog", async (p) => {
        await p.locator("[data-change-entry]").first().waitFor();
      }],
      ["whocan-action", "Roberta", "/admin/who-can?action=approvePlan&project=ACQ", async (p) => {
        await p.locator("[data-who-row]").first().waitFor();
      }],
      ["whocan-person", "Roberta", "/admin/who-can?view=what&person=p-marco&project=ACQ", async (p) => {
        await p.locator("[data-permission]").first().waitFor();
      }],
      ["whocan-claude", "Roberta", "/admin/who-can?view=what&person=p-claude&project=ACQ", async (p) => {
        await p.locator("[data-permission]").first().waitFor();
      }],
      // Task 12: l'istanza vuota. Si svuota, si crea il primo full admin e si
      // chiede chi può approvare un piano: nessun progetto da scegliere.
      ["whocan-empty", "Roberta", "/home", toEmptyWhoCan],
      // Giro 1: lo stesso, col menu dei progetti aperto a mano (dice la stessa frase).
      ["whocan-empty-menu", "Roberta", "/home", async (p) => {
        await toEmptyWhoCan(p);
        await p.getByRole("button", { name: /^(Project|Progetto): / }).click();
        await p.getByRole("listbox").waitFor();
      }],
      ["who-popover", "Sara", "/p/ACQ/settings/statuses", async (p) => {
        await p.locator("[data-who-can]").first().click();
        await p.locator("[data-who-can-popover] [data-who-row]").first().waitFor();
      }],
    ];
    for (const [name, persona, hash, steps] of AREA9A_AUDIT) {
      const scene = `a9a-audit-${name}`;
      if (only && !only.test(scene)) continue;
      const variants = [];
      for (const [viewport, size] of [[WIDE, ""], [NARROW, "-narrow"]]) {
        for (const scheme of ["light", "dark"]) {
          for (const lang of ["en", "it"]) variants.push([scheme, lang, viewport, `${scene}${size}-${scheme}-${lang}.png`]);
        }
      }
      for (const [scheme, lang, viewport, file] of variants) {
        const { page, context } = await open(scheme, viewport, hash, { lang, persona, viaHome: true });
        await page.getByRole("heading", { level: 1 }).first().waitFor();
        await page.waitForTimeout(300);
        await page.mouse.move(2, 2);
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
