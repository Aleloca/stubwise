import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { visitSteps } from "../../../domain/automations/fields";
import { automations as automationsApi, failNext, resetApi, setLatency } from "../../../data/api";
import { templateFlow } from "../../../data/automations/templates";
import { state } from "../../../data/store";
import type { Step } from "../../../data/types";
import { grantProjectRole, resetViewerGrants } from "../../../data/viewer";
import { DOCKED_PANEL_QUERY } from "../../../layout/useDetailPanel";
import { clearToasts } from "../../../tasks-ui/Toast";
import { renderRoute } from "../../../test/renderRoute";
import { setMatchMedia } from "../../../test/setup";
import { TEMPLATE_STEPS } from "../CreateAutomationDialog";

// Il costruttore (Task 6, shape automation-builder.md). Persone del seme:
// Matteo (proprietario di AUT-1 e AUD-A1), Roberta (admin), Laura (Project
// Lead di STW, ha creato la bozza STW-A1), Giulia (resa Viewer di AUD).

const MATTEO = "p-matteo";
const ROBERTA = "p-roberta";
const LAURA = "p-laura";
const GIULIA = "p-giulia";
const auto = (code: string) => state.automations.find((a) => a.code === code)!;

async function open(path: string, personId = MATTEO) {
  const router = renderRoute(path, personId);
  await screen.findByRole("heading", { level: 1 });
  await screen.findByRole("tree");
  return router;
}

const tree = () => screen.getByRole("tree");
const row = (id: string) => tree().querySelector<HTMLElement>(`[data-tree-row="${id}"]`)!;
const rowText = (id: string) => row(id).firstElementChild!.textContent ?? "";
const sentence = (id: string) => row(id).querySelector<HTMLElement>(`#row-text-${id}`)!;
/** I numeri delle righe dei passi, nell'ordine del DOM. */
const numbers = () =>
  [...tree().querySelectorAll<HTMLElement>("[data-step-path]")].map((r) =>
    Number(r.querySelector(".num")?.textContent),
  );
const idsInOrder = () =>
  [...tree().querySelectorAll<HTMLElement>("[data-step-path]")].map((r) => r.dataset.treeRow);
const savedFlow = (code: string) => auto(code).versions.at(-1)!.flow;
const settle = () => act(() => new Promise((r) => setTimeout(r, 500)));

beforeEach(() => {
  setLatency(0);
  resetApi();
  setMatchMedia(DOCKED_PANEL_QUERY, true);
  try {
    window.localStorage.clear();
  } catch {
    // niente storage
  }
});
afterEach(() => {
  resetViewerGrants();
  clearToasts();
});

describe("lettura", () => {
  it("AUT-1: procedura numerata 1…N su tutto l'albero, corsie in parole, approvazione sulla riga", async () => {
    await open("/automations/AUT-1/edit");
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Nuovo contratto");
    expect(screen.getByText("Editing version 2 · version 1 is on")).toBeInTheDocument();
    expect(document.querySelector("[data-draft-band]")).toHaveTextContent(
      "Version 1 keeps running until you publish",
    );
    // 11 passi, numerati senza «3.2.1».
    expect(numbers()).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    expect(row("trigger")).toHaveTextContent("When a deal is won on Audin");
    expect(row("trigger")).toHaveTextContent("pieces of data available");
    expect(tree()).toHaveTextContent("For each task in Task di attivazione");
    expect(tree()).toHaveTextContent("If Reparto is “Development”");
    expect(tree()).toHaveTextContent("Otherwise");
    expect(within(row("nc-welcome")).getByText("Asks the owner")).toBeInTheDocument();
    // «Runs by itself» non si grida.
    expect(row("nc-milestone").querySelector("[data-asks]")).toBeNull();
    expect(document.querySelector("[data-problem-count]")).toBeNull();
    // Nessun passo selezionato: il pannello mostra l'inizio.
    expect(screen.getByRole("heading", { name: "When this starts" })).toBeInTheDocument();
  });

  it("il passo di Claude dice in testa che sceglie solo fra le uscite disegnate", async () => {
    await open("/automations/AUD-A1/edit");
    await userEvent.click(sentence("cd-verify"));
    const panel = screen.getByRole("region", { name: /Step \d+/ });
    expect(within(panel).getByText(/Claude only picks one of these outcomes/)).toBeInTheDocument();
    expect(within(panel).queryByText("Before it runs")).toBeNull();
    expect(tree()).toHaveTextContent("If Claude says “tutto presente”");
    expect(tree()).toHaveTextContent("Repeat until");
    expect(tree()).toHaveTextContent("When the limit is reached");
  });

  it("chi vede ma non gestisce: stessa pagina in sola lettura, niente «+» né «⋯»", async () => {
    grantProjectRole(GIULIA, "prj-aud", "viewer");
    await open("/automations/AUD-A1/edit", GIULIA);
    expect(document.querySelector("[data-read-only]")).toHaveTextContent(
      "Only someone who can manage automations in AUD can change this.",
    );
    expect(screen.queryByRole("button", { name: "Add a step" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Actions for step/ })).toBeNull();
    expect(document.querySelector("[data-primary-action]")).toBeNull();
  });

  it("R-G5: inesistente e invisibile rispondono uguale", async () => {
    const first = renderRoute("/automations/AUT-1/edit", LAURA);
    await waitFor(() =>
      expect(document.querySelector('[data-not-visible="automation"]')).not.toBeNull(),
    );
    const hidden = document.querySelector('[data-not-visible="automation"]')!.textContent;
    void first;
    document.body.innerHTML = "";
    renderRoute("/automations/AUT-99/edit", ROBERTA);
    await waitFor(() =>
      expect(document.querySelector('[data-not-visible="automation"]')).not.toBeNull(),
    );
    expect(document.querySelector('[data-not-visible="automation"]')!.textContent).toBe(hidden);
    expect(screen.queryByRole("tree")).toBeNull();
  });
});

