import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { automations as automationsApi, failNext, resetApi, setLatency } from "../../../data/api";
import { setSessionPersonId } from "../../../data/session";
import { state } from "../../../data/store";
import type { AutomationFlow } from "../../../data/types";
import { grantProjectRole, resetViewerGrants } from "../../../data/viewer";
import { DOCKED_PANEL_QUERY } from "../../../layout/useDetailPanel";
import { REDUCED_MOTION_QUERY } from "../../../layout/useMediaQuery";
import { clearToasts } from "../../../tasks-ui/Toast";
import { renderRoute } from "../../../test/renderRoute";
import { setMatchMedia } from "../../../test/setup";

// La prova di un'automazione (Task 7, shape automation-test.md). Persone del
// seme: Matteo (proprietario di AUT-1 e AUD-A1, ha la casella), Roberta
// (admin), Giulia (resa Viewer di AUD). AUT-1 ha una bozza della versione 2;
// AUD-A1 è accesa senza bozza.

const MATTEO = "p-matteo";
const GIULIA = "p-giulia";
const auto = (code: string) => state.automations.find((a) => a.code === code)!;
const AUTO = { mode: "auto" } as const;

/** Tutto lo stato del prototipo tranne la sola traccia ammessa di una prova (R-J19). */
const bare = () => {
  const s = structuredClone(state);
  for (const a of s.automations) for (const v of a.versions) delete v.testedRev;
  return s;
};

const band = () => screen.getByRole("note", { name: "Test" });
const flow = () => document.querySelector<HTMLElement>("[data-test-flow]")!;
const row = (path: string) => flow().querySelector<HTMLElement>(`[data-test-row="${path}"]`)!;
const rowMark = (path: string) =>
  flow().querySelector<HTMLElement>(`[data-step-path="${path}"]`)?.dataset.mark;
const panel = () => document.querySelector<HTMLElement>("[data-test-panel]")!;
const next = () => document.querySelector<HTMLButtonElement>("[data-next-step]")!;
const runToStop = () => document.querySelector<HTMLButtonElement>("[data-run-to-stop]")!;

async function open(path: string, personId = MATTEO) {
  const router = renderRoute(path, personId);
  await screen.findByRole("heading", { level: 1 });
  return router;
}

/** Sceglie l'esempio (il primo recente, o quello indicato) e avvia la prova. */
async function startWith(index = 0) {
  const dialog = await screen.findByRole("dialog", { name: "Choose an example" });
  const radios = await within(dialog).findAllByRole("radio");
  await userEvent.click(radios[index]!);
  await userEvent.click(within(dialog).getByRole("button", { name: "Start test" }));
  await waitFor(() => expect(document.querySelector("[data-example-line]")).not.toBeNull());
}

beforeEach(() => {
  setLatency(0);
  resetApi();
  setMatchMedia(DOCKED_PANEL_QUERY, true);
  // Il ritmo di «Run to next stop» e lo streaming di Claude: nulla con movimento ridotto.
  setMatchMedia(REDUCED_MOTION_QUERY, true);
});
afterEach(() => {
  resetViewerGrants();
  clearToasts();
});

