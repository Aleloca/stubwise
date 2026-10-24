import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../../../data/api";
import { setSessionPersonId } from "../../../data/session";
import { state } from "../../../data/store";
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

/**
 * Una libera di Giulia con Claude a metà risposta, ferma lì: nessuno script
 * in coda, quindi la risposta non finisce mentre il test scrive. Con la
 * risposta vera in streaming (latenza a orologio) i test della casella
 * correvano contro di lei: sotto il carico della suite intera la digitazione
 * durava più della risposta, Claude finiva prima del clic e «Stop and send»
 * non c'era più. Fermare uno stream vero è provato nel livello dati
 * (`conversation-composer.test.ts`).
 */
async function claudeMidReply(): Promise<string> {
  const c = await as("p-giulia", () => api.createConversation({ contextProjectId: "prj-mkx" }));
  await api.runScript(c.id, [
    {
      step: "event",
      event: {
        type: "user",
        authorId: "p-giulia",
        text: "What should I do today?",
        attachments: [],
        delivery: "delivered",
      },
    },
    { step: "state", state: "working" },
    { step: "event", event: { type: "assistant", text: "Let me look at your week", done: false } },
  ]);
  return c.id;
}

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

describe("Conversation: citazioni che chi guarda non può aprire (R-E9)", () => {
  it("il codice in inchiostro tenue, non un link, «You can't open this»; il titolo no", async () => {
    const { container } = renderWithData(<Harness id="cv-giulia-callbacks" />, {
      personId: "p-sara",
    });
    const used = await screen.findByText("Used:");
    const line = used.parentElement!;
    await waitFor(() => expect(line.querySelector('[data-citation="hidden"]')).not.toBeNull());
    const code = within(line).getByText("AUD-9");
    expect(code.tagName).toBe("SPAN");
    expect(code).toHaveAttribute("title", "You can't open this");
    expect(code.className).toMatch(/text-ink-faint/);
    expect(line.textContent).not.toMatch(/Fix the timezone/);
    expect(within(line).queryByRole("link", { name: /AUD-9/ })).toBeNull();
    // Nel testo di Claude il codice resta leggibile ma non si apre.
    expect(container.querySelector('a[href*="AUD-9"]')).toBeNull();
  });
});