describe("tastiera: aggiungere e riordinare", () => {
  it("A apre il menu dei passi, Enter crea il passo selezionato e già «Incomplete»; la bozza si salva da sola", async () => {
    await open("/automations/STW-A1/edit", LAURA);
    row("tr-classify").focus();
    await userEvent.keyboard("a");
    const menu = await screen.findByRole("dialog", { name: "Add a step" });
    await userEvent.type(within(menu).getByRole("combobox"), "notify");
    await userEvent.keyboard("{Enter}");
    await waitFor(() => expect(numbers()).toEqual([1, 2, 3]));
    const added = idsInOrder()[2]!;
    expect(rowText(added)).toContain("Notify");
    expect(screen.getByRole("heading", { name: /Step 3/ })).toBeInTheDocument();
    await waitFor(() => expect(row(added)).toHaveTextContent("Incomplete"));
    await settle();
    expect(savedFlow("STW-A1").steps.map((s) => s.kind)).toEqual(["claude", "notify"]);
    expect(document.querySelector("[data-save-status]")).toHaveTextContent("All changes saved");
  });

  it("Spazio prende, ↓ sposta entrando nella corsia, Spazio lascia; Esc rimette dov'era", async () => {
    await open("/automations/AUD-A1/edit");
    const before = idsInOrder();
    row("cd-ask").focus();
    await userEvent.keyboard(" ");
    await userEvent.keyboard("{ArrowDown}");
    await waitFor(() => expect(idsInOrder().slice(0, 2)).toEqual(["cd-wait", "cd-ask"]));
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(idsInOrder()).toEqual(before));

    row("cd-wait").focus();
    await userEvent.keyboard(" ");
    await userEvent.keyboard("{ArrowDown}");
    // Dentro «Repeat until», in testa alla sua corsia.
    await waitFor(() => expect(row("cd-wait").dataset.stepPath).toBe("1/repeat[0]/0"));
    await userEvent.keyboard(" ");
    await settle();
    const saved = savedFlow("AUD-A1");
    expect(saved.steps.map((s) => s.id)).toEqual(["cd-ask", "cd-reminders", "cd-replied"]);
  });

  it("⌥↓ sposta di uno, ⌘D duplica con «(copy)», ⌫ elimina con Undo", async () => {
    await open("/automations/AUT-1/edit");
    row("nc-milestone").focus();
    await userEvent.keyboard("{Alt>}{ArrowUp}{/Alt}");
    await waitFor(() => expect(idsInOrder().slice(0, 2)).toEqual(["nc-milestone", "nc-read"]));
    row("nc-milestone").focus();
    await userEvent.keyboard("{Meta>}d{/Meta}");
    await waitFor(() => expect(numbers()).toHaveLength(12));
    const copy = idsInOrder()[1]!;
    expect(rowText(copy)).toContain("(copy)");
    row(copy).focus();
    await userEvent.keyboard("{Backspace}");
    await waitFor(() => expect(numbers()).toHaveLength(11));
    await userEvent.click(await screen.findByRole("button", { name: "Undo" }));
    await waitFor(() => expect(numbers()).toHaveLength(12));
  });

  it("eliminare un blocco con passi dentro chiede conferma e nomina chi perde i dati", async () => {
    await open("/automations/AUT-1/edit");
    row("nc-read").focus();
    await userEvent.keyboard("{Delete}");
    const dialog = await screen.findByRole("dialog", { name: "Delete step 1?" });
    expect(dialog.querySelector("[data-delete-broken]")).toHaveTextContent(
      /Steps .* use data from it and will show a problem/,
    );
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(numbers()).toHaveLength(11);
  });
});

describe("dati disponibili", () => {
  it("spostare un passo prima di chi produce i suoi dati: gettone barrato e problema sulla riga e nel conteggio", async () => {
    await open("/automations/AUT-1/edit");
    expect(row("nc-milestone").querySelector("[data-unavailable]")).toBeNull();
    // Claude (passo 1) scende sotto il traguardo, che usa {{analisi.prodotto}}.
    row("nc-read").focus();
    await userEvent.keyboard("{Alt>}{ArrowDown}{/Alt}");
    await waitFor(() => expect(idsInOrder().slice(0, 2)).toEqual(["nc-milestone", "nc-read"]));
    const token = row("nc-milestone").querySelector<HTMLElement>(
      '[data-token="analisi.prodotto"]',
    )!;
    expect(token).toHaveAttribute("data-unavailable");
    expect(token.title).toBe("This data comes from step 2, which runs later or in another branch");
    await waitFor(() => expect(row("nc-milestone")).toHaveTextContent("Data not available"));
    expect(document.querySelector("[data-problem-count]")).toHaveTextContent(/problem/);
    // Nel pannello, sotto il campo: il nome del dato, mai la chiave.
    await userEvent.click(sentence("nc-milestone"));
    expect(
      within(screen.getByRole("region", { name: "Step 1" })).getByText(
        "Prodotto principale isn't available here",
      ),
    ).toBeInTheDocument();
    // Sotto il campo che lo cita, legato con aria-describedby.
    expect(screen.getByRole("textbox", { name: "Name" })).toHaveAccessibleDescription(
      "Prodotto principale isn't available here",
    );
    // Il titolo e Turn on/Publish sono chiusi col motivo.
    expect(document.querySelector("[data-primary-action]")).toBeDisabled();
  });
});

