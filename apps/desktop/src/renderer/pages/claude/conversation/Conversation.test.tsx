import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import * as api from "../../../data/api";
import { setSessionPersonId } from "../../../data/session";
import { useViewer } from "../../../data/viewer";
import { renderWithData } from "../../../test/renderWithData";
import { Conversation } from "./Conversation";

beforeEach(() => {
  api.setLatency(0);
  api.setStreamLatency(null);
  api.resetApi();
});

/** Il componente con un bottone per cambiare «vedi come», come il menu del profilo. */
function Harness({ id, to }: { id: string; to?: string }) {
  const { setPersona } = useViewer();
  return (
    <div style={{ height: 800 }}>
      {to && (
        <button type="button" onClick={() => setPersona(to)}>
          switch persona
        </button>
      )}
      <Conversation id={id} />
    </div>
  );
}

/** Una scrittura a nome di una persona, senza cambiare chi guarda nel test. */
async function as<R>(personId: string, call: () => Promise<R>): Promise<R> {
  setSessionPersonId(personId);
  return call();
}

const noRawKeys = (container: HTMLElement) =>
  expect(container.textContent ?? "").not.toMatch(/claude\.conversation\./);

describe("Conversation: flusso", () => {
  it("il testo di Claude arriva a pezzi nello stesso messaggio, e una volta sola", async () => {
    api.setStreamLatency(15);
    const c = await as("p-giulia", () => api.createConversation({ contextProjectId: "prj-mkx" }));
    const { container } = renderWithData(<Harness id={c.id} />, { personId: "p-giulia" });
    await screen.findByRole("combobox", { name: /message to claude/i });
    const sending = as("p-giulia", () => api.sendMessage(c.id, { text: "Explain MKX-7" }));
    // In arrivo: il messaggio c'è, con il cursore, e non ha ancora tutto il testo.
    const cursor = await waitFor(() => {
      const el = container.querySelector("[data-stream-cursor]");
      expect(el).not.toBeNull();
      return el;
    });
    expect(cursor).not.toBeNull();
    const partial = container.querySelector("[data-assistant]")!.textContent ?? "";
    await act(() => sending);
    await waitFor(() => expect(container.querySelector("[data-stream-cursor]")).toBeNull(), {
      timeout: 4000,
    });
    const messages = container.querySelectorAll("[data-assistant]");
    const final = messages[messages.length - 1]!.textContent ?? "";
    expect(final.length).toBeGreaterThan(partial.length);
    expect(final.startsWith(partial.slice(0, 10))).toBe(true);
    // Una volta sola: nessun messaggio ripetuto.
    const texts = [...messages].map((m) => m.textContent);
    expect(new Set(texts).size).toBe(texts.length);
    noRawKeys(container);
  });

  it("le azioni consecutive sono un gruppo chiuso che si apre", async () => {
    const user = userEvent.setup();
    renderWithData(<Harness id="cv-giulia-week" />, { personId: "p-giulia" });
    const group = await screen.findByRole("button", { name: /3 actions/i });
    expect(group).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("Reads the open tasks of MKX")).toBeNull();
    await user.click(group);
    expect(group).toHaveAttribute("aria-expanded", "true");
    const row = screen.getByRole("button", { name: "Reads the open tasks of MKX" });
    await user.click(row);
    expect(screen.getByText("project: MKX · status: open")).toBeInTheDocument();
  });

  it("le citazioni hanno codice e nome e si aprono; «Used» in coda al messaggio", async () => {
    const { container } = renderWithData(<Harness id="cv-giulia-week" />, {
      personId: "p-giulia",
    });
    await waitFor(() =>
      expect(container.querySelector('[data-citation="task:t-mkx-7"]')).not.toBeNull(),
    );
    const link = container.querySelector('[data-citation="task:t-mkx-7"]')!;
    expect(link.tagName).toBe("A");
    expect(link.textContent).toMatch(/^MKX-7 /);
    expect(link.getAttribute("href")).toContain("task=MKX-7");
    expect(screen.getByText("Used:")).toBeInTheDocument();
  });
});

