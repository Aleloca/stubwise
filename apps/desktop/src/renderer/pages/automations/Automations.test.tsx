import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { automations as automationsApi, failNext, resetApi, setLatency } from "../../data/api";
import { TODAY } from "../../data/dates";
import { state } from "../../data/store";
import type { AutomationRun, RunLogEntry } from "../../data/types";
import { grantProjectRole, resetViewerGrants, revokeProjectPermission } from "../../data/viewer";
import { DOCKED_PANEL_QUERY } from "../../layout/useDetailPanel";
import { clearToasts } from "../../tasks-ui/Toast";
import { renderRoute } from "../../test/renderRoute";
import { setMatchMedia } from "../../test/setup";
import { clearPendingAnswers, setUndoWindow } from "../home/pendingAnswers";

// Le pagine delle Automations (Task 5, shape automations.md e
// automation-sources.md): elenco, automazione, esecuzione col registro,
// sorgenti e tabella cliente → progetto. Persone del seme: Roberta (admin,
// vede tutto e gestisce le integrazioni), Matteo (proprietario di AUT-1 e
// AUD-A1, approva l'email di AUD-A1 #1), Laura (Project Lead, niente
// automazioni generali né sorgenti), Giulia (resa Viewer di AUD nei test).

const ROBERTA = "p-roberta";
const MATTEO = "p-matteo";
const LAURA = "p-laura";
const GIULIA = "p-giulia";

async function open(path: string, personId = ROBERTA) {
  const router = renderRoute(path, personId);
  await screen.findByRole("heading", { level: 1 });
  return router;
}

async function switchPersona(name: RegExp) {
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Profile and settings" }));
  const menu = await screen.findByRole("dialog", { name: "Profile and settings" });
  await user.click(within(menu).getByRole("radio", { name }));
}

const idle = () => act(() => automationsApi.whenAutomationsIdle());

beforeEach(() => {
  setLatency(0);
  resetApi();
  setMatchMedia(DOCKED_PANEL_QUERY, true);
  // Le decisioni (approva, scegli) partono dopo l'«Undo»: qui subito.
  setUndoWindow(0);
  try {
    window.localStorage.clear();
  } catch {
    // niente storage
  }
});
afterEach(() => {
  resetViewerGrants();
  clearToasts();
  clearPendingAnswers();
  setUndoWindow(null);
});