describe("bozza e versioni", () => {
  it("una bozza su un'automazione attiva non cambia la versione che gira né le esecuzioni in corso", async () => {
    const a = auto("AUT-1");
    const published = structuredClone(a.versions[0]!.flow);
    const runs = state.automationRuns.filter((r) => r.automationId === a.id);
    const before = runs.map((r) => ({
      id: r.id,
      version: r.version,
      status: r.status,
      cursor: r.cursor,
    }));
    await open("/automations/AUT-1/edit");
    row("nc-welcome").focus();
    await userEvent.keyboard("{Backspace}");
    await settle();
    expect(savedFlow("AUT-1").steps.map((s) => s.id)).not.toContain("nc-welcome");
    expect(a.versions[0]!.flow).toEqual(published);
    expect(a.versions[0]!.publishedAt).not.toBeNull();
    expect(a.status).toBe("active");
    expect(
      state.automationRuns
        .filter((r) => r.automationId === a.id)
        .map((r) => ({ id: r.id, version: r.version, status: r.status, cursor: r.cursor })),
    ).toEqual(before);
    for (const r of runs) {
      const run = await automationsApi.getRun(r.id);
      if (run) expect(run.flow).toEqual(published);
    }
  });

  it("su un'attiva senza bozza: aprire non crea niente; la prima modifica nasce come versione 2", async () => {
    await open("/automations/AUD-A1/edit");
    expect(auto("AUD-A1").versions).toHaveLength(1);
    expect(screen.getByText("Version 1 is on")).toBeInTheDocument();
    expect(document.querySelector("[data-primary-action]")).toBeDisabled();
    row("cd-ask").focus();
    await userEvent.keyboard("{Meta>}d{/Meta}");
    await settle();
    expect(auto("AUD-A1").versions).toHaveLength(2);
    expect(auto("AUD-A1").versions[0]!.publishedAt).not.toBeNull();
    expect(screen.getByText("Editing version 2 · version 1 is on")).toBeInTheDocument();
    expect(document.querySelector("[data-primary-action]")).toHaveTextContent("Publish version 2");
  });

  it("salvataggio fallito: «Couldn't save · Retry», poi riprova", async () => {
    await open("/automations/STW-A1/edit", LAURA);
    failNext("automations.saveDraft");
    row("tr-classify").focus();
    await userEvent.keyboard("{Meta>}d{/Meta}");
    await settle();
    const status = document.querySelector("[data-save-status]")!;
    expect(status).toHaveTextContent("Couldn't save");
    await userEvent.click(within(status as HTMLElement).getByRole("button", { name: "Retry" }));
    await settle();
    expect(document.querySelector("[data-save-status]")).toHaveTextContent("All changes saved");
    expect(savedFlow("STW-A1").steps).toHaveLength(2);
  });

  it("un altro ha cambiato la bozza: il salvataggio si ferma e chiede di ricaricare ([A 12])", async () => {
    await open("/automations/AUT-1/edit");
    const draft = auto("AUT-1").versions.at(-1)!;
    draft.savedById = ROBERTA;
    draft.savedAt = "2026-10-26T11:58:00Z";
    draft.rev = 9999;
    draft.flow = { ...draft.flow, titleTemplate: "Di Roberta" };
    row("nc-read").focus();
    await userEvent.keyboard("{Meta>}d{/Meta}");
    await settle();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      /Roberta Fontana changed this draft on Oct 26 11:58, after you opened it/,
    );
    expect(savedFlow("AUT-1").titleTemplate).toBe("Di Roberta");
    await userEvent.click(screen.getByRole("button", { name: "Reload" }));
    await waitFor(() => expect(numbers()).toHaveLength(11));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("Turn on senza averla provata: il dialogo lo dice e offre «Test first»", async () => {
    await open("/automations/STW-A1/edit", LAURA);
    const turnOn = document.querySelector<HTMLButtonElement>("[data-primary-action]")!;
    expect(turnOn).toHaveTextContent("Turn on");
    await userEvent.click(turnOn);
    const dialog = await screen.findByRole("dialog", { name: "Turn on STW-A1?" });
    expect(dialog.querySelector("[data-untested]")).toHaveTextContent(
      "You haven't tested this version yet.",
    );
    expect(within(dialog).getByRole("button", { name: "Test first" })).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Turn on" })).toBeEnabled();
  });
});

describe("persone dei passi", () => {
  it("avviso e task col dato Persona o un ruolo: frase coi gettoni, scelta nel pannello", async () => {
    const a = auto("STW-A1");
    const AUTO = { mode: "auto" } as const;
    a.versions[0]!.flow.steps.push(
      {
        id: "nr",
        kind: "notify",
        who: { personRef: "richiesta.richiedente" },
        text: "Ciao",
        approval: AUTO,
      },
      {
        id: "nl",
        kind: "notify",
        who: { projectRole: "project_lead" },
        text: "Ciao",
        approval: AUTO,
      },
    );
    await open("/automations/STW-A1/edit", LAURA);
    expect(row("nr").querySelector('[data-token="richiesta.richiedente"]')).not.toBeNull();
    expect(rowText("nl")).toContain("the project's Project Lead");
    await userEvent.click(sentence("nr"));
    const picker = screen.getByRole("combobox", { name: "Who" });
    expect(picker).toHaveValue("ref:richiesta.richiedente");
    await userEvent.selectOptions(picker, "id:p-laura");
    await waitFor(() => expect(rowText("nr")).toContain("Laura Costa"));
    await settle();
    expect(savedFlow("STW-A1").steps.find((s) => s.id === "nr")).toMatchObject({
      who: { personId: "p-laura" },
    });
  });
});

describe("problemi di configurazione", () => {
  it("un avvio di sé stessa è un problema sulla riga e sul campo ([A 16])", async () => {
    const a = auto("STW-A1");
    a.versions[0]!.flow.steps.push({
      id: "self",
      kind: "startAutomation",
      automationId: a.id,
      approval: { mode: "auto" },
    });
    await open("/automations/STW-A1/edit", LAURA);
    await waitFor(() => expect(row("self")).toHaveTextContent("Would start itself again"));
    await userEvent.click(sentence("self"));
    expect(screen.getByText("This would start itself again.")).toBeInTheDocument();
    expect(document.querySelector("[data-primary-action]")).toBeDisabled();
  });

  it("F8 porta al problema successivo e lo seleziona", async () => {
    const a = auto("STW-A1");
    a.versions[0]!.flow.steps.push(
      { id: "x1", kind: "notify", who: { personId: "" }, text: "", approval: { mode: "auto" } },
      {
        id: "x2",
        kind: "createMilestone",
        name: "",
        dueInDays: null,
        project: { mode: "own" },
        approval: { mode: "auto" },
      },
    );
    await open("/automations/STW-A1/edit", LAURA);
    await waitFor(() =>
      expect(document.querySelector("[data-problem-count]")).toHaveTextContent("2 problems"),
    );
    fireEvent.keyDown(window, { key: "F8" });
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: /Step 3/ })).toBeInTheDocument(),
    );
    fireEvent.keyDown(window, { key: "F8" });
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: /Step 4/ })).toBeInTheDocument(),
    );
    expect(screen.getByText("Incomplete: write the name")).toBeInTheDocument();
  });
});