describe("Conversation: il seguito privato di una pubblica", () => {
  it("chi non è l'autore legge la riga DOPO l'ultimo messaggio, non prima", async () => {
    // L'autrice scrive dopo la pubblicazione e Claude legge un progetto nuovo: il seguito è privato.
    await as("p-giulia", () => api.sendMessage("cv-giulia-callbacks", { text: "Explain MKX-3" }));
    await api.whenIdle("cv-giulia-callbacks");
    const { container } = renderWithData(<Harness id="cv-giulia-callbacks" />, {
      personId: "p-marco",
    });
    const line = await screen.findByText("The rest of this conversation is private for now.");
    const reply = await screen.findByText(/Here is a reply you can paste/);
    // Dopo l'ultimo evento leggibile: la riga segue la risposta nell'albero.
    expect(reply.compareDocumentPosition(line) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(container.textContent).not.toContain("Explain MKX-3");
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
    // Il bottone col fuoco è sparito: il fuoco è sulla scheda, non sul body.
    expect(document.activeElement).toBe(card);
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
    const answered = await screen.findByText(/answered by marco/i);
    expect(screen.queryByRole("region", { name: /claude asks/i })).toBeNull();
    // Il fuoco va alla riga che prende il posto della scheda.
    expect(document.activeElement).toBe(answered.closest("p"));
  });

  it("approvato il piano, il fuoco va alla riga «Approved by …»", async () => {
    const user = userEvent.setup();
    renderWithData(<Harness id="cv-run-stw-13" />, { personId: "p-roberta" });
    const card = await screen.findByRole("region", { name: /waiting for approval/i });
    await user.click(within(card).getByRole("button", { name: "Approve" }));
    const line = await screen.findByText(/approved by roberta/i);
    expect(document.activeElement).toBe(line.closest("[data-plan]"));
  });

  it("piano deciso da un altro nel frattempo: «Already decided by …», non un errore", async () => {
    const user = userEvent.setup();
    renderWithData(<Harness id="cv-run-stw-13" />, { personId: "p-laura" });
    const card = await screen.findByRole("region", { name: /waiting for approval/i });
    // Sul «server» Roberta l'ha già approvato; la pagina di Laura non lo sa ancora.
    // (Un evento nuovo al suo posto: quello che la pagina tiene non cambia.)
    const log = state.conversationEvents.get("cv-run-stw-13")!;
    const index = log.findIndex((e) => e.type === "plan");
    log[index] = {
      ...log[index]!,
      status: "approved",
      decidedById: "p-roberta",
    } as (typeof log)[number];
    await user.click(within(card).getByRole("button", { name: "Approve" }));
    expect(await within(card).findByRole("status")).toHaveTextContent(
      "Already decided by Roberta Fontana",
    );
    expect(within(card).queryByRole("alert")).toBeNull();
    // Riletti i permessi, il piano non è più da decidere: niente bottoni.
    await waitFor(() => expect(within(card).queryByRole("button", { name: "Approve" })).toBeNull());
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
    const user = userEvent.setup();
    const id = await claudeMidReply();
    renderWithData(<Harness id={id} />, { personId: "p-giulia" });
    const box = await screen.findByRole("combobox", { name: /message to claude/i });
    await screen.findByRole("button", { name: "Stop" });
    await user.type(box, "and tomorrow");
    expect(screen.getByRole("button", { name: "Stop and send" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
  });

  it("«Stop» ferma la risposta: la fase dice chi l'ha fermata e la casella torna a Send", async () => {
    const user = userEvent.setup();
    const id = await claudeMidReply();
    renderWithData(<Harness id={id} />, { personId: "p-giulia" });
    await screen.findByRole("combobox", { name: /message to claude/i });
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

  it("«Delivered» sparisce dopo 3 s anche mentre arrivano altri eventi", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      api.setStreamLatency(10);
      // Un refine nuovo (senza lo script del seed): Claude risponde e torna ad aspettare.
      const ID = (await as("p-laura", () => api.startRefineConversation("req-stw-1"))).id;
      renderWithData(<Harness id={ID} />, { personId: "p-laura" });
      const box = await screen.findByRole("combobox", { name: /message to claude/i });
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      await user.type(box, "fade check{Enter}");
      await screen.findByText("Delivered");
      // Eventi che continuano ad arrivare, ognuno prima che scadano i 3 s.
      for (let i = 0; i < 4; i++) {
        await act(async () => {
          await api.runScript(ID, [
            {
              step: "event",
              event: { type: "work_result", kind: "design_updated", text: `tick ${i}` },
            },
          ]);
          vi.advanceTimersByTime(900);
        });
      }
      await waitFor(() => expect(screen.queryByText("Delivered")).toBeNull());
    } finally {
      vi.useRealTimers();
    }
  });

  it("⌘. ferma Claude, ma non con un dialogo aperto", async () => {
    const id = await claudeMidReply();
    renderWithData(<Harness id={id} />, { personId: "p-giulia" });
    await screen.findByRole("combobox", { name: /message to claude/i });
    await screen.findByRole("button", { name: "Stop" });
    const modal = document.createElement("div");
    modal.setAttribute("aria-modal", "true");
    document.body.appendChild(modal);
    fireEvent.keyDown(window, { key: ".", metaKey: true });
    await new Promise((r) => setTimeout(r, 60));
    expect(screen.queryByRole("separator", { name: /stopped by/i })).toBeNull();
    modal.remove();
    fireEvent.keyDown(window, { key: ".", metaKey: true });
    expect(
      await screen.findByRole("separator", { name: /stopped by giulia/i }, { timeout: 4000 }),
    ).toBeInTheDocument();
  });

  it("«Stop» rifiutato: lo dice, con «Try again»", async () => {
    const user = userEvent.setup();
    const id = await claudeMidReply();
    renderWithData(<Harness id={id} />, { personId: "p-giulia" });
    await screen.findByRole("combobox", { name: /message to claude/i });
    const stop = await screen.findByRole("button", { name: "Stop" });
    api.failNext("stop");
    await user.click(stop);
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/claude couldn't be stopped/i);
    expect(within(alert).getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });

  it("«Stop and send» rifiutato (rete o permesso tolto): il testo resta, con «Resend»", async () => {
    const user = userEvent.setup();
    const id = await claudeMidReply();
    renderWithData(<Harness id={id} />, { personId: "p-giulia" });
    const box = await screen.findByRole("combobox", { name: /message to claude/i });
    await screen.findByRole("button", { name: "Stop" });

    // 1. La chiamata non passa.
    api.failNext("stopAndSend");
    await user.type(box, "first try");
    await user.click(screen.getByRole("button", { name: "Stop and send" }));
    const failed = await screen.findByRole("alert");
    expect(within(failed).getByText("first try")).toBeInTheDocument();
    expect(within(failed).getByText(/didn't go through/i)).toBeInTheDocument();
    expect(within(failed).getByRole("button", { name: "Resend" })).toBeInTheDocument();
  });

  it("«Stop and send» con il permesso tolto nel frattempo: forbidden, il testo resta", async () => {
    const user = userEvent.setup();
    const id = await claudeMidReply();
    renderWithData(<Harness id={id} />, { personId: "p-giulia" });
    const box = await screen.findByRole("combobox", { name: /message to claude/i });
    await screen.findByRole("button", { name: "Stop" });
    // Il «server» non concede più di fermare (archiviata altrove), la pagina non lo sa ancora.
    state.conversations.find((x) => x.id === id)!.archived = true;
    await user.type(box, "second try");
    await user.click(screen.getByRole("button", { name: "Stop and send" }));
    const failed = await screen.findByRole("alert");
    expect(within(failed).getByText("second try")).toBeInTheDocument();
    expect(within(failed).getByRole("button", { name: "Resend" })).toBeInTheDocument();
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
  it("due persone che scrivono entrambe: lo stato locale della prima non passa alla seconda", async () => {
    const user = userEvent.setup();
    api.setStreamLatency(15);
    const ID = (await as("p-laura", () => api.startRefineConversation("req-stw-1"))).id;
    // Precondizione: entrambe possono scrivere qui (lo dice il livello dati).
    for (const personId of ["p-laura", "p-roberta"]) {
      setSessionPersonId(personId);
      expect((await api.getConversation(ID))!.canWrite, personId).toBe(true);
    }
    renderWithData(<Harness id={ID} to="p-roberta" />, { personId: "p-laura" });
    const box = await screen.findByRole("combobox", { name: /message to claude/i });
    // Un messaggio consegnato adesso: «Delivered» resta per 3 s.
    await user.type(box, "first note of laura{Enter}");
    await screen.findByText("Delivered", undefined, { timeout: 3000 });
    // Un messaggio che non parte: resta nella riga con «Resend».
    api.failNext("sendMessage");
    await user.type(box, "second note of laura{Enter}");
    await screen.findByText(/didn't go through/i);
    // Una bozza con il menu «#» aperto.
    await user.type(box, "draft of laura #STW");
    await screen.findByRole("listbox", { name: "Objects to cite" });

    await user.click(screen.getByRole("button", { name: "switch persona" }));
    // Roberta scrive anche lei: la casella c'è, ma vuota.
    const fresh = await screen.findByRole("combobox", { name: /message to claude/i });
    expect(fresh).toHaveValue("");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(screen.queryByText("Delivered")).toBeNull();
    expect(screen.queryByText("second note of laura")).toBeNull();
    expect(screen.queryByText(/didn't go through/i)).toBeNull();
    expect(screen.queryByDisplayValue(/draft of laura/)).toBeNull();
    // Il messaggio consegnato è nel flusso: quello lo legge anche Roberta.
    expect(await screen.findByText("first note of laura")).toBeInTheDocument();
  });

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

  it("dopo il cambio di persona la conversazione si apre in fondo, anche quando il flusso arriva dopo", async () => {
    // happy-dom non impagina: l'altezza del contenuto la dice il numero di
    // voci del flusso, come farebbe il browser (48 px ciascuna).
    const proto = HTMLElement.prototype;
    const height = Object.getOwnPropertyDescriptor(proto, "scrollHeight");
    const client = Object.getOwnPropertyDescriptor(proto, "clientHeight");
    Object.defineProperty(proto, "scrollHeight", {
      configurable: true,
      get(this: HTMLElement) {
        return this.hasAttribute("data-conversation-scroll")
          ? this.querySelectorAll("li, [role='separator'], p").length * 48
          : 0;
      },
    });
    Object.defineProperty(proto, "clientHeight", {
      configurable: true,
      get(this: HTMLElement) {
        return this.hasAttribute("data-conversation-scroll") ? 300 : 0;
      },
    });
    try {
      const user = userEvent.setup();
      await as("p-giulia", () => api.sendMessage("cv-giulia-callbacks", { text: "Explain MKX-3" }));
      await api.whenIdle("cv-giulia-callbacks");
      renderWithData(<Harness id="cv-giulia-callbacks" to="p-marco" />, { personId: "p-giulia" });
      await screen.findByText("Explain MKX-3");
      await user.click(screen.getByRole("button", { name: "switch persona" }));
      await screen.findByText("The rest of this conversation is private for now.");
      const scroller = () =>
        document.querySelector<HTMLElement>("[data-conversation-scroll]")!;
      await waitFor(() => {
        const el = scroller();
        expect(el.scrollHeight).toBeGreaterThan(el.clientHeight);
        expect(el.scrollTop).toBe(el.scrollHeight);
      });
      expect(screen.queryByRole("button", { name: /new messages/i })).toBeNull();
    } finally {
      if (height) Object.defineProperty(proto, "scrollHeight", height);
      if (client) Object.defineProperty(proto, "clientHeight", client);
    }
  });
});

describe("Conversation: pillola «New messages»", () => {
  it("chi ha scorso in su non viene tirato giù: la pillola lo dice, e il clic porta in fondo", async () => {
    const proto = HTMLElement.prototype;
    const height = Object.getOwnPropertyDescriptor(proto, "scrollHeight");
    const client = Object.getOwnPropertyDescriptor(proto, "clientHeight");
    Object.defineProperty(proto, "scrollHeight", {
      configurable: true,
      get(this: HTMLElement) {
        return this.hasAttribute("data-conversation-scroll")
          ? this.querySelectorAll("li, [role='separator'], p").length * 48
          : 0;
      },
    });
    Object.defineProperty(proto, "clientHeight", {
      configurable: true,
      get(this: HTMLElement) {
        return this.hasAttribute("data-conversation-scroll") ? 300 : 0;
      },
    });
    try {
      const user = userEvent.setup();
      renderWithData(<Harness id="cv-giulia-week" />, { personId: "p-giulia" });
      await screen.findByText(/here is the week in your pinned projects/i);
      const scroller = document.querySelector<HTMLElement>("[data-conversation-scroll]")!;
      await waitFor(() => expect(scroller.scrollTop).toBe(scroller.scrollHeight));
      // In fondo arriva un messaggio: chi è in fondo ci resta, senza pillola.
      await act(() =>
        api.runScript("cv-giulia-week", [{ step: "say", text: "One more thing about MKX." }]),
      );
      await screen.findAllByText("One more thing about MKX.");
      expect(screen.queryByRole("button", { name: /new messages/i })).toBeNull();
      // Scorre in su e ne arriva un altro: resta dov'è, e la pillola compare.
      scroller.scrollTop = 0;
      fireEvent.scroll(scroller);
      await act(() =>
        api.runScript("cv-giulia-week", [{ step: "say", text: "And a last note on STW." }]),
      );
      await screen.findAllByText("And a last note on STW.");
      const pill = await screen.findByRole("button", { name: /new messages/i });
      expect(scroller.scrollTop).toBe(0);
      await user.click(pill);
      await waitFor(() => expect(screen.queryByRole("button", { name: /new messages/i })).toBeNull());
      expect(scroller.scrollTop).toBe(scroller.scrollHeight);
    } finally {
      if (height) Object.defineProperty(proto, "scrollHeight", height);
      if (client) Object.defineProperty(proto, "clientHeight", client);
    }
  });
});