describe("la prova, da cima a fondo", () => {
  it("AUT-1: fascia di prova, stesso elenco numerato, si ferma subito, anteprime al condizionale, approvazione nella prova, poi «Publish»", async () => {
    await open("/automations/AUT-1/test");
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Test: Nuovo contratto");
    expect(band()).toHaveTextContent(
      "Nothing here is real. No tasks, emails or notifications are created.",
    );
    // Gli esempi recenti di Audin, il più recente in alto.
    const dialog = await screen.findByRole("dialog", { name: "Choose an example" });
    const radios = await within(dialog).findAllByRole("radio");
    expect(radios).toHaveLength(3);
    expect(radios[0]).toHaveTextContent("Forneria Rossi & Lari");
    expect(radios[2]).toHaveTextContent("Cantina Bellavista Srl");
    expect(radios[2]).toHaveTextContent("Contratto AUD-TR-1042.pdf");
    await startWith(2);
    expect(screen.getByText("Version 2 (draft)")).toBeInTheDocument();
    expect(document.querySelector("[data-example-line]")).toHaveTextContent(
      "Cantina Bellavista Srl",
    );

    // Lo stesso elenco del costruttore, 1…N; non corre da solo: il passo 1 è il corrente.
    const nums = [...flow().querySelectorAll("[data-step-path] > [data-test-row] .num")].map((n) =>
      Number(n.textContent),
    );
    expect(nums.slice(0, 4)).toEqual([1, 2, 3, 4]);
    expect(rowMark("0")).toBe("current");
    expect(row("0")).toHaveAccessibleName(/Step 1, Claude reads and decides, Current step/);
    expect(rowMark("1")).toBe("pending");
    expect(document.querySelector("[data-finish-action]")).toBeNull();

    // Next step: Claude sceglie, con la motivazione, i campi e cosa ha letto.
    await userEvent.click(next());
    await waitFor(() => expect(rowMark("0")).toBe("done"));
    await userEvent.click(row("0"));
    expect(within(panel()).getByText("Why")).toBeInTheDocument();
    expect(within(panel()).getByText(/Ho letto il contratto/)).toBeInTheDocument();
    expect(within(panel()).getByText(/Contratto AUD-TR-1042\.pdf/)).toBeInTheDocument();
    await userEvent.click(within(panel()).getByRole("button", { name: /Back to current step/ }));

    // Il traguardo, al condizionale, senza codice.
    expect(within(panel()).getByText(/Would create a milestone in CBV/)).toBeInTheDocument();
    expect(within(panel()).getByText("New milestone")).toBeInTheDocument();

    // Run to next stop: si ferma all'approvazione dell'email, e dice chi approverebbe davvero.
    await userEvent.click(runToStop());
    await waitFor(() => expect(document.querySelector("[data-real-approver]")).not.toBeNull());
    expect(document.querySelector("[data-real-approver]")).toHaveTextContent(
      "A real run would stop here until the owner approves. After you turn it on, that's you.",
    );
    expect(next()).toBeDisabled();
    expect(runToStop()).toBeDisabled();
    expect(screen.getByRole("alert", { hidden: true })).toHaveTextContent(/Stopped at step \d+/);
    const approve = within(panel()).getByRole("button", { name: "Approve in the test" });
    await waitFor(() => expect(approve).toHaveFocus());
    expect(within(panel()).getByText("Would send an email")).toBeInTheDocument();
    expect(
      within(panel()).getByText(/From your mailbox — .*because you'd be the owner/),
    ).toBeInTheDocument();
    expect(document.querySelector("[data-so-far]")).toHaveTextContent(
      "So far: would create 1 milestone, 4 tasks",
    );
    // «Turn on» mai a metà prova, nemmeno a una fermata.
    expect(document.querySelector("[data-finish-action]")).toBeNull();

    await userEvent.click(approve);
    await waitFor(() => expect(next()).toBeEnabled());
    // Approvato a nome di chi prova, mai dell'approvatore vero ([A 8]).
    const emailRow = flow().querySelector<HTMLElement>('[data-mark="current"]')!;
    await userEvent.click(next());
    await waitFor(() => expect(document.querySelector("[data-test-final]")).not.toBeNull());
    expect(emailRow).toHaveTextContent("Approved in the test by you");

    const final = document.querySelector<HTMLElement>("[data-test-final]")!;
    expect(final).toHaveTextContent("If this were real");
    expect(final).toHaveTextContent("Would create");
    expect(final).toHaveTextContent("Would send");
    expect(final).toHaveTextContent(
      "Benvenuti, Cantina Bellavista Srl: i prossimi passi con Audin",
    );
    expect(final).toHaveTextContent("Would wait for approval — Matteo");
    expect(within(final).getAllByText("New task")).toHaveLength(4);
    // Nessun codice inventato da nessuna parte ([A 9]).
    expect(document.body.textContent).not.toMatch(/CBV-\d+/);
    // Solo adesso: «Publish version 2».
    expect(document.querySelector("[data-finish-action]")).toHaveTextContent("Publish version 2");
    expect(document.querySelector("[data-test-again]")).not.toBeNull();
  });

  it("dopo una prova completa nessun effetto vero: né store, né Posta, né Home, né notifiche", async () => {
    const before = bare();
    const router = await open("/automations/AUT-1/test");
    await startWith(2);
    await userEvent.click(runToStop());
    await userEvent.click(
      await within(panel()).findByRole("button", { name: "Approve in the test" }),
    );
    await waitFor(() => expect(next()).toBeEnabled());
    await userEvent.click(next());
    await screen.findByText("If this were real");
    // La prova non lascia traccia: lo stato è identico (testedRev a parte, R-J19).
    await act(() => automationsApi.whenAutomationsIdle());
    expect(bare()).toEqual(before);

    // Posta: l'email che la prova manderebbe non c'è (nel seme non ce n'è nessuna con quell'oggetto).
    const subject = "Benvenuti, Cantina Bellavista Srl: i prossimi passi con Audin";
    const seeded = state.mailMessages.filter((m) => m.subject === subject).length;
    expect(seeded).toBe(0);
    await act(() => router.navigate({ to: "/mail" } as never));
    await screen.findByRole("heading", { level: 1 });
    await screen.findByText("Quick question on the dialer pricing");
    expect(document.body.textContent!.split(subject).length - 1).toBe(seeded);
    // Home: nessuna task «Importare l'anagrafica clienti nel CRM».
    await act(() => router.navigate({ to: "/" } as never));
    await screen.findByRole("heading", { level: 1 });
    expect(document.body.textContent).not.toContain("Importare l'anagrafica clienti nel CRM");
    // Notifiche: il pannello non ha niente dalla prova.
    await userEvent.click(screen.getByRole("button", { name: /Notifications/ }));
    expect(document.body.textContent).not.toContain(subject);
    expect(document.body.textContent).not.toContain("Attivazione CRM – Cantina Bellavista Srl");
  });
});

/** Un'automazione di AUD su Audin con un «Per ogni» sui prodotti venduti, e un esempio di `count` prodotti. */
async function loopAutomation(count: number) {
  setSessionPersonId(MATTEO);
  const flow: AutomationFlow = {
    trigger: { kind: "source", sourceId: "src-audin", event: "deal_won" },
    titleTemplate: "Prodotti",
    steps: [
      {
        id: "each",
        kind: "forEach",
        list: "trattativa.prodotti",
        as: "prodotto",
        steps: [
          {
            id: "task",
            kind: "createTask",
            title: "Attivare {{prodotto.nome}}",
            description: "",
            assignee: { departmentId: "dep-development" },
            dueInDays: 5,
            project: { mode: "own" },
            milestoneRef: null,
            approval: AUTO,
          },
        ],
      },
    ],
  };
  const a = await automationsApi.createAutomation({
    name: "Un'attività per prodotto",
    projectId: "prj-aud",
    flow,
  });
  const audin = state.automationSources.find((s) => s.id === "src-audin")!;
  const event = structuredClone(audin.sampleEvents[0]!) as {
    trattativa: { prodotti: unknown[]; chiusaIl: string };
  };
  event.trattativa.prodotti = Array.from({ length: count }, (_, i) => ({
    nome: `Prodotto ${i + 1}`,
    quantita: 1,
  }));
  // Il più recente: in cima a «Recent events».
  event.trattativa.chiusaIl = "2099-01-01";
  audin.sampleEvents.push(event);
  return a.code;
}

describe("i giri (Review Focus 5)", () => {
  it("50 giri leggibili: «Round 50 of 50», frecce, «All rounds» virtualizzato e con la ricerca", async () => {
    const code = await loopAutomation(50);
    await open(`/automations/${code}/test`);
    await startWith(0);
    await userEvent.click(runToStop());
    await screen.findByText("If this were real");
    expect(document.querySelector("[data-so-far]")).toBeNull();
    expect(document.querySelector("[data-test-final]")).toHaveTextContent("Prodotto 50");
    expect(document.querySelectorAll("[data-test-final] li")).toHaveLength(50);
    const label = () => document.querySelector("[data-round-label]")!;
    expect(label()).toHaveTextContent("Round 50 of 50 · Prodotto 50");
    expect(rowMark("0/forEach[49]/0")).toBe("done");
    // ← da tastiera sul selettore.
    const prev = screen.getByRole("button", { name: "Previous round" });
    prev.focus();
    await userEvent.keyboard("{ArrowLeft}{ArrowLeft}");
    expect(label()).toHaveTextContent("Round 48 of 50 · Prodotto 48");
    expect(rowMark("0/forEach[47]/0")).toBe("done");
    // «All rounds»: 50 righe, ma nel DOM solo quelle visibili.
    await userEvent.click(screen.getByRole("button", { name: "All rounds" }));
    const pop = document.querySelector<HTMLElement>("[data-all-rounds]")!;
    expect(pop.querySelector("[data-round-count]")).toHaveAttribute("data-round-count", "50");
    const rendered = pop.querySelectorAll("[data-round-row]").length;
    expect(rendered).toBeGreaterThan(0);
    expect(rendered).toBeLessThan(50);
    expect(pop).toHaveTextContent("would create 1 task");
    await userEvent.type(
      within(pop).getByRole("searchbox", { name: "Find a round" }),
      "Prodotto 7",
    );
    expect(pop.querySelector("[data-round-count]")).toHaveAttribute("data-round-count", "1");
    await userEvent.click(within(pop).getByRole("button", { name: /Prodotto 7/ }));
    expect(label()).toHaveTextContent("Round 7 of 50 · Prodotto 7");
    expect(document.querySelector("[data-all-rounds]")).toBeNull();
  });

  it("oltre 50 elementi la prova si ferma al «Per ogni»: dice perché e dove correggere", async () => {
    const code = await loopAutomation(64);
    await open(`/automations/${code}/test`);
    await startWith(0);
    await screen.findByText("The test stopped at step 1");
    expect(rowMark("0")).toBe("failed");
    expect(row("0")).toHaveTextContent("Would fail");
    await userEvent.click(row("0"));
    expect(panel()).toHaveTextContent(
      "The list has 64 items. A run stops at 50: this step would fail.",
    );
    expect(panel()).toHaveTextContent("A real run would stop here. Nothing else would happen.");
    expect(screen.getByRole("link", { name: "Edit step 1" })).toHaveAttribute(
      "href",
      expect.stringContaining(`/automations/${code}/edit?step=each`),
    );
    expect(document.querySelector("[data-finish-action]")).toBeNull();
  });
});

describe("partire", () => {
  it("una bozza con problemi non si prova: la pagina dice dove, ogni riga porta al passo", async () => {
    setSessionPersonId(MATTEO);
    const a = await automationsApi.createAutomation({
      name: "Da finire",
      projectId: "prj-aud",
      template: "newContract",
    });
    const before = bare();
    await open(`/automations/${a.code}/test`);
    expect(await screen.findByText("This automation can't be tested yet")).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "Choose an example" })).toBeNull();
    const problems = [...document.querySelectorAll<HTMLAnchorElement>("[data-blocked-problem]")];
    expect(problems.length).toBeGreaterThan(0);
    // Una riga per problema, senza doppioni.
    const texts = problems.map((p) => p.textContent);
    expect(new Set(texts).size).toBe(texts.length);
    expect(texts).toContain(
      "When it starts · Choose how this starts: which system the deal comes from",
    );
    const step = problems.find((p) => /^Step \d+ · Incomplete: /.test(p.textContent ?? ""))!;
    expect(step).toHaveTextContent("Incomplete: choose who gets the task");
    expect(step.getAttribute("href")).toMatch(new RegExp(`/automations/${a.code}/edit\\?step=`));
    expect(document.querySelector("[data-next-step]")).toBeNull();
    expect(bare()).toEqual(before);
  });

  it("chi vede ma non gestisce non prova", async () => {
    grantProjectRole(GIULIA, "prj-aud", "viewer");
    await open("/automations/AUD-A1/test", GIULIA);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(
      "You can't test this automation",
    );
    expect(screen.queryByRole("dialog", { name: "Choose an example" })).toBeNull();
  });

  it("la prova che non parte (errore del livello dati) lo dice; si riprova", async () => {
    await open("/automations/AUD-A1/test");
    const dialog = await screen.findByRole("dialog", { name: "Choose an example" });
    await within(dialog).findAllByRole("radio");
    failNext("automations.startSimulation");
    await userEvent.click(within(dialog).getByRole("button", { name: "Start test" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("Couldn't start the test");
    await userEvent.click(within(dialog).getByRole("button", { name: "Start test" }));
    await waitFor(() => expect(next()).toBeInTheDocument());
  });

  it("«Write one»: il modulo coi dati dell'inizio, precompilato, nessun campo obbligatorio", async () => {
    await open("/automations/AUD-A1/test");
    const dialog = await screen.findByRole("dialog", { name: "Choose an example" });
    await userEvent.click(within(dialog).getByRole("tab", { name: "Write one" }));
    const client = within(dialog).getByRole("textbox", { name: "Cliente" });
    expect(client).toHaveValue("Cantina Bellavista Srl");
    await userEvent.clear(client);
    await userEvent.type(client, "Pasticceria Neri");
    await userEvent.click(within(dialog).getByRole("button", { name: "Start test" }));
    await waitFor(() => expect(next()).toBeInTheDocument());
    expect(document.querySelector("[data-example-line]")).toHaveTextContent(
      "Example: written by hand",
    );
    await userEvent.click(next());
    await waitFor(() => expect(panel()).toHaveTextContent("Write the client's reply"));
    await userEvent.click(row("0"));
    expect(panel()).toHaveTextContent("Pasticceria Neri");
  });
});

describe("le fermate", () => {
  it("una versione accesa: risposta del cliente scritta nella prova; a fine prova niente «Turn on»", async () => {
    await open("/automations/AUD-A1/test");
    await startWith(0);
    expect(screen.getByText("Version 1 · on")).toBeInTheDocument();
    await userEvent.click(next());
    await waitFor(() => expect(rowMark("1")).toBe("stopped"));
    expect(row("1")).toHaveTextContent("Stopped: waiting");
    expect(panel()).toHaveTextContent(
      "Would wait for a reply to the email from step 1, at most 5 days.",
    );
    expect(panel()).toHaveTextContent("In a real run, the client's answer arrives by email.");
    expect(
      within(panel()).getByRole("button", { name: "Skip ahead 5 days — no reply" }),
    ).toBeEnabled();
    await userEvent.click(
      within(panel()).getByRole("button", { name: "Write the client's reply" }),
    );
    await userEvent.type(
      within(panel()).getByRole("textbox", { name: "Reply" }),
      "I numeri da collegare sono 0577 000111 e 0577 000112; gli orari di apertura dalle 9 alle 18; il messaggio di benvenuto: «Benvenuti in cantina».",
    );
    await userEvent.click(within(panel()).getByRole("button", { name: "Use this reply" }));
    await waitFor(() => expect(row("1")).toHaveTextContent("Reply written in the test"));
    await userEvent.click(runToStop());
    await screen.findByText("If this were real");
    // Claude ha trovato tutto: la task di attivazione, nel progetto dell'automazione.
    expect(document.querySelector("[data-test-final]")).toHaveTextContent(
      "Attivare Centralino AI per Cantina Bellavista Srl",
    );
    expect(document.querySelector("[data-finish-action]")).toBeNull();
    expect(document.querySelector("[data-test-again]")).not.toBeNull();
  });

  it("«Skip ahead» senza risposta: il promemoria, poi il limite dei giri", async () => {
    await open("/automations/AUD-A1/test");
    await startWith(0);
    await userEvent.click(next());
    for (let i = 0; i < 3; i++) {
      const skip = await within(panel()).findByRole("button", { name: /Skip ahead 5 days/ });
      await userEvent.click(skip);
      await waitFor(() => expect(document.querySelector("[data-run-to-stop]")).toBeTruthy());
      if (!runToStop().disabled) await userEvent.click(runToStop());
    }
    await screen.findByText("If this were real");
    expect(flow()).toHaveTextContent("Limit reached after 2 rounds");
    expect(flow().querySelector('[data-lane="2/onLimit"]')?.getAttribute("data-taken")).toBe(
      "true",
    );
    expect(document.querySelector("[data-round-label]")).toHaveTextContent("Round 2 of at most 2");
  });

  it("cliente fuori dalla tabella: si sceglie il progetto nella prova, la tabella resta com'è", async () => {
    const links = structuredClone(state.clientProjectLinks);
    await open("/automations/AUT-1/test");
    await startWith(0);
    await userEvent.click(next());
    await waitFor(() =>
      expect(panel()).toHaveTextContent(
        "Forneria Rossi & Lari isn't in the client table. A real run would stop and ask the owner to choose a project.",
      ),
    );
    await userEvent.selectOptions(
      within(panel()).getByRole("combobox", { name: "Project" }),
      "prj-aud",
    );
    await userEvent.click(
      within(panel()).getByRole("button", { name: "Use this project in the test" }),
    );
    await waitFor(() => expect(panel()).toHaveTextContent("Would create a milestone in AUD"));
    expect(state.clientProjectLinks).toEqual(links);
  });

  it("rifiutare nella prova: la vera si fermerebbe lì; niente «Turn on»", async () => {
    await open("/automations/AUT-1/test");
    await startWith(2);
    await userEvent.click(runToStop());
    await userEvent.click(
      await within(panel()).findByRole("button", { name: "Reject in the test" }),
    );
    expect(
      await screen.findByText(/A real run would stop at step \d+: rejected in the test/),
    ).toBeInTheDocument();
    expect(document.querySelector("[data-finish-action]")).toBeNull();
  });

  it("correggere l'email prima di approvare: l'anteprima mostra il testo corretto", async () => {
    await open("/automations/AUT-1/test");
    await startWith(2);
    await userEvent.click(runToStop());
    await userEvent.click(
      await within(panel()).findByRole("button", { name: "Edit before approving" }),
    );
    const subject = within(panel()).getByRole("textbox", { name: "Subject" });
    await userEvent.clear(subject);
    await userEvent.type(subject, "Benvenuti!");
    await userEvent.click(
      within(panel()).getByRole("button", { name: "Approve in the test with changes" }),
    );
    await waitFor(() => expect(next()).toBeEnabled());
    await userEvent.click(next());
    await screen.findByText("If this were real");
    expect(document.querySelector("[data-test-final]")).toHaveTextContent("Benvenuti!");
  });
});

describe("tastiera, uscita e persone", () => {
  it("N fa un passo, Maiusc+Invio va alla prossima fermata; Esc torna al costruttore sul passo", async () => {
    setMatchMedia(DOCKED_PANEL_QUERY, false);
    const router = await open("/automations/AUT-1/test");
    await startWith(2);
    await userEvent.keyboard("n");
    await waitFor(() => expect(rowMark("0")).toBe("done"));
    row("trigger").focus();
    await userEvent.keyboard("{Shift>}{Enter}{/Shift}");
    await waitFor(() => expect(document.querySelector("[data-real-approver]")).not.toBeNull());
    // A 1024 il pannello sovrapposto si è aperto da solo alla fermata: Esc lo chiude, poi esce.
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(document.querySelector("[data-test-panel]")).toBeNull());
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(router.state.location.pathname).toBe("/automations/AUT-1/edit"));
    expect(router.state.location.search).toMatchObject({ step: "nc-welcome" });
  });

  it("a 1024 il pannello sovrapposto si apre da solo alla fermata e si richiude quando la prova riparte", async () => {
    setMatchMedia(DOCKED_PANEL_QUERY, false);
    await open("/automations/AUT-1/test");
    await startWith(2);
    expect(document.querySelector("[data-test-panel]")).toBeNull();
    await userEvent.click(runToStop());
    const approve = await within(panel()).findByRole("button", { name: "Approve in the test" });
    expect(document.querySelector("[data-mode=overlay]")).not.toBeNull();
    await userEvent.click(approve);
    await waitFor(() => expect(document.querySelector("[data-test-panel]")).toBeNull());
    expect(next()).toBeEnabled();
  });

  it("cambiare persona a metà prova la butta: la nuova persona riparte da capo", async () => {
    await open("/automations/AUT-1/test");
    await startWith(2);
    await userEvent.click(next());
    await waitFor(() => expect(rowMark("0")).toBe("done"));
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Profile and settings" }));
    const menu = await screen.findByRole("dialog", { name: "Profile and settings" });
    await user.click(within(menu).getByRole("radio", { name: /Roberta/ }));
    // Una pagina nuova: si sceglie di nuovo l'esempio, nessun passo fatto.
    expect(await screen.findByRole("dialog", { name: "Choose an example" })).toBeInTheDocument();
    expect(document.querySelector('[data-mark="done"][data-step-path="0"]')).toBeNull();
    expect(await automationsApi.getSimulation("sim-1")).toBeNull();
  });
});