/** Un flusso con 40 passi e rami su 5 livelli (Review Focus 5). */
function bigFlow(): Step[] {
  let n = 0;
  const task = (): Step => ({
    id: `t${++n}`,
    kind: "createTask",
    title: `Task numero ${n} con un titolo abbastanza lungo da andare a capo nella riga`,
    description: "",
    assignee: { projectRole: "project_lead" },
    dueInDays: 2,
    project: { mode: "own" },
    milestoneRef: null,
    approval: { mode: "auto" },
  });
  const cond = (id: string, then: Step[]): Step => ({
    id,
    kind: "condition",
    when: { left: { ref: "richiesta.titolo" }, op: "not_empty" },
    then,
    else: [],
  });
  // 5 livelli: c1 › c2 › c3 › c4 › c5 › task
  const deep = cond("c1", [cond("c2", [cond("c3", [cond("c4", [cond("c5", [task()])])])])]);
  const steps: Step[] = [deep];
  while (steps.length < 35) steps.push(task());
  return steps;
}

describe("Review Focus 5: contenuti estremi", () => {
  const LONG =
    "Smistamento delle richieste dei clienti con verifica dei dati, avvisi ai reparti e promemoria settimanali per chi non ha risposto";

  beforeEach(() => {
    const a = auto("STW-A1");
    a.name = LONG;
    a.versions[0]!.flow.steps = bigFlow();
  });

  it("40 passi, 5 livelli, nome lunghissimo: numeri 1…40, nome intero, tutto in pagina", async () => {
    await open("/automations/STW-A1/edit", LAURA);
    let count = 0;
    visitSteps(auto("STW-A1").versions[0]!.flow.steps, () => (count += 1));
    expect(count).toBe(40);
    expect(numbers()).toEqual(Array.from({ length: 40 }, (_, i) => i + 1));
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(LONG);
    // Il quinto livello: la riga ha livello 6 (l'inizio e i principali sono 1 e 2… il task in c5 è a 7).
    expect(row("t1")).toHaveAttribute("aria-level", "7");
  });

  it("dentro una corsia di quinto livello il «+» non offre i tipi con rami e lo spiega", async () => {
    await open("/automations/STW-A1/edit", LAURA);
    const lane = tree().querySelector<HTMLElement>(
      '[data-add-step="0/then/0/then/0/then/0/then/0/then"]',
    )!;
    await userEvent.click(lane);
    const menu = await screen.findByRole("dialog", { name: "Add a step" });
    expect(within(menu).queryByRole("option", { name: /If… otherwise/ })).toBeNull();
    expect(within(menu).queryByRole("option", { name: /For each/ })).toBeNull();
    expect(within(menu).getByRole("option", { name: /Create a task/ })).toBeInTheDocument();
    expect(within(menu).getByText("Branches can go 5 levels deep.")).toBeInTheDocument();
    // Al quarto livello si possono ancora aprire rami.
    await userEvent.keyboard("{Escape}");
    await userEvent.click(
      tree().querySelector<HTMLElement>('[data-add-step="0/then/0/then/0/then/0/then"]')!,
    );
    expect(
      within(await screen.findByRole("dialog", { name: "Add a step" })).getByRole("option", {
        name: /If… otherwise/,
      }),
    ).toBeInTheDocument();
  });

  it("oltre il terzo livello il pannello dice in testa dove sta il passo", async () => {
    await open("/automations/STW-A1/edit", LAURA);
    await userEvent.click(sentence("t1"));
    const trail = document.querySelector("[data-step-trail]")!;
    expect(trail.textContent).toMatch(/^Inside: If .* › If .* › If .* › If .* › If /);
  });
});