describe("elenco", () => {
  it("raggruppato per progetto (GENERAL in testa), righe con stato in parola, inizio e problemi", async () => {
    await open("/automations");
    expect(
      await screen.findByRole("heading", { level: 1, name: "Automations" }),
    ).toBeInTheDocument();
    const list = await screen.findByRole("region", { name: "Automations by project" });
    const groups = within(list).getAllByRole("region");
    expect(groups.map((g) => g.getAttribute("aria-label"))).toEqual([
      "General",
      "AUD · Audin 2.0",
      expect.stringMatching(/^BTG · /),
      "STW · Stubwise",
    ]);
    const aut1 = list.querySelector<HTMLElement>('[data-automation-row="AUT-1"]')!;
    expect(aut1).toHaveAccessibleName(
      "AUT-1, Nuovo contratto, Active, owner Matteo Conti, 1 running",
    );
    expect(aut1).toHaveTextContent("When a deal is won on Audin");
    expect(aut1).toHaveTextContent("draft of v2");
    const draft = list.querySelector<HTMLElement>('[data-automation-row="STW-A1"]')!;
    expect(draft).toHaveTextContent("Draft");
    expect(draft).toHaveTextContent("When a request arrives in STW");
    expect(list.querySelector('[data-automation-row="BTG-A1"]')).toHaveTextContent(
      "Every Monday at 9:00",
    );
  });

  it("i filtri stanno nell'indirizzo; nessun risultato → «Clear filters»", async () => {
    const router = await open("/automations?status=draft");
    const list = await screen.findByRole("region", { name: "Automations by project" });
    expect(list.querySelectorAll("[data-automation-row]")).toHaveLength(1);
    await userEvent.click(screen.getByRole("button", { name: /^Owner/ }));
    await userEvent.click(screen.getByRole("menuitemradio", { name: "Matteo Conti" }));
    expect(await screen.findByText("No automations match these filters")).toBeInTheDocument();
    expect(router.state.location.search).toMatchObject({ status: "draft", owner: MATTEO });
    await userEvent.click(screen.getAllByRole("button", { name: "Clear filters" })[0]!);
    await waitFor(() => expect(document.querySelectorAll("[data-automation-row]").length).toBe(4));
  });

  it("la colonna: viste, Sources e progetti solo con i permessi giusti", async () => {
    await open("/automations");
    const column = screen.getByRole("navigation", { name: "Automations views" });
    expect(within(column).getByRole("link", { name: /All automations/ })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(within(column).getByRole("link", { name: /Sources/ })).toBeInTheDocument();
    expect(within(column).getByRole("link", { name: /General/ })).toBeInTheDocument();
    expect(within(column).getByRole("button", { name: "New automation" })).toBeInTheDocument();
  });

  it("Laura (niente permesso d'istanza): niente generali, niente Sources", async () => {
    await open("/automations", LAURA);
    const column = screen.getByRole("navigation", { name: "Automations views" });
    expect(within(column).queryByRole("link", { name: /Sources/ })).toBeNull();
    expect(within(column).queryByRole("link", { name: /^General/ })).toBeNull();
    expect(document.querySelector('[data-automation-row="AUT-1"]')).toBeNull();
  });

  it("caricamento, errore con «Retry», vuoto con i due modelli o con la sola frase", async () => {
    setLatency(400);
    renderRoute("/automations", ROBERTA);
    expect(
      await screen.findByRole("heading", { level: 1, name: "Automations" }),
    ).toBeInTheDocument();
    expect(document.querySelector('[aria-busy="true"]')).not.toBeNull();
  });

  it("errore di lettura: messaggio e «Retry» che ricarica", async () => {
    failNext("automations.listAutomations");
    await open("/automations");
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Couldn't load the automations");
    await userEvent.click(within(alert).getByRole("button", { name: "Retry" }));
    expect(
      await screen.findByRole("region", { name: "Automations by project" }),
    ).toBeInTheDocument();
  });

  it("vuoto: con il permesso i due modelli, senza la frase", async () => {
    state.automations = [];
    state.automationRuns = [];
    await open("/automations");
    expect(await screen.findByText("Start from a template")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Use template" })).toHaveLength(2);
    expect(screen.getByText("New contract → tasks for every department")).toBeInTheDocument();
  });

  it("vuoto senza permesso: «No automations you can see.», nessun «New automation»", async () => {
    state.automations = [];
    state.automationRuns = [];
    // Sara è Contributor ovunque: nessun `automations.manage`.
    await open("/automations", "p-sara");
    expect(await screen.findByText("No automations you can see.")).toBeInTheDocument();
    expect(
      screen.getByText("People who manage automations in your projects will create them here."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /New automation/ })).toBeNull();
    expect(screen.queryByText("Start from a template")).toBeNull();
  });

  it("«Needs attention»: le esecuzioni fallite di ciò che gestisco", async () => {
    await open("/automations?view=attention");
    expect(
      await screen.findByRole("heading", { level: 1, name: "Needs attention" }),
    ).toBeInTheDocument();
    expect(
      await screen.findByRole("link", { name: /^BTG-A1 #1, Report settimanale/ }),
    ).toBeInTheDocument();
  });

  it("«Runs in progress»: prima quelle che aspettano me (punto pieno), poi le altre", async () => {
    await open("/automations?view=runs", MATTEO);
    const rows = await waitFor(() => {
      const r = [...document.querySelectorAll<HTMLElement>("[data-run-row]")];
      expect(r.length).toBe(3);
      return r;
    });
    // Matteo decide su AUD-A1 #1 (approvazione) e AUT-1 #2 (progetto): in testa.
    expect(
      rows
        .slice(0, 2)
        .map((r) => r.dataset.runRow)
        .sort(),
    ).toEqual(["AUD-A1 #1", "AUT-1 #2"]);
    expect(rows[2]!.dataset.runRow).toBe("AUD-A1 #2");
    expect(rows[0]).toHaveAccessibleName(/Waiting for/);
    // Il binario porta il punto «ti aspetta».
    expect(screen.getByRole("link", { name: "Automations" })).toHaveAccessibleDescription(
      "2 decisions waiting for you",
    );
  });
});

describe("dettaglio di un'automazione", () => {
  it("testata in prosa, azioni per stato, esecuzioni prima di «How it works», versioni", async () => {
    await open("/automations/AUT-1");
    expect(
      await screen.findByRole("heading", { level: 1, name: "Nuovo contratto" }),
    ).toBeInTheDocument();
    expect(document.querySelector("[data-status-line]")).toHaveTextContent(
      /Active\s*· version 1 · runs as Matteo Conti since/,
    );
    expect(screen.getByRole("button", { name: "Pause" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open draft" })).toHaveAttribute(
      "href",
      "/automations/AUT-1/edit",
    );
    expect(screen.getByRole("button", { name: "Publish v2" })).toBeInTheDocument();
    const headings = screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent);
    expect(headings.indexOf("Runs2")).toBeLessThan(headings.indexOf("How it works"));
    // Riassunto: rami con l'etichetta, gettoni dei dati con la chiave nel tooltip.
    const how = document.querySelector("[data-flow-summary]")!;
    expect(how).toHaveTextContent("When a deal is won on Audin");
    expect(how).toHaveTextContent("Brings: ID trattativa");
    expect(how.querySelector('[data-token="cliente.email"]')).toHaveTextContent(
      "Email del cliente",
    );
    expect(how).toHaveTextContent("Needs approval · the owner (Matteo Conti)");
    // Versioni: v2 bozza, v1 corrente.
    expect(screen.getByText(/^v2 · draft$/)).toBeInTheDocument();
    expect(
      screen.getByText(/^v1 · published by Matteo Conti · .* · current · 1 running$/),
    ).toBeInTheDocument();
  });

  it("pubblicare dice il cambio di proprietario e le esecuzioni che restano sulla versione vecchia", async () => {
    await open("/automations/AUT-1");
    await userEvent.click(await screen.findByRole("button", { name: "Publish v2" }));
    const dialog = await screen.findByRole("dialog", { name: "Publish version 2 of AUT-1?" });
    expect(dialog).toHaveTextContent("From now on it acts with your permissions and your mailbox.");
    expect(dialog).toHaveTextContent("Owner: Matteo Conti → you");
    expect(dialog).toHaveTextContent("1 run in progress keeps using version 1");
    expect(dialog).toHaveTextContent(
      "Runs for clients whose project you can't see will ask you to choose.",
    );
  });

  it("accendere senza casella collegata non si può: lo dice e porta alla Posta", async () => {
    state.mailboxes = state.mailboxes.filter((b) => b.personId !== ROBERTA);
    await open("/automations/AUT-1");
    await userEvent.click(await screen.findByRole("button", { name: "Publish v2" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("Connect a mailbox in Mail first.");
    expect(within(dialog).getByRole("button", { name: "Publish" })).toBeDisabled();
  });

  it("mettere in pausa: dialogo, poi l'automazione è in pausa e la sua esecuzione in attesa è sospesa", async () => {
    await open("/automations/AUD-A1");
    await userEvent.click(await screen.findByRole("button", { name: "Pause" }));
    const dialog = await screen.findByRole("dialog", { name: "Pause AUD-A1?" });
    expect(dialog).toHaveTextContent("New events are ignored while it's paused");
    await userEvent.click(within(dialog).getByRole("button", { name: "Pause" }));
    await idle();
    expect(await screen.findByText("AUD-A1 is paused")).toBeInTheDocument();
    await waitFor(() =>
      expect(document.querySelector("[data-status-line]")).toHaveTextContent("Paused"),
    );
    expect(screen.getByRole("button", { name: "Turn on" })).toBeInTheDocument();
  });

  it("Viewer: stesse pagine, nessun bottone d'azione", async () => {
    grantProjectRole(GIULIA, "prj-aud", "viewer");
    await open("/automations/AUD-A1", GIULIA);
    expect(
      await screen.findByRole("heading", { level: 1, name: "Richiesta dati al cliente" }),
    ).toBeInTheDocument();
    for (const name of ["Pause", "Edit", "Turn on", "Test"]) {
      expect(screen.queryByRole("button", { name })).toBeNull();
      expect(screen.queryByRole("link", { name })).toBeNull();
    }
    expect(screen.queryByRole("link", { name: "Open in builder" })).toBeNull();
    // Le esecuzioni si vedono.
    expect(await screen.findByRole("link", { name: /^AUD-A1 #1/ })).toBeInTheDocument();
  });

  it("R-G5: inesistente e invisibile rispondono con la stessa pagina", async () => {
    await open("/automations/AUD-A9");
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(
      "This automation doesn't exist or you can't see it.",
    );
    const missing = document.body.innerHTML;
    document.body.innerHTML = "";
    await open("/automations/AUT-1", LAURA);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(
      "This automation doesn't exist or you can't see it.",
    );
    expect(document.querySelector("[data-not-visible]")!.outerHTML).toBe(
      new DOMParser().parseFromString(missing, "text/html").querySelector("[data-not-visible]")!
        .outerHTML,
    );
  });

  it("cambio di persona con il dettaglio aperto: si ricarica, e senza permesso diventa la pagina R-G5", async () => {
    await open("/automations/AUT-1");
    expect(
      await screen.findByRole("heading", { level: 1, name: "Nuovo contratto" }),
    ).toBeInTheDocument();
    await switchPersona(/Laura Costa/);
    // Mai il contenuto di prima per la persona nuova.
    expect(screen.queryByRole("heading", { level: 1, name: "Nuovo contratto" })).toBeNull();
    expect(
      await screen.findByRole("heading", {
        level: 1,
        name: "This automation doesn't exist or you can't see it.",
      }),
    ).toBeInTheDocument();
  });
});

describe("dettaglio di un'esecuzione", () => {
  it("approvazione che aspetta me: anteprima intera, Reject · Edit · Approve; il tempo non la sblocca", async () => {
    await open("/automations/AUD-A1/runs/1", MATTEO);
    const now = await screen.findByRole("region", { name: "Now" });
    expect(now).toHaveTextContent("Matteo Conti must approve an email");
    expect(now).toHaveTextContent("Mancano ancora alcuni dati per Centralino AI");
    expect(now).toHaveTextContent("amministrazione@cantinabellavista.example");
    expect(within(now).getByRole("button", { name: "Edit" })).toBeInTheDocument();
    // «Pass time»: c'è, spento, e dice perché.
    const proto = screen.getByRole("region", { name: "Pass time" });
    expect(proto).toHaveTextContent("Approvals don't expire: passing time won't move this run.");
    expect(within(proto).getByRole("button", { name: "+1 day" })).toBeDisabled();
    // Approvare con modifiche: il registro lo scrive, col prima e il dopo.
    await userEvent.click(within(now).getByRole("button", { name: "Edit" }));
    const subject = within(now).getByRole("textbox", { name: "Subject" });
    await userEvent.clear(subject);
    await userEvent.type(subject, "Ultimi dati per Centralino AI");
    await userEvent.click(within(now).getByRole("button", { name: "Approve with changes" }));
    await idle();
    expect(await screen.findByText("Approved with changes by Matteo Conti")).toBeInTheDocument();
    // Il bottone premuto non c'è più: il fuoco è sulla frase nuova di «Now».
    await waitFor(() => expect(document.activeElement).toHaveAttribute("data-now-title"));
    await waitFor(() =>
      expect(screen.getByRole("region", { name: "Now" })).toHaveTextContent(
        /Waiting for .* to reply/,
      ),
    );
    await userEvent.click(screen.getByRole("button", { name: "Show changes" }));
    const diff = document.querySelector('[data-diff="subject"]')!;
    expect(diff.querySelector("del")).toHaveTextContent("Mancano");
    expect(diff.querySelector("ins")).toHaveTextContent("Ultimi");
  });

  it("chi non decide vede chi deve approvare e da quando, senza bottoni", async () => {
    await open("/automations/AUD-A1/runs/1");
    const now = await screen.findByRole("region", { name: "Now" });
    expect(now).toHaveTextContent("Matteo Conti must approve an email");
    expect(now).toHaveTextContent(/Waiting since/);
    expect(within(now).queryByRole("button", { name: "Approve" })).toBeNull();
  });

  it("attesa della risposta: «Pass time» fino alla scadenza manda il promemoria", async () => {
    await open("/automations/AUD-A1/runs/2");
    const now = await screen.findByRole("region", { name: "Now" });
    expect(now).toHaveTextContent(
      "Waiting for Mix Cucine Srl to reply to “Ci servono alcuni dati per attivare Campagne WhatsApp”",
    );
    const proto = screen.getByRole("region", { name: "Pass time" });
    await userEvent.click(within(proto).getByRole("button", { name: /^To the next deadline/ }));
    await idle();
    await waitFor(() =>
      expect(
        screen.getByText(/^Sent “Promemoria: dati per attivare Campagne WhatsApp”/),
      ).toBeInTheDocument(),
    );
    expect(screen.getByText("Round 1 of at most 2")).toBeInTheDocument();
  });

  it("fallita: «Retry», «Skip» con conferma, «Cancel run» con conferma; Viewer non li ha", async () => {
    await open("/automations/BTG-A1/runs/1");
    const now = await screen.findByRole("region", { name: "Now" });
    expect(now).toHaveTextContent("Failed at step 1 “Create task”: permission lost");
    // La motivazione nella lingua di chi guarda, dal codice (B1): mai la prosa del registro.
    expect(now).toHaveTextContent(
      "Permission lost: the owner (Matteo Conti) no longer sees the step's project.",
    );
    expect(now).not.toHaveTextContent("Permesso perso");
    await userEvent.click(within(now).getByRole("button", { name: "Skip this step" }));
    const skip = await screen.findByRole("dialog", { name: "Skip step 1?" });
    expect(skip).toHaveTextContent("Later steps that use its data may fail.");
    await userEvent.click(within(skip).getByRole("button", { name: "Skip" }));
    await idle();
    expect(await screen.findByText(/^Skipped by Roberta Fontana/)).toBeInTheDocument();
  });

  it("annulla con conferma: il registro scrive chi", async () => {
    await open("/automations/AUD-A1/runs/2");
    await userEvent.click(await screen.findByRole("button", { name: "Cancel run" }));
    const dialog = await screen.findByRole("dialog", { name: "Cancel AUD-A1 #2?" });
    expect(dialog).toHaveTextContent(
      "Tasks, milestones and emails already created stay as they are.",
    );
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel run" }));
    await idle();
    expect(await screen.findByText("Cancelled by Roberta Fontana")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Now" })).toHaveTextContent(
      /Cancelled by Roberta Fontana on/,
    );
  });

  it("Viewer: niente Annulla, Riprova, Salta né «Pass time»", async () => {
    grantProjectRole(GIULIA, "prj-aud", "viewer");
    await open("/automations/AUD-A1/runs/2", GIULIA);
    await screen.findByRole("region", { name: "Now" });
    expect(screen.queryByRole("button", { name: "Cancel run" })).toBeNull();
    expect(screen.queryByRole("region", { name: "Pass time" })).toBeNull();
  });

  it("scegliere il progetto: il proprietario ha il selettore; chi gestisce le integrazioni il link alla tabella", async () => {
    await open("/automations/AUT-1/runs/2", MATTEO);
    const now = await screen.findByRole("region", { name: "Now" });
    expect(now).toHaveTextContent(
      "Matteo Conti must choose the project for client “Forneria Rossi & Lari”",
    );
    expect(
      within(now).getByRole("combobox", { name: /Which project for client/ }),
    ).toBeInTheDocument();
    expect(within(now).queryByRole("link", { name: /Link Forneria/ })).toBeNull();
  });

  it("cambio di persona con l'esecuzione aperta: la pagina si rimonta, niente stato della persona di prima", async () => {
    await open("/automations/AUD-A1/runs/1");
    await userEvent.click(await screen.findByRole("checkbox", { name: "Show data" }));
    expect(document.querySelectorAll("[data-entry-data]").length).toBeGreaterThan(0);
    // Roberta → Laura (Project Lead di AUD): vede ancora l'esecuzione, ricaricata per lei.
    await switchPersona(/Laura Costa/);
    const now = await screen.findByRole("region", { name: "Now" });
    expect(now).toHaveTextContent("Matteo Conti must approve an email");
    expect(screen.getByRole("checkbox", { name: "Show data" })).not.toBeChecked();
    expect(document.querySelector("[data-entry-data]")).toBeNull();
    // Di nuovo Roberta, coi dati già in cache: nemmeno così resta lo stato di Laura.
    await userEvent.click(screen.getByRole("checkbox", { name: "Show data" }));
    await switchPersona(/Roberta Fontana/);
    await screen.findByRole("region", { name: "Now" });
    expect(screen.getByRole("checkbox", { name: "Show data" })).not.toBeChecked();
  });

  it("R-G5 anche per un'esecuzione", async () => {
    await open("/automations/AUD-A1/runs/999");
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(
      "This run doesn't exist or you can't see it.",
    );
  });

  it("errore di lettura dell'esecuzione: resta l'errore con «Retry»", async () => {
    failNext("automations.getRun");
    renderRoute("/automations/AUD-A1/runs/2", ROBERTA);
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Couldn't load this run");
    await userEvent.click(within(alert).getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("region", { name: "Now" })).toBeInTheDocument();
  });

  it("il registro: rami presi con l'etichetta, rami non presi espandibili, Claude con uscite e motivazione", async () => {
    await open("/automations/AUD-A1/runs/1");
    const log = await screen.findByRole("list", { name: "Log" });
    expect(log).toHaveTextContent("Checked whether Testo della risposta isn't empty: yes");
    const claude = log.querySelector("[data-preview-claude]")!;
    expect(claude).toHaveTextContent("Claude chose mancano informazioni");
    const outcomes = claude.querySelector("[data-outcomes]")!;
    expect(within(outcomes as HTMLElement).getByText("mancano informazioni")).toHaveClass(
      "font-semibold",
    );
    expect(within(outcomes as HTMLElement).getByText("tutto presente")).toHaveClass(
      "text-ink-faint",
    );
    expect(claude).toHaveTextContent("Why — written by Claude");
    const notTaken = within(log).getByRole("button", {
      name: /^Not taken: If Claude answers “tutto presente”/,
    });
    expect(notTaken).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(notTaken);
    expect(log).toHaveTextContent("Create a task “Attivare Funzione da attivare per Cliente”");
    // «Show data»: etichette dei campi, non le chiavi.
    await userEvent.click(screen.getByRole("checkbox", { name: "Show data" }));
    expect(log.querySelectorAll("[data-entry-data]").length).toBeGreaterThan(3);
    expect(log).toHaveTextContent("Subject");
  });

  it("un effetto in un progetto che non vedo si scrive senza codice né titolo (R-J12)", async () => {
    const run = state.automationRuns.find((r) => r.id === "arun-aut1-1")!;
    // CBV diventa invisibile a Matteo (membro solo per il proprietario): le task restano col tipo.
    const cbv = state.projectsById.get("prj-cbv")!;
    cbv.memberIds = cbv.memberIds.filter((id) => id !== MATTEO);
    await open("/automations/AUT-1/runs/1", MATTEO);
    await userEvent.click((await screen.findAllByRole("button", { name: "Expand all" })).at(-1)!);
    expect(screen.getAllByText("Created a task in a project you can't see").length).toBe(
      run.log.filter((e) => e.kind === "createTask").length,
    );
    expect(document.body).not.toHaveTextContent("CBV-6");
  });

  it("?entry= porta alla riga del registro e apre i suoi gruppi", async () => {
    await open(
      `/automations/AUT-1/runs/1?entry=${encodeURIComponent("2/forEach[2]/0/else/0/else/0/then/0")}`,
    );
    const row = await waitFor(() => {
      const r = document.querySelector<HTMLElement>(
        '[data-entry-path="2/forEach[2]/0/else/0/else/0/then/0"]',
      );
      expect(r).not.toBeNull();
      return r!;
    });
    await waitFor(() =>
      expect(document.activeElement).toHaveAttribute("data-entry-path", row.dataset.entryPath),
    );
    expect(screen.getByRole("button", { name: /^Round 3 of 4/ })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
  });
});

/** Un'esecuzione di AUT-1 con 50 giri: 6 righe a giro, il giro 38 fallito (Review Focus 5). */
function bigRun(): AutomationRun {
  const at = "2026-10-20T10:00:00Z";
  const e = (
    path: string,
    kind: RunLogEntry["kind"],
    outcome: RunLogEntry["outcome"],
    over: Partial<RunLogEntry> = {},
  ): RunLogEntry => ({
    at,
    stepId: kind,
    path,
    kind,
    outcome,
    input: {},
    output: {},
    reason: null,
    byId: null,
    effects: [],
    ...over,
  });
  const items = Array.from({ length: 50 }, (_, i) => ({
    titolo: `Attività ${i + 1}`,
    reparto: "Sales",
  }));
  const log: RunLogEntry[] = [
    e("trigger", "trigger", "ok", { output: { cliente: { nome: "Cliente Grande Spa" } } }),
    e("0", "claude", "ok", {
      output: { "analisi.prodotto": "CRM", "analisi.task": items },
      reason: "Cinquanta attività.",
    }),
    e("1", "createMilestone", "ok", {
      input: { nome: "Attivazione", progetto: "prj-cbv" },
      effects: [{ kind: "milestone", code: "ms-x" }],
    }),
  ];
  items.forEach((item, i) => {
    let p = `2/forEach[${i}]/0`;
    for (let k = 0; k < 3; k++) {
      log.push(e(p, "condition", "ok", { output: { ramo: "else" } }));
      p = `${p}/else/0`;
    }
    const task = { titolo: item.titolo, progetto: "prj-cbv" };
    log.push(e(p, "createTask", "waiting", { input: task }));
    log.push(e(p, "createTask", "approved", { byId: MATTEO }));
    log.push(
      i === 37
        ? e(p, "createTask", "failed", { input: task, reason: "Permesso perso." })
        : e(p, "createTask", "ok", {
            input: task,
            effects: [{ kind: "task", code: `CBV-${100 + i}` }],
          }),
    );
  });
  log.push(e("2", "forEach", "ok", { output: { giri: 50 } }));
  return {
    id: "arun-big",
    automationId: "aut-new-contract",
    n: 9,
    version: 1,
    title: "Nuovo contratto – Cliente Grande Spa",
    status: "failed",
    event: { cliente: { nome: "Cliente Grande Spa" } },
    vars: {},
    cursor: "2/forEach[37]/0/else/0/else/0/else/0",
    waitingUntil: null,
    pending: null,
    log,
    startedAt: at,
    endedAt: at,
    error: "permission_lost",
    projectIds: ["prj-cbv"],
    origin: "source",
  };
}

describe("Review Focus 5: registro da 300 righe, 50 giri", () => {
  it("tutte le righe nella pagina, gruppi chiusi salvo il giro col problema; «Problems» filtra ai giri con problemi", async () => {
    state.automationRuns.push(bigRun());
    await open("/automations/AUT-1/runs/9");
    const log = await screen.findByRole("list", { name: "Log" });
    expect(screen.getByRole("heading", { level: 2, name: /^Log/ })).toHaveTextContent("Log304");
    // Tutto il registro è presente (⌘F lo trova), anche dentro i gruppi chiusi.
    expect(log.querySelectorAll("[data-entry-path]")).toHaveLength(303);
    const group = within(log).getByRole("button", {
      name: /^For each item of Task di attivazione · 50 rounds · 49 done, 1 failed/,
    });
    expect(group).toHaveAttribute("aria-expanded", "true");
    const rounds = log.querySelectorAll<HTMLElement>("[data-log-round] > button");
    expect(rounds).toHaveLength(50);
    const open38 = [...rounds].filter((b) => b.getAttribute("aria-expanded") === "true");
    expect(open38.map((b) => b.textContent)).toEqual([
      expect.stringMatching(/^Round 38 of 50 · Attività 38/),
    ]);
    // Il giro chiuso: nella pagina ma nascosto, cercabile.
    const closed = document.getElementById("log-round-2/forEach[0]")!;
    expect(closed).toHaveAttribute("hidden", "until-found");
    expect(closed).toHaveTextContent("Attività 1");
    // «Problems»: solo il giro 38.
    await userEvent.click(
      within(screen.getByRole("radiogroup", { name: "Show" })).getByRole("radio", {
        name: "Problems",
      }),
    );
    expect(log.querySelectorAll("[data-log-round]")).toHaveLength(1);
    expect(log.querySelectorAll('[data-outcome="failed"]')).toHaveLength(1);
    // Il giro chiuso si apre e si richiude.
    await userEvent.click(
      within(screen.getByRole("radiogroup", { name: "Show" })).getByRole("radio", { name: "All" }),
    );
    const first = log.querySelector<HTMLElement>('[data-log-round="2/forEach[0]"] > button')!;
    await userEvent.click(first);
    expect(first).toHaveAttribute("aria-expanded", "true");
    expect(document.getElementById("log-round-2/forEach[0]")).not.toHaveAttribute("hidden");
  });

  it("`[` e `]` portano al problema successivo e precedente", async () => {
    state.automationRuns.push(bigRun());
    await open("/automations/AUT-1/runs/9");
    const log = await screen.findByRole("list", { name: "Log" });
    log.querySelector<HTMLElement>("[data-entry-path]")!.focus();
    await userEvent.keyboard("]");
    expect(document.activeElement).toHaveAttribute("data-outcome", "failed");
  });
});

describe("sorgenti", () => {
  it("righe con stato in parola, chi l'ha collegata, chi la usa; la scaduta ha sempre «Reconnect»", async () => {
    await open("/automations/sources");
    expect(screen.getByRole("heading", { level: 1, name: "Sources" })).toBeInTheDocument();
    const list = await screen.findByRole("list", { name: "Connected sources" });
    const hubspot = list.querySelector<HTMLElement>('[data-source-row="src-hubspot"]')!;
    expect(hubspot).toHaveAccessibleName(
      "HubSpot, Expired, connected by Roberta Fontana, used by 0 automations",
    );
    expect(
      within(hubspot.closest("li")!).getByRole("button", { name: "Reconnect" }),
    ).toBeInTheDocument();
    const audin = list.querySelector<HTMLElement>('[data-source-row="src-audin"]')!;
    expect(audin).toHaveTextContent("Used by AUT-1");
  });

  it("senza `integrations.manage` la pagina non esiste (R-G5)", async () => {
    await open("/automations/sources", LAURA);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(
      "This page doesn't exist or you can't see it.",
    );
    expect(document.querySelector("[data-source-row]")).toBeNull();
  });

  it("collegare dichiara la simulazione; ricollegare rende chi agisce «chi l'ha collegata»", async () => {
    await open("/automations/sources");
    const list = await screen.findByRole("list", { name: "Connected sources" });
    await userEvent.click(within(list).getByRole("button", { name: "Reconnect" }));
    const dialog = await screen.findByRole("dialog", { name: "Reconnect HubSpot" });
    expect(within(dialog).getByRole("region", { name: "Prototype only" })).toHaveTextContent(
      "In this prototype the connection is simulated: no account is contacted.",
    );
    await userEvent.click(within(dialog).getByRole("button", { name: "Reconnect" }));
    await idle();
    expect(await screen.findByText("HubSpot connected")).toBeInTheDocument();
    await waitFor(() =>
      expect(list.querySelector('[data-source-row="src-hubspot"]')).toHaveAccessibleName(
        /HubSpot, Connected/,
      ),
    );
  });

  it("scollegare dice quali automazioni attive si fermano", async () => {
    await open("/automations/sources?source=src-audin");
    const panel = await screen.findByRole("region", { name: "Source Audin" });
    await userEvent.click(within(panel).getByRole("button", { name: "Disconnect" }));
    const dialog = await screen.findByRole("dialog", { name: "Disconnect Audin?" });
    expect(dialog).toHaveTextContent(
      "1 active automation starts from Audin: AUT-1 Nuovo contratto.",
    );
    expect(dialog).toHaveTextContent(
      "Runs already in progress continue. Events sent while disconnected are lost.",
    );
  });

  it("«Simulate an event» (solo prototipo) fa partire AUT-1 e lo dice in un toast con «Open»", async () => {
    const router = await open("/automations/sources?source=src-audin");
    const panel = await screen.findByRole("region", { name: "Source Audin" });
    const box = within(panel).getByRole("region", { name: "Simulate an event" });
    expect(box).toHaveTextContent("Prototype only");
    await userEvent.click(within(box).getAllByRole("button", { name: "Send" })[1]!);
    await idle();
    const toast = await screen.findByText(/^Event sent · started AUT-1 #3$/);
    await userEvent.click(
      within(toast.closest("[data-toast]")!).getByRole("button", { name: "Open" }),
    );
    await waitFor(() => expect(router.state.location.pathname).toBe("/automations/AUT-1/runs/3"));
  });

  it("il webhook: indirizzo, esempio e campi con etichette", async () => {
    await open("/automations/sources?source=src-webhook");
    const panel = await screen.findByRole("region", {
      name: "Source Modulo di attivazione dal sito",
    });
    expect(panel).toHaveTextContent("Send a POST with a JSON body to this address.");
    expect(panel.querySelector("[data-webhook-example]")).toHaveTextContent('"cliente"');
    const fields = within(panel).getByRole("table", { name: "Fields" });
    expect(
      within(fields).getByRole("textbox", { name: "Label of richiesta.funzione" }),
    ).toHaveValue("Funzione da attivare");
    expect(panel.querySelector("[data-webhook-address]")).toHaveAttribute(
      "title",
      "https://stubwise.example/hooks/in/4f7c2a91d03e",
    );
  });

  it("cambio di persona con il pannello aperto: senza permesso, pagina R-G5 e nessun dato della sorgente", async () => {
    await open("/automations/sources?source=src-hubspot");
    await screen.findByRole("region", { name: "Source HubSpot" });
    await switchPersona(/Laura Costa/);
    expect(
      await screen.findByRole("heading", {
        level: 1,
        name: "This page doesn't exist or you can't see it.",
      }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Source HubSpot" })).toBeNull();
    expect(document.body).not.toHaveTextContent("Deals won");
  });
});

describe("clienti e progetti", () => {
  it("righe ordinate per cliente col progetto in codice + nome; aggiungere, chiave già presente", async () => {
    await open("/automations/sources");
    const table = await screen.findByRole("list", { name: "Clients and projects" });
    const rows = table.querySelectorAll<HTMLElement>("[data-client-link]");
    expect([...rows].map((r) => r.dataset.clientLink)).toEqual([
      "cantinabellavista.example",
      "mixcucine.example",
      "tessituramori.example",
    ]);
    expect(rows[0]).toHaveTextContent("Email domain · cantinabellavista.example");
    expect(rows[0]).toHaveTextContent("CBV");
    await userEvent.click(screen.getByRole("button", { name: "Add client" }));
    const add = document.querySelector<HTMLElement>("[data-add-client]")!;
    await userEvent.type(
      within(add).getByRole("textbox", { name: "Client" }),
      "Forneria Rossi & Lari",
    );
    await userEvent.type(within(add).getByRole("textbox", { name: "Key" }), "mixcucine.example");
    expect(within(add).getByRole("alert")).toHaveTextContent(
      "mixcucine.example is already linked to MKX",
    );
    expect(within(add).getByRole("button", { name: "Add" })).toBeDisabled();
    await userEvent.clear(within(add).getByRole("textbox", { name: "Key" }));
    await userEvent.type(
      within(add).getByRole("textbox", { name: "Key" }),
      "forneriarossilari.example",
    );
    await userEvent.selectOptions(
      within(add).getByRole("combobox", { name: "Project" }),
      "prj-aud",
    );
    await userEvent.click(within(add).getByRole("button", { name: "Add" }));
    await idle();
    expect(await screen.findByText("Forneria Rossi & Lari linked")).toBeInTheDocument();
    expect(
      state.clientProjectLinks.find((l) => l.clientKey === "forneriarossilari.example")?.projectId,
    ).toBe("prj-aud");
  });

  it("una riga verso un progetto che non vedo: «A project you can't see», solo «Remove»", async () => {
    state.clientProjectLinks.push({
      clientKey: "lontano.example",
      clientName: "Lontano Srl",
      projectId: "prj-gone",
    });
    await open("/automations/sources");
    const row = await waitFor(() => {
      const r = document.querySelector<HTMLElement>('[data-client-link="lontano.example"]');
      expect(r).not.toBeNull();
      return r!;
    });
    expect(row).toHaveTextContent("A project you can't see");
    await userEvent.click(
      within(row).getByRole("button", { name: "More actions for Lontano Srl" }),
    );
    expect(screen.queryByRole("menuitem", { name: "Change project" })).toBeNull();
    await userEvent.click(screen.getByRole("menuitem", { name: "Remove" }));
    const dialog = await screen.findByRole("dialog", { name: "Remove Lontano Srl?" });
    expect(dialog).toHaveTextContent("You can't see the project it points to.");
    await userEvent.click(within(dialog).getByRole("button", { name: "Remove" }));
    await idle();
    await waitFor(() =>
      expect(document.querySelector('[data-client-link="lontano.example"]')).toBeNull(),
    );
  });
});

// --- Revisione del Task 5, giro 1 -------------------------------------------------------

/** Una casella collegata per una persona del seme che non ne ha (Roberta). */
function connectMailbox(personId: string, email = `${personId.slice(2)}@example.com`) {
  const account = state.googleAccounts.find((a) => a.personId === personId);
  if (account) account.status = "connected";
  else
    state.googleAccounts.push({
      personId,
      email,
      status: "connected",
      since: "2026-10-01T00:00:00Z",
    });
  state.mailboxes.push({
    personId,
    email,
    proposalsEnabled: false,
    syncedAt: "2026-10-01T00:00:00Z",
    sync: "ok",
  });
  return email;
}

describe("R-J16 in pagina: il testo della risposta solo al proprietario", () => {
  const REPLY = "Buongiorno, i numeri da collegare sono 0577 000111";

  it("chi non è il proprietario vede che è arrivata e dove sta, non il testo (anche in «Show data» e «Copy as JSON»)", async () => {
    const writes: string[] = [];
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: (s: string) => (writes.push(s), Promise.resolve()) },
    });
    await open("/automations/AUD-A1/runs/1");
    const log = await screen.findByRole("list", { name: "Log" });
    expect(log).toHaveTextContent(
      /Reply from amministrazione@cantinabellavista\.example received on/,
    );
    expect(log).toHaveTextContent("The reply is in Matteo Conti's mailbox");
    await userEvent.click(screen.getByRole("checkbox", { name: "Show data" }));
    expect(document.body).not.toHaveTextContent(REPLY);
    for (const b of within(log).getAllByRole("button", { name: "Copy as JSON" }))
      await userEvent.click(b);
    expect(writes.length).toBeGreaterThan(3);
    expect(writes.join("\n")).not.toContain(REPLY);
  });

  it("il proprietario la legge", async () => {
    await open("/automations/AUD-A1/runs/1", MATTEO);
    await userEvent.click(await screen.findByRole("checkbox", { name: "Show data" }));
    expect(document.body).toHaveTextContent(REPLY);
    expect(document.body).not.toHaveTextContent("The reply is in");
  });
});

describe("registro: i separatori del giorno riga per riga", () => {
  it("la risposta arrivata in un altro giorno ha il suo separatore, anche dentro lo stesso passo", async () => {
    await open("/automations/AUD-A1/runs/1");
    const log = await screen.findByRole("list", { name: "Log" });
    const reply = log.querySelector<HTMLElement>('[data-entry-path="1"][data-outcome="ok"]')!;
    const waiting = log.querySelector<HTMLElement>(
      '[data-entry-path="1"][data-outcome="waiting"]',
    )!;
    // La riga «in attesa» e la risposta sono dello stesso passo ma di giorni diversi.
    expect(reply.previousElementSibling).toHaveAttribute("data-day-separator");
    expect(waiting.previousElementSibling).not.toHaveAttribute("data-day-separator");
    const days = [...log.querySelectorAll("[data-day-separator]")].map((d) => d.textContent);
    expect(new Set(days).size).toBe(days.length);
  });

  it("`]` da qualunque punto della pagina apre il gruppo chiuso e porta al problema", async () => {
    state.automationRuns.push(bigRun());
    await open("/automations/AUT-1/runs/9");
    await screen.findByRole("list", { name: "Log" });
    await userEvent.click(screen.getByRole("button", { name: "Collapse all" }));
    expect(document.getElementById("log-round-2/forEach[37]")).toHaveAttribute(
      "hidden",
      "until-found",
    );
    (document.activeElement as HTMLElement | null)?.blur();
    await userEvent.keyboard("]");
    await waitFor(() => expect(document.activeElement).toHaveAttribute("data-outcome", "failed"));
    expect(document.getElementById("log-round-2/forEach[37]")).not.toHaveAttribute("hidden");
  });
});

describe("accendere e pubblicare: la casella scelta, i problemi della bozza", () => {
  it("il dialogo elenca solo le caselle collegate e la scelta resta sull'automazione", async () => {
    const first = connectMailbox(ROBERTA);
    // Una seconda casella della stessa persona: la scelta nel dialogo deve arrivare ai dati.
    const email = "roberta.vendite@example.com";
    state.mailboxes.push({
      personId: ROBERTA,
      email,
      proposalsEnabled: false,
      syncedAt: "2026-10-01T00:00:00Z",
      sync: "ok",
    });
    await open("/automations/AUT-1");
    await userEvent.click(await screen.findByRole("button", { name: "Publish v2" }));
    const dialog = await screen.findByRole("dialog", { name: "Publish version 2 of AUT-1?" });
    expect(within(dialog).getByRole("radio", { name: first })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await userEvent.click(within(dialog).getByRole("radio", { name: email }));
    await userEvent.click(within(dialog).getByRole("button", { name: "Publish" }));
    await idle();
    expect(await screen.findByText("AUT-1 is on · you're the owner")).toBeInTheDocument();
    expect(state.automations.find((a) => a.code === "AUT-1")).toMatchObject({
      ownerId: ROBERTA,
      mailbox: email,
    });
  });

  it("errori nella bozza: «Problems» li dice «nella bozza della v2», «Publish» porta lì, la riga e «Needs attention» li contano", async () => {
    const a = state.automations.find((x) => x.code === "AUT-1")!;
    const welcome = a.versions[1]!.flow.steps[3] as { to: string };
    welcome.to = "{{cliente.fax}}";
    await open("/automations/AUT-1");
    const problems = await screen.findByRole("region", { name: "1 problem" });
    expect(problems).toHaveTextContent(
      "In the draft of v2: 1 problem — it can't be published until it's fixed",
    );
    await userEvent.click(screen.getByRole("button", { name: "Publish v2" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(
      await screen.findByText("Fix the problem first: it's listed under Problems."),
    ).toBeInTheDocument();
    expect(problems).toHaveFocus();
    document.body.innerHTML = "";
    await open("/automations?view=attention");
    expect(await screen.findByRole("link", { name: /^AUT-1, Nuovo contratto/ })).toHaveTextContent(
      "1 problem",
    );
  });

  it("dall'elenco, «Turn on» con problemi porta alla sezione Problems", async () => {
    state.automations.find((x) => x.code === "AUT-1")!.status = "paused";
    state.automationSources.find((x) => x.id === "src-audin")!.status = "disconnected";
    const router = await open("/automations");
    const row = (await screen.findByRole("link", { name: /^AUT-1,/ })).closest("li")!;
    await userEvent.click(within(row).getByRole("button", { name: "More actions for AUT-1" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Turn on" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/automations/AUT-1"));
    expect(router.state.location.search).toMatchObject({ problems: "1" });
    await waitFor(() => expect(document.querySelector("[data-problems-section]")).toHaveFocus());
  });
});

describe("riga di stato, duplicare, avvio a mano", () => {
  it("chi ha messo in pausa e chi ha creato la bozza", async () => {
    await open("/automations/BTG-A1");
    expect(await screen.findByText(/paused by Roberta Fontana on/)).toBeInTheDocument();
    // Nessuna esecuzione sospesa: la riga non dice «0 runs suspended».
    expect(document.querySelector("[data-status-line]")).not.toHaveTextContent("suspended");
    document.body.innerHTML = "";
    await open("/automations/STW-A1");
    expect(
      await screen.findByText(/never turned on · created by Laura Costa on/),
    ).toBeInTheDocument();
  });

  it("«Duplicate this version» da una versione vecchia: una bozza nuova, poi il suo dettaglio", async () => {
    const a = state.automations.find((x) => x.code === "AUD-A1")!;
    a.versions.push({
      ...a.versions[0]!,
      n: 2,
      publishedAt: "2026-10-20T10:00:00Z",
      publishedById: MATTEO,
    });
    const router = await open("/automations/AUD-A1");
    await userEvent.click(await screen.findByRole("button", { name: /^v1 · published by/ }));
    await userEvent.click(screen.getByRole("button", { name: "Duplicate this version" }));
    const dialog = await screen.findByRole("dialog", { name: "Duplicate version 1 of AUD-A1" });
    expect(within(dialog).getByRole("textbox", { name: "Name" })).toHaveValue(
      "Richiesta dati al cliente (copy)",
    );
    await userEvent.click(within(dialog).getByRole("button", { name: "Duplicate" }));
    await waitFor(() =>
      expect(router.state.location.pathname).toMatch(/^\/automations\/AUD-A\d+$/),
    );
    expect(router.state.location.pathname).not.toBe("/automations/AUD-A1");
    expect(
      await screen.findByText(/never turned on · created by Roberta Fontana/),
    ).toBeInTheDocument();
  });

  it("«Run now»: i dati dell'inizio con l'etichetta, poi parte e lo dice", async () => {
    state.automations.push({
      id: "aut-manual",
      code: "AUD-A7",
      name: "Controllo a mano",
      description: "",
      projectId: "prj-aud",
      ownerId: ROBERTA,
      status: "active",
      versions: [
        {
          n: 1,
          flow: {
            trigger: { kind: "manual" },
            steps: [],
            titleTemplate: "Controllo – {{avvio.data}}",
          },
          publishedAt: "2026-10-01T10:00:00Z",
          publishedById: ROBERTA,
        },
      ],
      createdAt: "2026-10-01T10:00:00Z",
    });
    await open("/automations/AUD-A7");
    await userEvent.click(await screen.findByRole("button", { name: "More" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Run now" }));
    const dialog = await screen.findByRole("dialog", { name: "Run AUD-A7 now" });
    const date = within(dialog).getByLabelText("Data dell'avvio");
    expect(date).toHaveValue(TODAY);
    await userEvent.clear(date);
    await userEvent.type(date, "2026-11-02");
    await userEvent.click(within(dialog).getByRole("button", { name: "Run now" }));
    await idle();
    expect(await screen.findByText("Started AUD-A7 #1")).toBeInTheDocument();
    expect(state.automationRuns.find((r) => r.automationId === "aut-manual")!.event).toEqual({
      avvio: { data: "2026-11-02" },
    });
  });
});

describe("esecuzione: tempo a ore, «Remember»", () => {
  it("«+1 hour» fa passare un'ora", async () => {
    await open("/automations/AUD-A1/runs/2");
    const proto = await screen.findByRole("region", { name: "Pass time" });
    await userEvent.click(within(proto).getByRole("button", { name: "+1 hour" }));
    await idle();
    const clock = state.automationClock.get("arun-auda1-2")!;
    expect(clock.slice(11, 16)).toBe("13:00");
  });

  it("«Remember for» il cliente scrive la tabella; senza `integrations.manage` non c'è", async () => {
    state.automations.find((x) => x.code === "AUT-1")!.ownerId = ROBERTA;
    await open("/automations/AUT-1/runs/2");
    const now = await screen.findByRole("region", { name: "Now" });
    await userEvent.selectOptions(within(now).getByRole("combobox"), "prj-aud");
    await userEvent.click(
      within(now).getByRole("checkbox", { name: "Remember for Forneria Rossi & Lari" }),
    );
    await userEvent.click(within(now).getByRole("button", { name: "Choose" }));
    await idle();
    expect(
      state.clientProjectLinks.find((l) => l.clientKey === "forneriarossilari.example"),
    ).toMatchObject({
      projectId: "prj-aud",
      addedById: ROBERTA,
    });
    await waitFor(() => expect(document.activeElement).toHaveAttribute("data-now-title"));
  });

  it("il proprietario senza `integrations.manage` sceglie senza «Remember»", async () => {
    await open("/automations/AUT-1/runs/2", MATTEO);
    const now = await screen.findByRole("region", { name: "Now" });
    expect(within(now).queryByRole("checkbox")).toBeNull();
  });
});

describe("sorgenti curate in pagina", () => {
  it("un webhook nuovo: nome, poi il pannello con «Paste an example»; JSON non valido detto; i campi nascono dall'esempio", async () => {
    const router = await open("/automations/sources");
    await userEvent.click(await screen.findByRole("button", { name: "Connect" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Incoming webhook" }));
    const dialog = await screen.findByRole("dialog", { name: "New incoming webhook" });
    await userEvent.type(within(dialog).getByRole("textbox", { name: "Name" }), "Ordini e-shop");
    await userEvent.click(within(dialog).getByRole("button", { name: "Create" }));
    await idle();
    const panel = await screen.findByRole("region", { name: "Source Ordini e-shop" });
    expect(router.state.location.search).toMatchObject({
      source: expect.stringMatching(/^src-wh-/),
    });
    await userEvent.click(within(panel).getByRole("button", { name: "Paste an example" }));
    const area = within(panel).getByRole("textbox", { name: "Example (JSON)" });
    await userEvent.click(area);
    await userEvent.paste('{ "ordine": { "totale": 12, }');
    expect(await within(panel).findByRole("alert")).toHaveTextContent("This isn't valid JSON");
    expect(within(panel).getByRole("button", { name: "Save example" })).toBeDisabled();
    await userEvent.clear(area);
    await userEvent.paste('{ "cliente": { "email": "a@b.example" }, "ordine": { "totale": 12 } }');
    await waitFor(() =>
      expect(within(panel).getByRole("button", { name: "Save example" })).toBeEnabled(),
    );
    await userEvent.click(within(panel).getByRole("button", { name: "Save example" }));
    await idle();
    const fields = await within(panel).findByRole("table", { name: "Fields" });
    expect(within(fields).getByRole("textbox", { name: "Label of ordine.totale" })).toHaveValue(
      "Ordine totale",
    );
    expect(within(fields).getByRole("combobox", { name: "Type of cliente.email" })).toHaveValue(
      "email",
    );
  });

  it("sostituire l'esempio di un webhook usato segnala i campi che spariscono e chiede conferma", async () => {
    await open("/automations/sources?source=src-webhook");
    const panel = await screen.findByRole("region", {
      name: "Source Modulo di attivazione dal sito",
    });
    await userEvent.click(within(panel).getByRole("button", { name: "Replace example" }));
    const area = within(panel).getByRole("textbox", { name: "Example (JSON)" });
    await userEvent.clear(area);
    await userEvent.paste('{ "cliente": { "nome": "X", "email": "x@x.example" } }');
    const missing = await within(panel).findByText(
      /Funzione da attivare · used by AUD-A1 · missing from the new example/,
    );
    expect(missing).toBeInTheDocument();
    expect(panel).toHaveTextContent(
      "AUD-A1 uses 2 fields that the new example doesn't have. It will show a problem.",
    );
    expect(within(panel).getByRole("button", { name: "Replace anyway" })).toBeEnabled();
  });

  it("l'indirizzo si copia e si rigenera con conferma; un campo si rinomina in posto", async () => {
    const writes: string[] = [];
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: (s: string) => (writes.push(s), Promise.resolve()) },
    });
    await open("/automations/sources?source=src-webhook");
    const panel = await screen.findByRole("region", {
      name: "Source Modulo di attivazione dal sito",
    });
    await userEvent.click(within(panel).getByRole("button", { name: "Copy" }));
    expect(writes).toEqual(["https://stubwise.example/hooks/in/4f7c2a91d03e"]);
    await userEvent.click(
      within(panel).getByRole("button", { name: "More actions for the address" }),
    );
    await userEvent.click(screen.getByRole("menuitem", { name: "Generate a new address" }));
    const dialog = await screen.findByRole("dialog", { name: "Generate a new address?" });
    expect(dialog).toHaveTextContent("The old address stops working at once.");
    await userEvent.click(within(dialog).getByRole("button", { name: "Generate a new address" }));
    await idle();
    await waitFor(() =>
      expect(panel.querySelector("[data-webhook-address]")).not.toHaveAttribute(
        "title",
        "https://stubwise.example/hooks/in/4f7c2a91d03e",
      ),
    );
    const label = within(panel).getByRole("textbox", { name: "Label of cliente.nome" });
    await userEvent.clear(label);
    await userEvent.type(label, "Ragione sociale{Enter}");
    await idle();
    await waitFor(() =>
      expect(state.automationSources.find((x) => x.id === "src-webhook")!.fields[0]!.label).toBe(
        "Ragione sociale",
      ),
    );
  });

  it("«Edit and send»: un evento scritto a mano fa partire AUD-A1", async () => {
    await open("/automations/sources?source=src-webhook");
    const panel = await screen.findByRole("region", {
      name: "Source Modulo di attivazione dal sito",
    });
    const box = within(panel).getByRole("region", { name: "Simulate an event" });
    await userEvent.click(within(box).getByRole("button", { name: "Edit and send" }));
    const area = within(box).getByRole("textbox", { name: "The event to send (JSON)" });
    await userEvent.clear(area);
    await userEvent.paste(
      '{ "cliente": { "nome": "Panificio Neri", "email": "info@neri.example" }, "richiesta": { "funzione": "CRM", "dati": "Il logo." } }',
    );
    await userEvent.click(within(box).getByRole("button", { name: "Send" }));
    await idle();
    expect(await screen.findByText("Event sent · started AUD-A1 #3")).toBeInTheDocument();
  });

  it("rinominare dal «⋯» del pannello; «Reconnected by» dopo un ricollegamento; scaduta: «expired on», «Simulate» spento", async () => {
    await open("/automations/sources?source=src-hubspot");
    const panel = await screen.findByRole("region", { name: "Source HubSpot" });
    const row = document.querySelector<HTMLElement>('[data-source-row="src-hubspot"]')!;
    expect(row).toHaveTextContent(/expired on/);
    const off = within(row.closest("li")!).getByRole("button", { name: "Simulate an event" });
    expect(off).toBeDisabled();
    expect(off).toHaveAccessibleDescription("Reconnect HubSpot to receive events.");
    await userEvent.click(within(panel).getAllByRole("button", { name: "Reconnect" })[0]!);
    const dialog = await screen.findByRole("dialog", { name: "Reconnect HubSpot" });
    await userEvent.click(within(dialog).getByRole("button", { name: "Reconnect" }));
    await idle();
    expect(await within(panel).findByText(/^Reconnected by Roberta Fontana ·/)).toBeInTheDocument();
    await userEvent.click(within(panel).getByRole("button", { name: "More actions for HubSpot" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Rename" }));
    const name = within(panel).getByRole("textbox", { name: "Name of the source" });
    await userEvent.clear(name);
    await userEvent.type(name, "HubSpot vendite{Enter}");
    await idle();
    expect(
      await screen.findByRole("region", { name: "Source HubSpot vendite" }),
    ).toBeInTheDocument();
  });

  it("la tabella: «Added by» e i suggerimenti «From recent events» nella riga nuova", async () => {
    await open("/automations/sources");
    const row = await waitFor(() => {
      const r = document.querySelector<HTMLElement>('[data-client-link="mixcucine.example"]');
      expect(r).not.toBeNull();
      return r!;
    });
    expect(row.querySelector("[data-added-by]")).toHaveTextContent("Roberta Fontana");
    await userEvent.click(screen.getByRole("button", { name: "Add client" }));
    const add = document.querySelector<HTMLElement>("[data-add-client]")!;
    const suggestion = await within(add).findByRole("button", { name: "Forneria Rossi & Lari" });
    await userEvent.click(suggestion);
    expect(within(add).getByRole("textbox", { name: "Key" })).toHaveValue(
      "forneriarossilari.example",
    );
  });
});

describe("revisione del Task 5, giro 2", () => {
  it("il dialogo blocca per tipo di passo: senza `tickets.create` nel progetto, la task", async () => {
    revokeProjectPermission(LAURA, "prj-stw", "tickets.create" as never);
    await open("/automations/STW-A1", LAURA);
    await userEvent.click(await screen.findByRole("button", { name: "Turn on" }));
    const dialog = await screen.findByRole("dialog", { name: "Turn on STW-A1?" });
    expect(dialog.querySelector("[data-blocked]")).toHaveTextContent(
      "You can't create tasks in STW: step 2 would fail.",
    );
    expect(within(dialog).getByRole("button", { name: "Turn on" })).toBeDisabled();
  });

  it("…e senza `tickets.edit` il traguardo, anche con `tickets.create`", async () => {
    revokeProjectPermission(LAURA, "prj-stw", "tickets.edit" as never);
    const draft = state.automations.find((x) => x.code === "STW-A1")!.versions[0]!.flow;
    draft.steps.push({
      id: "ms",
      kind: "createMilestone",
      name: "Rilascio",
      dueInDays: 7,
      project: { mode: "own" },
      approval: { mode: "auto" },
    });
    await open("/automations/STW-A1", LAURA);
    await userEvent.click(await screen.findByRole("button", { name: "Turn on" }));
    const dialog = await screen.findByRole("dialog", { name: "Turn on STW-A1?" });
    const blocked = [...dialog.querySelectorAll("[data-blocked]")].map((b) => b.textContent);
    expect(blocked).toEqual(["You can't create milestones in STW: step 3 would fail."]);
  });

  it("…e senza `backlog.create` la richiesta", async () => {
    revokeProjectPermission(LAURA, "prj-stw", "backlog.create" as never);
    const draft = state.automations.find((x) => x.code === "STW-A1")!.versions[0]!.flow;
    draft.steps.push({
      id: "rq",
      kind: "createRequest",
      title: "Richiesta",
      description: "",
      project: { mode: "own" },
      approval: { mode: "auto" },
    });
    await open("/automations/STW-A1", LAURA);
    await userEvent.click(await screen.findByRole("button", { name: "Turn on" }));
    const dialog = await screen.findByRole("dialog", { name: "Turn on STW-A1?" });
    const blocked = [...dialog.querySelectorAll("[data-blocked]")].map((b) => b.textContent);
    expect(blocked).toEqual(["You can't create requests in STW: step 3 would fail."]);
    expect(within(dialog).getByRole("button", { name: "Turn on" })).toBeDisabled();
  });

  it("un rifiuto del livello dati si legge in parole (casella scaduta dopo aver aperto il dialogo)", async () => {
    connectMailbox(ROBERTA);
    await open("/automations/AUT-1");
    await userEvent.click(await screen.findByRole("button", { name: "Publish v2" }));
    const dialog = await screen.findByRole("dialog", { name: "Publish version 2 of AUT-1?" });
    state.googleAccounts.find((g) => g.personId === ROBERTA)!.status = "expired";
    await userEvent.click(within(dialog).getByRole("button", { name: "Publish" }));
    expect(
      await screen.findByText(
        "Couldn't publish AUT-1: your mailbox connection expired. Reconnect it in Mail.",
      ),
    ).toBeInTheDocument();
  });

  it("senza un cliente conosciuto «Remember for» non c'è", async () => {
    state.automations.find((x) => x.code === "AUT-1")!.ownerId = ROBERTA;
    const run = state.automationRuns.find((r) => r.id === "arun-aut1-2")!;
    run.pending!.preview = {};
    run.event = {};
    await open("/automations/AUT-1/runs/2");
    const now = await screen.findByRole("region", { name: "Now" });
    expect(within(now).getByRole("combobox")).toBeInTheDocument();
    expect(within(now).queryByRole("checkbox")).toBeNull();
  });

  it("i tipi di un campo comprendono «yes or no»", async () => {
    await open("/automations/sources?source=src-webhook");
    const panel = await screen.findByRole("region", {
      name: "Source Modulo di attivazione dal sito",
    });
    const type = within(panel).getByRole("combobox", { name: "Type of cliente.nome" });
    expect(within(type).getByRole("option", { name: "yes or no" })).toBeInTheDocument();
  });
});