describe("R-J19: la versione provata", () => {
  it("dopo una prova finita bene «Publish» non dice più «non provata»; una modifica sì", async () => {
    const router = await open("/automations/AUT-1/test");
    await startWith(2);
    await userEvent.click(runToStop());
    await userEvent.click(
      await within(panel()).findByRole("button", { name: "Approve in the test" }),
    );
    await waitFor(() => expect(next()).toBeEnabled());
    await userEvent.click(next());
    await screen.findByText("If this were real");
    expect(auto("AUT-1").versions.at(-1)!.testedRev).toBe(
      auto("AUT-1").versions.at(-1)!.rev ?? null,
    );
    // Il dialogo della prova: lo stesso del costruttore, senza «non provata».
    await userEvent.click(document.querySelector<HTMLButtonElement>("[data-finish-action]")!);
    const dialog = await screen.findByRole("dialog", { name: "Publish version 2 of AUT-1?" });
    expect(dialog.querySelector("[data-untested]")).toBeNull();
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    // Nel costruttore: provata. Poi una modifica salvata la rende di nuovo non provata.
    await userEvent.click(screen.getByRole("link", { name: /Back to editing/ }));
    await screen.findByRole("tree");
    const primary = () => document.querySelector<HTMLButtonElement>("[data-primary-action]")!;
    await userEvent.click(primary());
    let publish = await screen.findByRole("dialog", { name: "Publish version 2 of AUT-1?" });
    expect(publish.querySelector("[data-untested]")).toBeNull();
    await userEvent.click(within(publish).getByRole("button", { name: "Cancel" }));
    await act(() =>
      automationsApi.saveDraft(auto("AUT-1").id, auto("AUT-1").versions.at(-1)!.flow),
    );
    await act(() => router.navigate({ to: "/automations/AUT-1" } as never));
    await act(() => router.navigate({ to: "/automations/AUT-1/edit" } as never));
    await screen.findByRole("tree");
    await userEvent.click(primary());
    publish = await screen.findByRole("dialog", { name: "Publish version 2 of AUT-1?" });
    await waitFor(() =>
      expect(publish.querySelector("[data-untested]")).toHaveTextContent(
        "You haven't tested this version yet.",
      ),
    );
  });
});