describe("New automation e modelli", () => {
  it("il modello apre il costruttore con sorgente, approvatori e reparti da completare", async () => {
    const router = await openList();
    await userEvent.click(screen.getAllByRole("button", { name: "New automation" })[0]!);
    const dialog = await screen.findByRole("dialog", { name: "New automation" });
    await userEvent.click(
      within(dialog).getByRole("radio", { name: /New contract → tasks for every department/ }),
    );
    expect(within(dialog).getByRole("textbox", { name: "Name" })).toHaveValue(
      "New contract → tasks for every department",
    );
    await userEvent.click(within(dialog).getByRole("button", { name: "Create" }));
    await screen.findByRole("tree");
    expect(router.state.location.pathname).toMatch(/^\/automations\/AUT-\d+\/edit$/);
    expect(row("trigger")).toHaveTextContent("Choose how this starts");
    // Arrivati dall'elenco: il ritorno è «← Automations».
    expect(document.querySelector("[data-back-link]")).toHaveTextContent("← Automations");
    await waitFor(() =>
      expect(document.querySelector("[data-problem-count]")?.textContent).toMatch(/\d+ problems/),
    );
    expect(row("nc-welcome")).toHaveTextContent("Asks the owner");
    expect(tree().textContent).not.toMatch(/Matteo|Roberta|Laura/);
  });

  it("i numeri di passi dei modelli sono quelli dei flussi", () => {
    for (const k of ["newContract", "askClient"] as const) {
      let n = 0;
      visitSteps(templateFlow(k).steps, () => (n += 1));
      expect(TEMPLATE_STEPS[k]).toBe(n);
    }
  });
});