describe("Conversation: proposte", () => {
  it("i bottoni solo per chi l'ha chiesta; chi guarda una pubblica legge «Proposal for»", async () => {
    await as("p-giulia", () =>
      api.setVisibility("cv-giulia-week", "public", {
        confirmedProjectIds: ["prj-mkx", "prj-olv", "prj-stw"],
      }),
    );
    const mine = renderWithData(<Harness id="cv-giulia-week" />, { personId: "p-giulia" });
    const card = await screen.findByRole("region", { name: /claude proposes · 1 change/i });
    expect(within(card).getByRole("button", { name: "Confirm" })).toBeInTheDocument();
    mine.unmount();

    renderWithData(<Harness id="cv-giulia-week" />, { personId: "p-laura" });
    const other = await screen.findByRole("region", { name: /proposal for giulia/i });
    expect(within(other).queryByRole("button")).toBeNull();
  });

  it("la conferma mostra l'esito con i codici apribili", async () => {
    const user = userEvent.setup();
    renderWithData(<Harness id="cv-giulia-week" />, { personId: "p-giulia" });
    const card = await screen.findByRole("region", { name: /claude proposes/i });
    await user.click(within(card).getByRole("button", { name: "Confirm" }));
    const done = await within(card).findByRole("link", { name: "MKX-7" });
    expect(done).toHaveAttribute("href", expect.stringContaining("task=MKX-7"));
    expect(within(card).getByText("Done")).toBeInTheDocument();
    expect(within(card).queryByRole("button", { name: "Confirm" })).toBeNull();
  });
});

describe("Conversation: domande e piani", () => {
  it("una domanda risposta si riduce a «Answered by …»", async () => {
    const user = userEvent.setup();
    renderWithData(<Harness id="cv-run-aud-3" />, { personId: "p-marco" });
    const card = await screen.findByRole("region", { name: /claude asks/i });
    const options = within(card).getAllByRole("button");
    // La consigliata è la prima, con l'etichetta testuale.
    expect(options[0]).toHaveTextContent(/create a new contact.*recommended/i);
    await user.click(options[0]!);
    await screen.findByText(/answered by marco/i);
    expect(screen.queryByRole("region", { name: /claude asks/i })).toBeNull();
  });

  it("i bottoni del piano seguono canDecidePlan del livello dati", async () => {
    for (const personId of ["p-roberta", "p-marco"]) {
      setSessionPersonId(personId);
      const detail = await api.getConversation("cv-run-stw-13");
      if (!detail) continue;
      const view = renderWithData(<Harness id="cv-run-stw-13" />, { personId });
      const card = await screen.findByRole("region", { name: /waiting for approval/i });
      if (detail.canDecidePlan) {
        expect(within(card).getByRole("button", { name: "Approve" })).toBeInTheDocument();
        expect(
          within(card).getByRole("button", { name: "Reject with instructions" }),
        ).toBeInTheDocument();
      } else {
        expect(within(card).queryByRole("button", { name: "Approve" })).toBeNull();
        expect(
          within(card).getByText(/waiting for someone who can approve plans in stw/i),
        ).toBeInTheDocument();
      }
      view.unmount();
    }
    setSessionPersonId("p-roberta");
    expect((await api.getConversation("cv-run-stw-13"))!.canDecidePlan).toBe(true);
    setSessionPersonId("p-marco");
    expect((await api.getConversation("cv-run-stw-13"))!.canDecidePlan).toBe(false);
  });
});