describe("il ritmo", () => {
  it("senza movimento ridotto: Claude risponde in streaming (Next aspetta), «Run to next stop» accende un passo alla volta", async () => {
    setMatchMedia(REDUCED_MOTION_QUERY, false);
    await open("/automations/AUT-1/test");
    await startWith(2);
    await userEvent.click(next());
    // La motivazione arriva: il pannello è occupato e «Next step» aspetta.
    await waitFor(() => expect(panel().querySelector('[aria-busy="true"]')).not.toBeNull());
    expect(next()).toBeDisabled();
    await waitFor(() => expect(panel().querySelector('[aria-busy="true"]')).toBeNull());
    await waitFor(() => expect(next()).toBeEnabled());
    expect(panel()).toHaveTextContent("Would create a milestone in CBV");
    // Run to next stop: non salta alla fine in un colpo, i passi si accendono uno alla volta.
    await userEvent.click(runToStop());
    await waitFor(() => expect(rowMark("1")).toBe("done"));
    expect(document.querySelector("[data-real-approver]")).toBeNull();
    await waitFor(() => expect(document.querySelector("[data-real-approver]")).not.toBeNull(), {
      timeout: 4000,
    });
    expect(document.querySelector("[data-so-far]")).toHaveTextContent("4 tasks");
  });
});