describe("revisione del Task 6, giro 1", () => {
  async function switchPersona(name: RegExp) {
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Profile and settings" }));
    const menu = await screen.findByRole("dialog", { name: "Profile and settings" });
    await user.click(within(menu).getByRole("radio", { name }));
  }

  it("rinominare un'uscita per indice: un nome vuoto, di sole cifre o già usato non tocca i rami", async () => {
    await open("/automations/AUD-A1/edit");
    const before = idsInOrder();
    await userEvent.click(sentence("cd-verify"));
    const first = screen.getByRole("textbox", { name: "Name of outcome 1" });
    for (const [value, problem] of [
      ["", "An outcome needs a name"],
      ["42", "Use at least one letter"],
      ["mancano informazioni", "Another outcome already has this name"],
    ] as const) {
      fireEvent.change(first, { target: { value } });
      expect(first).toHaveValue(value);
      expect(first).toHaveAccessibleDescription(`${problem} — it stays “tutto presente” for now.`);
      // I due rami restano con i loro passi e i loro nomi.
      expect(idsInOrder()).toEqual(before);
      expect(tree()).toHaveTextContent("If Claude says “tutto presente”");
      expect(tree()).toHaveTextContent("If Claude says “mancano informazioni”");
    }
    fireEvent.change(first, { target: { value: "tutto ok" } });
    expect(tree()).toHaveTextContent("If Claude says “tutto ok”");
    expect(idsInOrder()).toEqual(before);
    await settle();
    const verify = savedFlow("AUD-A1").steps[3]!;
    expect(verify).toMatchObject({ kind: "condition" });
    const claude = (verify as Extract<Step, { kind: "condition" }>).then[0] as Extract<
      Step,
      { kind: "claude" }
    >;
    expect(claude.outcomes).toEqual(["tutto ok", "mancano informazioni"]);
    expect(claude.branches["tutto ok"]!.map((s) => s.id)).toEqual(["cd-activate"]);
    expect(claude.branches["mancano informazioni"]).toHaveLength(3);
  });

  it("salvataggio fallito o fermato: Test e Publish chiusi col motivo, il dialogo non si apre", async () => {
    await open("/automations/AUT-1/edit");
    failNext("automations.saveDraft");
    row("nc-read").focus();
    await userEvent.keyboard("{Meta>}d{/Meta}");
    await settle();
    const primary = document.querySelector<HTMLButtonElement>("[data-primary-action]")!;
    expect(primary).toBeDisabled();
    expect(primary.title).toBe("Save first: your latest changes aren't saved");
    expect(screen.getByRole("button", { name: "Test" })).toBeDisabled();
    // Riprovato, si riaprono.
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    await settle();
    expect(primary).toBeEnabled();
    // Un altro salva: fermo, chiuso col motivo «Reload first».
    const draft = auto("AUT-1").versions.at(-1)!;
    draft.savedById = ROBERTA;
    draft.rev = 9999;
    row("nc-read").focus();
    await userEvent.keyboard("{Meta>}d{/Meta}");
    await settle();
    expect(primary).toBeDisabled();
    expect(primary.title).toBe("Reload first: someone else changed this draft");
    await userEvent.click(primary).catch(() => {});
    expect(screen.queryByRole("dialog", { name: /Publish version/ })).toBeNull();
  });

  it("il dialogo di Publish si apre solo dopo un salvataggio riuscito", async () => {
    await open("/automations/AUT-1/edit");
    row("nc-read").focus();
    await userEvent.keyboard("{Meta>}d{/Meta}");
    // Senza aspettare: il clic salva prima, poi apre.
    failNext("automations.saveDraft");
    await userEvent.click(document.querySelector<HTMLButtonElement>("[data-primary-action]")!);
    await settle();
    expect(screen.queryByRole("dialog", { name: /Publish version 2/ })).toBeNull();
    expect(document.querySelector("[data-save-status]")).toHaveTextContent("Couldn't save");
  });

  it("rinominare non crea una bozza; «Undo» di Discard rimette la bozza e ricarica", async () => {
    await open("/automations/AUD-A1/edit");
    await userEvent.click(screen.getByRole("button", { name: "More actions" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Rename and describe" }));
    const dialog = await screen.findByRole("dialog", { name: "Rename and describe" });
    const name = within(dialog).getByRole("textbox", { name: "Name" });
    await userEvent.clear(name);
    await userEvent.type(name, "Dati dal cliente");
    await userEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(auto("AUD-A1").name).toBe("Dati dal cliente"));
    expect(auto("AUD-A1").versions).toHaveLength(1);
    expect(screen.getByText("Version 1 is on")).toBeInTheDocument();

    // AUT-1 ha la bozza v2: buttata, poi rimessa con «Undo».
    clearToasts();
    document.body.innerHTML = "";
    await open("/automations/AUT-1/edit");
    const draft = structuredClone(savedFlow("AUT-1"));
    await userEvent.click(screen.getByRole("button", { name: "More actions" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Discard this draft" }));
    await userEvent.click(
      within(await screen.findByRole("dialog", { name: "Discard this draft?" })).getByRole(
        "button",
        { name: "Discard this draft" },
      ),
    );
    await waitFor(() => expect(screen.getByText("Version 1 is on")).toBeInTheDocument());
    expect(auto("AUT-1").versions).toHaveLength(1);
    await userEvent.click(await screen.findByRole("button", { name: "Undo" }));
    await waitFor(() =>
      expect(screen.getByText("Editing version 2 · version 1 is on")).toBeInTheDocument(),
    );
    expect(savedFlow("AUT-1")).toEqual(draft);
    // Ricaricato sulla bozza rimessa: un'altra modifica salva senza fermarsi.
    row("nc-read").focus();
    await userEvent.keyboard("{Meta>}d{/Meta}");
    await settle();
    expect(document.querySelector("[data-save-status]")).toHaveTextContent("All changes saved");
  });

  it("cambiare persona con una modifica in coda: la salva chi l'ha fatta, mai la persona nuova", async () => {
    await open("/automations/AUT-1/edit");
    row("nc-read").focus();
    await userEvent.keyboard("{Meta>}d{/Meta}");
    // Dentro i 400 ms del salvataggio.
    await switchPersona(/Roberta/);
    await settle();
    await act(() => automationsApi.whenAutomationsIdle());
    const draft = auto("AUT-1").versions.at(-1)!;
    expect(draft.savedById).toBe(MATTEO);
    expect(draft.flow.steps.map((s) => s.id)).toHaveLength(5);
  });

  it("il fuoco dopo ⌫ va alla riga dopo (o prima, o «When»); dopo Undo sulla riga rimessa; ⌘D e ⌥↓ lo tengono sul passo", async () => {
    await open("/automations/AUD-A1/edit");
    // L'ultima attesa dei promemoria: dopo di lei viene la corsia «When the limit is reached».
    row("cd-remind-wait").focus();
    await userEvent.keyboard("{Backspace}");
    await waitFor(() => expect(document.activeElement).toBe(row("cd-call")));
    // Il fuoco itinerante è sulla riga nuova: Tab ci torna.
    expect(row("cd-call")).toHaveAttribute("tabindex", "0");
    await userEvent.click(await screen.findByRole("button", { name: "Undo" }));
    await waitFor(() => expect(document.activeElement).toBe(row("cd-remind-wait")));
    expect(row("cd-remind-wait").dataset.stepPath).toBe("2/repeat[0]/1");
    // L'ultimo passo principale: il fuoco va a quello prima (fuori dal suo blocco).
    row("cd-replied").focus();
    await userEvent.keyboard("{Delete}");
    await userEvent.click(
      within(await screen.findByRole("dialog", { name: /Delete step 7/ })).getByRole("button", {
        name: "Delete",
      }),
    );
    await waitFor(() => expect(document.activeElement).toBe(row("cd-call")));
    row("cd-wait").focus();
    await userEvent.keyboard("{Meta>}d{/Meta}");
    const copy = idsInOrder()[2]!;
    await waitFor(() => expect(document.activeElement).toBe(row(copy)));
    await userEvent.keyboard("{Alt>}{ArrowUp}{/Alt}");
    await waitFor(() => expect(document.activeElement).toBe(row(copy)));
    expect(row(copy).dataset.stepPath).toBe("1");
  });

  it("solo un passo: eliminato, il fuoco va a «When»", async () => {
    await open("/automations/BTG-A1/edit", ROBERTA);
    row("wk-report").focus();
    await userEvent.keyboard("{Backspace}");
    await waitFor(() => expect(document.activeElement).toBe(row("trigger")));
  });

  it("Undo rimette il passo nella sua corsia, nel flusso di adesso (le altre modifiche restano)", async () => {
    await open("/automations/AUD-A1/edit");
    row("cd-remind-wait").focus();
    await userEvent.keyboard("{Backspace}");
    row("cd-ask").focus();
    await userEvent.keyboard("{Meta>}d{/Meta}");
    await userEvent.click(await screen.findByRole("button", { name: "Undo" }));
    await waitFor(() => expect(row("cd-remind-wait").dataset.stepPath).toBe("3/repeat[0]/1"));
    // La copia fatta dopo l'eliminazione è ancora lì.
    expect(idsInOrder()).toHaveLength(15);
  });

  it("un'email dentro un «Per ogni» è un avviso sul limite delle 20, non un problema", async () => {
    const flow = auto("AUT-1").versions.at(-1)!.flow;
    const each = flow.steps[2] as Extract<Step, { kind: "forEach" }>;
    each.steps.push({ ...structuredClone(flow.steps[3]!), id: "loop-mail" });
    await open("/automations/AUT-1/edit");
    expect(row("loop-mail").querySelector("[data-row-warning]")).toHaveTextContent(
      "Up to 20 emails per run",
    );
    expect(row("nc-welcome").querySelector("[data-row-warning]")).toBeNull();
    expect(document.querySelector("[data-problem-count]")).toBeNull();
    await userEvent.click(sentence("loop-mail"));
    expect(document.querySelector("[data-email-limit]")).toHaveTextContent(
      "a run sends at most 20 emails",
    );
  });

  it("Claude senza uscite non ha chevron e prosegue in riga; la colonna evidenzia l'automazione aperta", async () => {
    await open("/automations/AUT-1/edit");
    expect(within(row("nc-read")).queryByRole("button", { name: /branches/ })).toBeNull();
    expect(row("nc-read")).not.toHaveAttribute("aria-expanded");
    const column = screen.getByRole("navigation", { name: "Automations views" });
    expect(within(column).getByRole("link", { name: /AUT-1/ })).toHaveAttribute(
      "aria-current",
      "page",
    );
  });

  it("sotto i 1200 px la colonna si chiude nel costruttore", async () => {
    setMatchMedia(DOCKED_PANEL_QUERY, false);
    await open("/automations/AUT-1/edit");
    expect(document.querySelector('[data-column="closed"]')).not.toBeNull();
    expect(screen.queryByRole("navigation", { name: "Automations views" })).toBeNull();
  });

  it("«Move to…» parte dal posto di adesso", async () => {
    await open("/automations/AUD-A1/edit");
    row("cd-wait").focus();
    await userEvent.click(
      within(row("cd-wait")).getByRole("button", { name: "Actions for step 2" }),
    );
    await userEvent.click(screen.getByRole("menuitem", { name: /Move to/ }));
    const dialog = await screen.findByRole("dialog", { name: "Move step 2" });
    expect(within(dialog).getByRole("combobox", { name: "Into" })).toHaveValue("main");
    expect(within(dialog).getByRole("combobox", { name: "Position" })).toHaveValue("cd-ask");
  });

  it("F8 e ⌘S tacciono con un dialogo aperto", async () => {
    auto("STW-A1").versions[0]!.flow.steps.push({
      id: "x1",
      kind: "notify",
      who: { personId: "" },
      text: "",
      approval: { mode: "auto" },
    });
    await open("/automations/STW-A1/edit", LAURA);
    await waitFor(() => expect(document.querySelector("[data-problem-count]")).not.toBeNull());
    await userEvent.click(screen.getByRole("button", { name: "More actions" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Rename and describe" }));
    await screen.findByRole("dialog", { name: "Rename and describe" });
    fireEvent.keyDown(window, { key: "F8" });
    await act(() => new Promise((r) => requestAnimationFrame(r)));
    expect(screen.queryByRole("heading", { name: /Step 3/ })).toBeNull();
    await userEvent.keyboard("{Escape}");
    fireEvent.keyDown(window, { key: "F8" });
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: /Step 3/ })).toBeInTheDocument(),
    );
  });

  it("«Fix» dal dettaglio apre il passo della bozza per id", async () => {
    const a = auto("AUT-1");
    // Nella bozza il benvenuto è senza oggetto (problema), e la bozza ha un passo in più in testa.
    const draft = a.versions.at(-1)!.flow;
    (draft.steps[3] as Extract<Step, { kind: "sendEmail" }>).subject = "";
    draft.steps.unshift({ id: "extra", kind: "wait", for: { days: 1 } });
    const router = renderRoute("/automations/AUT-1", MATTEO);
    const fix = await screen.findByRole("link", { name: "Fix" });
    await userEvent.click(fix);
    await screen.findByRole("tree");
    expect(router.state.location.search).toMatchObject({ step: "nc-welcome" });
    expect(screen.getByRole("heading", { name: /Step 12/ })).toBeInTheDocument();
  });

  it("i numeri 1…N sono gli stessi nel dettaglio («How it works») e nel costruttore", async () => {
    renderRoute("/automations/AUT-1", MATTEO);
    const summary = await waitFor(() => {
      const el = document.querySelector<HTMLElement>("[data-flow-summary]");
      if (!el) throw new Error("summary");
      return el;
    });
    await userEvent.click(within(summary).getByRole("button", { name: "Expand all" }));
    const nums = [...summary.querySelectorAll("[data-flow-step] > div .num")].map(
      (n) => n.textContent,
    );
    expect(nums).toEqual(Array.from({ length: 11 }, (_, i) => String(i + 1)));
  });

  it("«Start from»: un gruppo di radio con le frecce", async () => {
    await openList();
    await userEvent.click(screen.getAllByRole("button", { name: "New automation" })[0]!);
    const dialog = await screen.findByRole("dialog", { name: "New automation" });
    const blank = within(dialog).getByRole("radio", { name: /Blank automation/ });
    expect(blank).toHaveAttribute("aria-checked", "true");
    expect(blank).toHaveAttribute("tabindex", "0");
    blank.focus();
    await userEvent.keyboard("{ArrowDown}");
    const contract = within(dialog).getByRole("radio", { name: /New contract/ });
    expect(contract).toHaveAttribute("aria-checked", "true");
    await waitFor(() => expect(document.activeElement).toBe(contract));
    expect(blank).toHaveAttribute("tabindex", "-1");
  });
});

describe("revisione del Task 6, giro 2", () => {
  const notify = (id: string): Step => ({
    id,
    kind: "notify",
    who: { personId: "p-laura" },
    text: "x",
    approval: { mode: "auto" },
  });

  it("eliminato st-3, aggiunto un passo, Undo: id tutti diversi e flusso valido", async () => {
    auto("STW-A1").versions[0]!.flow.steps = [notify("st-1"), notify("st-2"), notify("st-3")];
    await open("/automations/STW-A1/edit", LAURA);
    row("st-3").focus();
    await userEvent.keyboard("{Backspace}");
    await waitFor(() => expect(idsInOrder()).toEqual(["st-1", "st-2"]));
    row("st-2").focus();
    await userEvent.keyboard("a");
    const menu = await screen.findByRole("dialog", { name: "Add a step" });
    await userEvent.type(within(menu).getByRole("combobox"), "notify");
    await userEvent.keyboard("{Enter}");
    await waitFor(() => expect(idsInOrder()).toHaveLength(3));
    const added = idsInOrder()[2]!;
    expect(added).not.toBe("st-3");
    await userEvent.click(await screen.findByRole("button", { name: "Undo" }));
    await waitFor(() => expect(idsInOrder()).toHaveLength(4));
    const all = idsInOrder();
    expect(new Set(all).size).toBe(4);
    await settle();
    const saved: string[] = [];
    visitSteps(savedFlow("STW-A1").steps, (s) => saved.push(s.id));
    expect(new Set(saved).size).toBe(4);
    const issues = await act(() =>
      automationsApi.checkDraft(auto("STW-A1").id, savedFlow("STW-A1")),
    );
    expect(issues.filter((i) => i.message.includes("identificativo"))).toEqual([]);
  });

  it("con la fascia «stale» Discard è spento; ⌘S annuncia solo se ha salvato", async () => {
    await open("/automations/AUT-1/edit");
    failNext("automations.saveDraft");
    row("nc-read").focus();
    await userEvent.keyboard("{Meta>}d{/Meta}");
    fireEvent.keyDown(window, { key: "s", metaKey: true });
    await settle();
    expect(document.querySelector("[data-builder-live]")!.textContent).not.toBe(
      "All changes saved",
    );
    const draft = auto("AUT-1").versions.at(-1)!;
    draft.savedById = ROBERTA;
    draft.rev = 9999;
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    await settle();
    expect(await screen.findByRole("alert")).toHaveTextContent("Roberta Fontana");
    await userEvent.click(screen.getByRole("button", { name: "More actions" }));
    expect(screen.getByRole("menuitem", { name: "Discard this draft" })).toBeDisabled();
  });

  it("Test aspetta il salvataggio: se non riesce resta qui, con l'errore", async () => {
    const router = await open("/automations/AUT-1/edit");
    row("nc-read").focus();
    await userEvent.keyboard("{Meta>}d{/Meta}");
    failNext("automations.saveDraft");
    await userEvent.click(document.querySelector<HTMLButtonElement>("[data-test-action]")!);
    await settle();
    expect(router.state.location.pathname).toBe("/automations/AUT-1/edit");
    expect(document.querySelector("[data-save-status]")).toHaveTextContent("Couldn't save");
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    await settle();
    await userEvent.click(document.querySelector<HTMLButtonElement>("[data-test-action]")!);
    await waitFor(() => expect(router.state.location.pathname).toBe("/automations/AUT-1/test"));
  });

  it("in un'automazione generale l'avviso non offre «un ruolo», e un ruolo già scelto è un problema", async () => {
    const flow = auto("AUT-1").versions.at(-1)!.flow;
    flow.steps.push(notify("n-person"), {
      ...notify("n-role"),
      who: { projectRole: "project_lead" },
    } as Step);
    await open("/automations/AUT-1/edit");
    await userEvent.click(sentence("n-person"));
    const who = screen.getByRole("radiogroup", { name: "Who" });
    expect(within(who).queryByRole("radio", { name: "A role in the project" })).toBeNull();
    await waitFor(() => expect(row("n-role")).toHaveTextContent("Incomplete"));
    await userEvent.click(sentence("n-role"));
    expect(
      screen.getByText("A general automation has no project: notify a person"),
    ).toBeInTheDocument();
  });

  it("un'uscita non può chiamarsi «__proto__»: resta il nome di prima, rami intatti", async () => {
    await open("/automations/AUD-A1/edit");
    const before = idsInOrder();
    await userEvent.click(sentence("cd-verify"));
    const first = screen.getByRole("textbox", { name: "Name of outcome 1" });
    for (const value of ["__proto__", "constructor"]) {
      fireEvent.change(first, { target: { value } });
      expect(first).toHaveAccessibleDescription(
        "This name is reserved: choose another — it stays “tutto presente” for now.",
      );
      expect(idsInOrder()).toEqual(before);
    }
  });
});

async function openList() {
  const router = renderRoute("/automations", ROBERTA);
  await screen.findByRole("heading", { level: 1, name: "Automations" });
  return router;
}