describe("Conversation: casella", () => {
  it("«/» mostra le skill dei plugin solo per il progetto di contesto", async () => {
    const user = userEvent.setup();
    const withProject = await as("p-giulia", () =>
      api.createConversation({ contextProjectId: "prj-stw" }),
    );
    const first = renderWithData(<Harness id={withProject.id} />, { personId: "p-giulia" });
    const box = await screen.findByRole("combobox", { name: /message to claude/i });
    await user.type(box, "/");
    const menu = await screen.findByRole("listbox", { name: "Commands" });
    expect(within(menu).getByRole("group", { name: "Stubwise" })).toBeInTheDocument();
    expect(within(menu).getByRole("group", { name: "superpowers" })).toBeInTheDocument();
    expect(within(menu).queryByText(/set a project to see its skills/i)).toBeNull();
    first.unmount();

    const without = await as("p-giulia", () => api.createConversation());
    renderWithData(<Harness id={without.id} />, { personId: "p-giulia" });
    const box2 = await screen.findByRole("combobox", { name: /message to claude/i });
    await user.type(box2, "/");
    const menu2 = await screen.findByRole("listbox", { name: "Commands" });
    expect(within(menu2).queryByRole("group", { name: "superpowers" })).toBeNull();
    expect(within(menu2).getByText(/set a project to see its skills/i)).toBeInTheDocument();
  });

  it("«/» si apre solo all'inizio del messaggio", async () => {
    const user = userEvent.setup();
    const c = await as("p-giulia", () => api.createConversation());
    renderWithData(<Harness id={c.id} />, { personId: "p-giulia" });
    const box = await screen.findByRole("combobox", { name: /message to claude/i });
    await user.type(box, "a/");
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("«#» inserisce una citazione (codice + nome) che Backspace toglie intera", async () => {
    const user = userEvent.setup();
    const c = await as("p-giulia", () => api.createConversation());
    renderWithData(<Harness id={c.id} />, { personId: "p-giulia" });
    const box = await screen.findByRole("combobox", { name: /message to claude/i });
    await user.type(box, "Look at #MKX-7");
    const menu = await screen.findByRole("listbox", { name: "Objects to cite" });
    await within(menu).findByRole("option", { name: /MKX-7/ });
    await user.keyboard("{Enter}");
    expect((box as HTMLTextAreaElement).value).toMatch(/^Look at MKX-7 \S.* $/);
    await user.keyboard("{Backspace}");
    expect((box as HTMLTextAreaElement).value).toBe("Look at ");
    // Citare un oggetto in una libera senza progetto ne fissa il contesto.
    await waitFor(async () => {
      setSessionPersonId("p-giulia");
      expect((await api.getConversation(c.id))!.contextProjectId).toBe("prj-mkx");
    });
  });

  it("allegati incollando: chip con nome, si toglie; oltre 20 MB un errore in riga", async () => {
    const c = await as("p-giulia", () => api.createConversation());
    renderWithData(<Harness id={c.id} />, { personId: "p-giulia" });
    const box = await screen.findByRole("combobox", { name: /message to claude/i });
    const image = new File(["x".repeat(2048)], "shot.png", { type: "image/png" });
    fireEvent.paste(box, { clipboardData: { files: [image] } });
    const list = await screen.findByRole("list", { name: "Attachments" });
    expect(within(list).getByText("shot.png")).toBeInTheDocument();
    fireEvent.click(within(list).getByRole("button", { name: "Remove shot.png" }));
    expect(screen.queryByRole("list", { name: "Attachments" })).toBeNull();

    const big = new File(["x"], "huge.mov", { type: "video/quicktime" });
    Object.defineProperty(big, "size", { value: 21 * 1024 * 1024 });
    fireEvent.paste(box, { clipboardData: { files: [big] } });
    expect(await screen.findByRole("alert")).toHaveTextContent(/huge.mov is over 20 MB/);
  });

  it("mentre Claude risponde: Stop, poi con del testo Send e «Stop and send»", async () => {
    api.setStreamLatency(20);
    const user = userEvent.setup();
    const c = await as("p-giulia", () => api.createConversation({ contextProjectId: "prj-mkx" }));
    renderWithData(<Harness id={c.id} />, { personId: "p-giulia" });
    const box = await screen.findByRole("combobox", { name: /message to claude/i });
    await user.type(box, "What should I do today?{Enter}");
    await screen.findByRole("button", { name: "Stop" });
    await user.type(box, "and tomorrow");
    expect(screen.getByRole("button", { name: "Stop and send" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
  });

  it("«Stop» ferma la risposta: la fase dice chi l'ha fermata e la casella torna a Send", async () => {
    api.setStreamLatency(25);
    const user = userEvent.setup();
    const c = await as("p-giulia", () => api.createConversation({ contextProjectId: "prj-mkx" }));
    renderWithData(<Harness id={c.id} />, { personId: "p-giulia" });
    const box = await screen.findByRole("combobox", { name: /message to claude/i });
    await user.type(box, "What should I do today?{Enter}");
    await user.click(await screen.findByRole("button", { name: "Stop" }));
    expect(
      await screen.findByRole(
        "separator",
        { name: /reply · stopped by giulia/i },
        { timeout: 4000 },
      ),
    ).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("button", { name: "Stop" })).toBeNull());
    expect(screen.getByRole("button", { name: "Send" })).toBeInTheDocument();
  });

  it("sola lettura: al posto della casella il motivo del «server»", async () => {
    renderWithData(<Harness id="cv-review-stw-405" />, { personId: "p-roberta" });
    await screen.findByText(/this session runs on its own/i);
    expect(screen.queryByRole("combobox")).toBeNull();
  });
});

describe("Conversation: contenuti estremi (Review Focus 5)", () => {
  it("un blocco di codice largo scorre dentro sé stesso, mai la pagina", async () => {
    const c = await as("p-giulia", () => api.createConversation());
    const wide = `\`\`\`ts\nconst x = "${"a".repeat(600)}";\n\`\`\``;
    await api.runScript(c.id, [
      {
        step: "say",
        text: `Here:\n\n${wide}\n\nand a path \`apps/desktop/src/renderer/pages/claude/conversation/Conversation.tsx\``,
      },
    ]);
    const { container } = renderWithData(<Harness id={c.id} />, { personId: "p-giulia" });
    const block = await waitFor(() => {
      const el = container.querySelector("[data-code-block]");
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });
    // Lo scorrimento orizzontale è del blocco…
    expect(block.className).toMatch(/overflow-x-auto/);
    expect(block.className).toMatch(/max-w-full/);
    // …e il contenitore del flusso non scorre in orizzontale; ogni antenato si stringe.
    const scroller = container.querySelector("[data-conversation-scroll]") as HTMLElement;
    expect(scroller.className).toMatch(/overflow-x-hidden/);
    for (let el = block.parentElement; el && el !== scroller; el = el.parentElement) {
      if (el.tagName === "LI" || el.tagName === "OL") continue;
      expect(el.className, el.outerHTML.slice(0, 120)).toMatch(/min-w-0/);
    }
    // Un percorso lungo va a capo dopo ogni «/», con il percorso intero al passaggio.
    const path = container.querySelector(
      '[title="apps/desktop/src/renderer/pages/claude/conversation/Conversation.tsx"]',
    )!;
    expect(path.querySelectorAll("wbr").length).toBe(7);
  });

  it("200+ azioni: un gruppo chiuso, aperto ne disegna una finestra; niente doppi", async () => {
    const user = userEvent.setup();
    const c = await as("p-giulia", () => api.createConversation());
    await api.runScript(
      c.id,
      Array.from({ length: 220 }, (_, i) => ({
        step: "action" as const,
        tool: "repo.read",
        label: `Reads file-${i}.ts`,
      })),
    );
    renderWithData(<Harness id={c.id} />, { personId: "p-giulia" });
    const group = await screen.findByRole("button", { name: /220 actions/i });
    await user.click(group);
    const rows = document.querySelectorAll("[data-action]");
    expect(rows.length).toBe(50);
    await user.click(screen.getByRole("button", { name: /show 170 earlier actions/i }));
    const ids = [...document.querySelectorAll("[data-action]")].map((r) =>
      r.getAttribute("data-action"),
    );
    expect(ids).toHaveLength(100);
    expect(new Set(ids).size).toBe(100);
  });

  it("riconnessione a metà messaggio: «Reconnecting…», poi il testo intero una volta", async () => {
    api.setStreamLatency(10);
    const c = await as("p-giulia", () => api.createConversation({ contextProjectId: "prj-mkx" }));
    const { container } = renderWithData(<Harness id={c.id} />, { personId: "p-giulia" });
    await screen.findByRole("combobox", { name: /message to claude/i });
    const sending = as("p-giulia", () => api.sendMessage(c.id, { text: "Explain MKX-7" }));
    await waitFor(() => expect(container.querySelector("[data-stream-cursor]")).not.toBeNull());
    // La riconnessione aspetta la latenza delle chiamate: la si allunga per vederla.
    api.setLatency(60);
    act(() => api.simulateDisconnect(c.id));
    expect(await screen.findByText("Reconnecting…")).toBeInTheDocument();
    // Si scrive, ma l'invio aspetta.
    expect(screen.getByText(/sending resumes when the connection is back/i)).toBeInTheDocument();
    await act(() => sending);
    await waitFor(() => expect(screen.queryByText("Reconnecting…")).toBeNull(), { timeout: 4000 });
    await waitFor(() => expect(container.querySelector("[data-stream-cursor]")).toBeNull(), {
      timeout: 4000,
    });
    setSessionPersonId("p-giulia");
    const stored = (await api.getConversation(c.id))!.events.filter((e) => e.type === "assistant");
    const shown = [...container.querySelectorAll("[data-assistant]")];
    expect(shown).toHaveLength(stored.length);
    expect(shown.map((s) => s.getAttribute("data-assistant"))).toEqual(stored.map((e) => e.id));
  });
});

describe("Conversation: cambio di persona (Review Focus 1)", () => {
  it("cambiando persona la vista si svuota: nessun testo della persona di prima", async () => {
    const user = userEvent.setup();
    renderWithData(<Harness id="cv-giulia-week" to="p-sara" />, { personId: "p-giulia" });
    await screen.findByText(/here is the week in your pinned projects/i);
    const box = await screen.findByRole("combobox", { name: /message to claude/i });
    await user.type(box, "draft of giulia");
    await user.click(screen.getByRole("button", { name: "switch persona" }));
    await screen.findByText(/doesn't exist or you can't see it/i);
    expect(screen.queryByText(/here is the week in your pinned projects/i)).toBeNull();
    expect(screen.queryByText(/where do my projects stand/i)).toBeNull();
    expect(screen.queryByDisplayValue("draft of giulia")).toBeNull();
  });

  it("cambiando persona su una pubblica, la bozza e lo stato locale non passano all'altra", async () => {
    const user = userEvent.setup();
    await as("p-giulia", () =>
      api.setVisibility("cv-giulia-week", "public", {
        confirmedProjectIds: ["prj-mkx", "prj-olv", "prj-stw"],
      }),
    );
    renderWithData(<Harness id="cv-giulia-week" to="p-laura" />, { personId: "p-giulia" });
    const box = await screen.findByRole("combobox", { name: /message to claude/i });
    await user.type(box, "draft of giulia");
    await user.click(screen.getByRole("button", { name: "switch persona" }));
    await screen.findByRole("region", { name: /proposal for giulia/i });
    expect(screen.queryByDisplayValue("draft of giulia")).toBeNull();
    expect(screen.queryByRole("combobox")).toBeNull();
  });
});
