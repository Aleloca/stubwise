import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { beforeEach, describe, expect, it } from "vitest";
import * as api from "../../data/api";
import { PEOPLE } from "../../data/seed/people";
import { setSessionPersonId } from "../../data/session";
import { state, visibleProjectIds } from "../../data/store";
import type { ChatMessage } from "../../data/types";
import { useViewer } from "../../data/viewer";
import { renderWithData } from "../../test/renderWithData";
import { ChannelView } from "./ChannelView";
import { clearDrafts, readDraft } from "./drafts";

beforeEach(() => {
  api.setLatency(0);
  api.setStreamLatency(null);
  api.resetApi();
  clearDrafts();
});

/** Il canale come lo monta la route: chiavato per persona e canale, con «vedi come». */
function Harness({ id, to }: { id: string; to?: string }) {
  const { viewer, setPersona } = useViewer();
  return (
    <div style={{ height: 800 }}>
      {to && (
        <button type="button" onClick={() => setPersona(to)}>
          switch persona
        </button>
      )}
      <ChannelView key={`${viewer.personId}:${id}`} channelId={id} />
    </div>
  );
}

const flow = () => screen.getByRole("log");
/** Il messaggio subito dopo la riga «New». */
const newLineBefore = () =>
  flow().querySelector("[data-new-line]")?.nextElementSibling?.getAttribute("data-message") ?? null;

/** Il primo messaggio non letto (non suo) di una persona in un canale, dal livello dati. */
async function firstUnread(personId: string, channelId: string): Promise<string | null> {
  setSessionPersonId(personId);
  const page = (await api.chat.listMessages(channelId))!;
  setSessionPersonId("p-giulia");
  const read = page.lastReadAt;
  return (
    page.messages.find((m) => read !== null && m.createdAt > read && m.authorId !== personId)?.id ??
    null
  );
}
const composer = () => screen.getByRole("combobox", { name: /^Message / });

/** Un messaggio scritto a mano nello stato, come il seme. */
function put(
  m: Partial<ChatMessage> & Pick<ChatMessage, "id" | "channelId" | "createdAt">,
): ChatMessage {
  const full: ChatMessage = {
    threadOf: null,
    authorId: "p-marco",
    kind: "person",
    text: "",
    attachments: [],
    citations: [],
    reactions: [],
    asksReplyOf: [],
    linkedCodes: [],
    editedAt: null,
    deletedAt: null,
    deletedById: null,
    ...m,
  };
  state.chatMessages.push(full);
  return full;
}

describe("ChannelView: flusso", () => {
  it("testata, giorni, gruppi e la riga «New» dove Giulia aveva smesso di leggere", async () => {
    renderWithData(<Harness id="ch-aud-general" />, { personId: "p-giulia" });
    const h1 = await screen.findByRole("heading", { level: 1 });
    expect(h1.textContent).toBe("AUD · general");
    await waitFor(() => expect(flow().querySelector("[data-new-line]")).not.toBeNull());
    expect(within(flow()).getAllByRole("heading", { level: 2 }).length).toBeGreaterThan(1);
    // La riga «New» viene prima di un messaggio non suo arrivato dopo la lettura.
    const line = flow().querySelector("[data-new-line]")!;
    const next = line.nextElementSibling as HTMLElement;
    expect(next.getAttribute("data-message") ?? next.getAttribute("data-system-card")).toBeTruthy();
  });

  it("«People only» toglie le schede di sistema; una scheda apre il suo oggetto", async () => {
    const user = userEvent.setup();
    renderWithData(<Harness id="ch-aud-releases" />, { personId: "p-laura" });
    await waitFor(() => expect(flow().querySelector("[data-system-card]")).not.toBeNull());
    const card = flow().querySelector<HTMLElement>("[data-system-card]")!;
    await waitFor(() =>
      expect(within(card).getByRole("link", { name: /^Open / })).toBeInTheDocument(),
    );
    const open = within(card).getByRole("link", { name: /^Open / });
    expect(open.getAttribute("href")).toMatch(/^#\/p\/AUD\//);
    await user.click(screen.getByRole("button", { name: "People only" }));
    expect(flow().querySelector("[data-system-card]")).toBeNull();
  });

  it("una citazione invisibile resta il solo codice tenue, non apribile (R-E9)", async () => {
    const hidden = state.tasks.find((t) => !visibleProjectIds("p-giulia").has(t.projectId))!;
    const mkx7 = state.tasks.find((t) => t.code === "MKX-7")!;
    put({
      id: "m-hidden",
      channelId: "ch-mkx-general",
      createdAt: "2026-10-23T11:00:00Z",
      authorId: "p-paolo",
      text: `Linked ${hidden.code} to MKX-7 for the launch`,
      citations: [
        { kind: "task", id: hidden.id },
        { kind: "task", id: mkx7.id },
      ],
    });
    renderWithData(<Harness id="ch-mkx-general" />, { personId: "p-giulia" });
    const row = await waitFor(() => {
      const el = flow().querySelector<HTMLElement>('[data-message="m-hidden"]');
      expect(el?.querySelector('[data-citation="hidden"]')).toBeTruthy();
      return el!;
    });
    const faint = row.querySelector('[data-citation="hidden"]')!;
    expect(faint.textContent).toBe(hidden.code);
    expect(faint.tagName).not.toBe("A");
    expect(row.textContent).not.toContain(hidden.title);
    // Quella visibile: codice + nome, apribile.
    const link = row.querySelector(`[data-citation="task:${mkx7.id}"]`)!;
    expect(link.tagName).toBe("A");
    expect(link.textContent).toBe(`MKX-7 ${mkx7.title}`);
  });

  it("i codici scritti a mano e non citati si risolvono per chi legge: link, tenue o testo", async () => {
    const hidden = state.tasks.find((t) => !visibleProjectIds("p-giulia").has(t.projectId))!;
    const mkx7 = state.tasks.find((t) => t.code === "MKX-7")!;
    put({
      id: "m-uncited",
      channelId: "ch-mkx-general",
      createdAt: "2026-10-23T11:00:00Z",
      authorId: "p-paolo",
      text: `MKX-7 waits on ${hidden.code}, as ISO-9001 asks`,
      // Nessuna citazione: è testo scritto a mano.
      citations: [],
    });
    renderWithData(<Harness id="ch-mkx-general" />, { personId: "p-giulia" });
    const row = await waitFor(() => {
      const el = flow().querySelector<HTMLElement>('[data-message="m-uncited"]');
      expect(el?.querySelector('[data-citation="hidden"]')).toBeTruthy();
      expect(el?.querySelector(`[data-citation="task:${mkx7.id}"]`)).toBeTruthy();
      return el!;
    });
    expect(row.querySelector('[data-citation="hidden"]')!.textContent).toBe(hidden.code);
    expect(row.querySelector(`[data-citation="task:${mkx7.id}"]`)!.tagName).toBe("A");
    // Un codice di nessun oggetto resta testo: né link né tenue.
    const iso = [...row.querySelectorAll("[data-citation]")].filter((el) =>
      el.textContent?.includes("ISO-9001"),
    );
    expect(iso).toEqual([]);
    expect(row.textContent).toContain("as ISO-9001 asks");
    expect(row.textContent).not.toContain(hidden.title);
  });
});

describe("ChannelView: reazioni, modifica, eliminazione", () => {
  it("un clic sul gettone mette e toglie la propria reazione", async () => {
    const user = userEvent.setup();
    put({
      id: "m-react",
      channelId: "ch-mkx-grafica",
      createdAt: "2026-10-23T11:00:00Z",
      text: "Final banner is up",
      reactions: [{ emoji: "👍", personIds: ["p-chiara"] }],
    });
    renderWithData(<Harness id="ch-mkx-grafica" />, { personId: "p-giulia" });
    const chip = await waitFor(() => {
      const el = flow().querySelector<HTMLButtonElement>(
        '[data-message="m-react"] [data-reaction="👍"]',
      );
      expect(el).not.toBeNull();
      return el!;
    });
    expect(chip).toHaveAttribute("aria-pressed", "false");
    expect(chip.getAttribute("aria-label")).toBe("Chiara Lombardi reacted with 👍");
    await user.click(chip);
    await waitFor(() => {
      const el = flow().querySelector('[data-message="m-react"] [data-reaction="👍"]')!;
      expect(el).toHaveAttribute("aria-pressed", "true");
      expect(el.textContent).toContain("2");
    });
    await user.click(flow().querySelector('[data-message="m-react"] [data-reaction="👍"]')!);
    await waitFor(() =>
      expect(flow().querySelector('[data-message="m-react"] [data-reaction="👍"]')).toHaveAttribute(
        "aria-pressed",
        "false",
      ),
    );
  });

  it("Edit e Delete solo sui propri messaggi; modificato e eliminato si vedono", async () => {
    const user = userEvent.setup();
    put({
      id: "m-other",
      channelId: "ch-mkx-grafica",
      createdAt: "2026-10-23T11:00:00Z",
      text: "Theirs",
    });
    put({
      id: "m-mine",
      channelId: "ch-mkx-grafica",
      createdAt: "2026-10-23T11:01:00Z",
      authorId: "p-giulia",
      text: "Mine",
    });
    renderWithData(<Harness id="ch-mkx-grafica" />, { personId: "p-giulia" });
    await waitFor(() => expect(flow().querySelector('[data-message="m-mine"]')).not.toBeNull());

    const other = flow().querySelector<HTMLElement>('[data-message="m-other"]')!;
    await user.click(within(other).getByRole("button", { name: "More actions" }));
    let menu = screen.getByRole("menu", { name: "Message actions" });
    expect(within(menu).queryByRole("menuitem", { name: "Edit" })).toBeNull();
    expect(within(menu).queryByRole("menuitem", { name: "Delete" })).toBeNull();
    await user.keyboard("{Escape}");

    const mine = flow().querySelector<HTMLElement>('[data-message="m-mine"]')!;
    await user.click(within(mine).getByRole("button", { name: "More actions" }));
    menu = screen.getByRole("menu", { name: "Message actions" });
    await user.click(within(menu).getByRole("menuitem", { name: "Edit" }));
    const box = within(mine).getByRole("textbox", { name: "Edit message" });
    await user.clear(box);
    await user.type(box, "Mine, fixed{Enter}");
    await waitFor(() => {
      const el = flow().querySelector('[data-message="m-mine"]')!;
      expect(el.textContent).toContain("Mine, fixed");
      expect(el.textContent).toContain("(edited)");
    });

    const again = flow().querySelector<HTMLElement>('[data-message="m-mine"]')!;
    await user.click(within(again).getByRole("button", { name: "More actions" }));
    await user.click(
      within(screen.getByRole("menu", { name: "Message actions" })).getByRole("menuitem", {
        name: "Delete",
      }),
    );
    expect(within(again).getByText("Delete this message?")).toBeInTheDocument();
    await user.click(within(again).getByRole("button", { name: "Delete" }));
    await waitFor(() => {
      const el = flow().querySelector('[data-message="m-mine"]')!;
      expect(el.querySelector("[data-deleted]")?.textContent).toBe("Message deleted");
      expect(el.textContent).not.toContain("Mine, fixed");
    });
  });

  it("↑ nella casella vuota modifica il mio ultimo messaggio", async () => {
    const user = userEvent.setup();
    put({
      id: "m-last",
      channelId: "ch-mkx-grafica",
      createdAt: "2026-10-23T11:01:00Z",
      authorId: "p-giulia",
      text: "Last of mine",
    });
    renderWithData(<Harness id="ch-mkx-grafica" />, { personId: "p-giulia" });
    await waitFor(() => expect(flow().querySelector('[data-message="m-last"]')).not.toBeNull());
    await user.click(composer());
    await user.keyboard("{ArrowUp}");
    const box = within(flow().querySelector<HTMLElement>('[data-message="m-last"]')!).getByRole(
      "textbox",
      { name: "Edit message" },
    );
    expect(box).toHaveValue("Last of mine");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("textbox", { name: "Edit message" })).toBeNull();
  });
});

describe("ChannelView: lettori di schermo e salti", () => {
  it("il flusso non è una regione viva; gli arrivi si annunciano insieme, una volta", async () => {
    renderWithData(<Harness id="ch-mkx-grafica" />, { personId: "p-giulia" });
    await waitFor(() =>
      expect(flow().querySelectorAll("[data-message]").length).toBeGreaterThan(0),
    );
    expect(flow()).toHaveAttribute("aria-live", "off");
    const region = document.querySelector<HTMLElement>("[data-chat-announce]")!;
    expect(region).toHaveAttribute("aria-live", "polite");
    const said: string[] = [];
    const observer = new MutationObserver(() => said.push(region.textContent ?? ""));
    observer.observe(region, { childList: true, characterData: true, subtree: true });
    // Due messaggi di Chiara arrivati dal vivo, uno dopo l'altro (dallo stesso
    // motore dello stream, senza cambiare la persona della sessione).
    const incoming = (id: string, text: string, at: string): ChatMessage => ({
      id,
      channelId: "ch-mkx-grafica",
      threadOf: null,
      authorId: "p-chiara",
      kind: "person",
      text,
      attachments: [],
      citations: [],
      reactions: [],
      asksReplyOf: [],
      linkedCodes: [],
      createdAt: at,
      editedAt: null,
      deletedAt: null,
      deletedById: null,
    });
    // Ognuno al suo turno (un render a testa): l'annuncio li somma lo stesso.
    api.setStreamLatency(80);
    // Fuori da `act`: ogni messaggio è un render a sé, come dal vivo.
    const script = api.runScript(api.chat.channelStream("ch-mkx-grafica"), [
      {
        step: "post",
        message: incoming("m-live-1", "First proof is up", "2026-10-23T12:00:01Z"),
      },
      { step: "post", message: incoming("m-live-2", "Second proof too", "2026-10-23T12:00:02Z") },
    ]);
    await waitFor(() => expect(flow().textContent).toContain("First proof is up"));
    await waitFor(() => expect(flow().textContent).toContain("Second proof too"));
    await act(() => script);
    await waitFor(() => expect(region.textContent).toBe("2 new messages"), { timeout: 3000 });
    observer.disconnect();
    expect(said.filter(Boolean)).toEqual(["2 new messages"]);
  });

  it("un `?message=` nuovo con il canale aperto porta in vista quel messaggio", async () => {
    put({
      id: "m-far",
      channelId: "ch-mkx-grafica",
      createdAt: "2026-09-01T09:00:00Z",
      text: "Far",
    });
    function Focus() {
      const [focus, setFocus] = useState<string | undefined>(undefined);
      return (
        <div style={{ height: 800 }}>
          <button type="button" onClick={() => setFocus("m-far")}>
            jump
          </button>
          <ChannelView channelId="ch-mkx-grafica" focusMessageId={focus} />
        </div>
      );
    }
    const user = userEvent.setup();
    renderWithData(<Focus />, { personId: "p-giulia" });
    const target = await waitFor(() => {
      const el = flow().querySelector<HTMLElement>("#message-m-far");
      expect(el).not.toBeNull();
      return el!;
    });
    const el = flow();
    Object.defineProperty(el, "scrollHeight", { configurable: true, get: () => 5000 });
    Object.defineProperty(el, "clientHeight", { configurable: true, get: () => 600 });
    Object.defineProperty(target, "offsetTop", { configurable: true, get: () => 1200 });
    el.scrollTop = 4400;
    await user.click(screen.getByRole("button", { name: "jump" }));
    expect(el.scrollTop).toBe(1200 - 56);
  });
});

describe("ChannelView: crea task dal messaggio", () => {
  it("la task nasce precompilata e il messaggio la mostra («→ codice»)", async () => {
    const user = userEvent.setup();
    put({
      id: "m-task",
      channelId: "ch-mkx-grafica",
      createdAt: "2026-10-23T11:00:00Z",
      text: "Banner copy needs a review\nThe Italian line is too long.",
    });
    renderWithData(<Harness id="ch-mkx-grafica" />, { personId: "p-giulia" });
    const row = await waitFor(() => {
      const el = flow().querySelector<HTMLElement>('[data-message="m-task"]');
      expect(el).not.toBeNull();
      return el!;
    });
    await user.click(within(row).getByRole("button", { name: "More actions" }));
    await user.click(
      within(screen.getByRole("menu", { name: "Message actions" })).getByRole("menuitem", {
        name: "Create task",
      }),
    );
    const dialog = await screen.findByRole("dialog", { name: "New task" });
    expect(within(dialog).getByRole("textbox", { name: /title/i })).toHaveValue(
      "Banner copy needs a review",
    );
    await user.click(within(dialog).getByRole("button", { name: "Create task" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "New task" })).toBeNull());
    const created = state.tasks.at(-1)!;
    expect(created.projectId).toBe("prj-mkx");
    expect(created.description).toContain("#/chat/ch-mkx-grafica?message=m-task");
    await waitFor(() => {
      const linked = flow().querySelector('[data-message="m-task"] [data-linked]');
      expect(linked?.textContent).toContain(`${created.code} ${created.title}`);
    });
  });
});

describe("ChannelView: casella e invio", () => {
  it("Invio manda; se non passa resta «Not sent» con Resend", async () => {
    const user = userEvent.setup();
    renderWithData(<Harness id="ch-mkx-grafica" />, { personId: "p-giulia" });
    await waitFor(() => expect(composer()).toBeInTheDocument());
    api.failNext("chat.sendMessage");
    await user.upload(
      document.querySelector<HTMLInputElement>("[data-chat-file-input]")!,
      new File(["x"], "proof-v2.pdf", { type: "application/pdf" }),
    );
    await user.type(composer(), "Proofs are on the drive{Enter}");
    const failed = await screen.findByText("Not sent");
    expect(composer()).toHaveValue("");
    const item = failed.closest("[data-local-send]") as HTMLElement;
    expect(item.textContent).toContain("Proofs are on the drive");
    // Anche l'allegato resta visibile, con il suo nome.
    expect(within(item).getByText("proof-v2.pdf")).toBeInTheDocument();
    await user.click(within(item).getByRole("button", { name: "Resend" }));
    await waitFor(() => expect(screen.queryByText("Not sent")).toBeNull());
    await waitFor(() =>
      expect(
        [...flow().querySelectorAll("[data-message]")].some((el) =>
          el.textContent?.includes("Proofs are on the drive"),
        ),
      ).toBe(true),
    );
  });

  it("«@» offre le persone del canale, i reparti, @channel e @Claude; nessun «/»", async () => {
    const user = userEvent.setup();
    renderWithData(<Harness id="ch-mkx-grafica" />, { personId: "p-giulia" });
    await waitFor(() => expect(composer()).toBeInTheDocument());
    await user.type(composer(), "/");
    expect(screen.queryByRole("listbox")).toBeNull();
    await user.clear(composer());
    await user.type(composer(), "@");
    const menu = await screen.findByRole("listbox", { name: /people/i });
    await waitFor(() =>
      expect(within(menu).getByRole("group", { name: "People" })).toBeInTheDocument(),
    );
    expect(within(menu).getByRole("group", { name: "Departments" })).toBeInTheDocument();
    expect(within(menu).getByText("@channel")).toBeInTheDocument();
    expect(within(menu).getByText("@Claude")).toBeInTheDocument();
    // Le persone del canale vengono prima.
    const first = within(within(menu).getByRole("group", { name: "People" })).getAllByRole(
      "option",
    )[0]!;
    const members = state.channels.find((c) => c.id === "ch-mkx-grafica")!.memberIds;
    const firstName = first.textContent ?? "";
    const names = PEOPLE.filter((p) => members.includes(p.id)).map((p) => p.name);
    expect(names.some((n) => firstName.includes(n))).toBe(true);
  });

  it("archiviato: sola lettura; aperto non membro: «Join channel» al posto della casella", async () => {
    const user = userEvent.setup();
    const { unmount } = renderWithData(<Harness id="ch-mkx-autumn" />, { personId: "p-giulia" });
    expect(await screen.findByText(/This channel is archived/)).toBeInTheDocument();
    expect(screen.queryByRole("combobox")).toBeNull();
    unmount();
    renderWithData(<Harness id="ch-marketing" />, { personId: "p-sara" });
    expect(await screen.findByText("You're not in this channel.")).toBeInTheDocument();
    expect(screen.queryByRole("combobox")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Join channel" }));
    expect(
      await screen.findByRole("combobox", { name: /^Message # marketing/ }),
    ).toBeInTheDocument();
  });
});

describe("ChannelView: Review Focus 2 — cambio di persona", () => {
  it("flusso, bozza e riga «New» di Giulia non restano a Marco", async () => {
    const user = userEvent.setup();
    const giuliaFirst = await firstUnread("p-giulia", "ch-aud-general");
    const marcoFirst = await firstUnread("p-marco", "ch-aud-general");
    // Le due letture sono diverse: altrimenti il test non distinguerebbe nulla.
    expect(giuliaFirst).not.toBeNull();
    expect(marcoFirst).not.toBeNull();
    expect(marcoFirst).not.toBe(giuliaFirst);
    renderWithData(<Harness id="ch-aud-general" to="p-marco" />, { personId: "p-giulia" });
    await waitFor(() => expect(flow().querySelector("[data-new-line]")).not.toBeNull());
    expect(newLineBefore()).toBe(giuliaFirst);
    expect(flow().querySelectorAll("[data-new-line]").length).toBe(1);
    await user.type(composer(), "Giulia's private draft");
    expect(readDraft("p-giulia", "ch-aud-general")).toBe("Giulia's private draft");

    await user.click(screen.getByRole("button", { name: "switch persona" }));
    await waitFor(() => expect(composer()).toBeInTheDocument());
    expect(composer()).toHaveValue("");
    expect(screen.queryByDisplayValue(/Giulia's private draft/)).toBeNull();
    expect(readDraft("p-giulia", "ch-aud-general")).toBe("");
    // La riga «New» è quella di Marco (letto fino a stamattina), non quella di Giulia.
    await waitFor(() =>
      expect(flow().querySelectorAll("[data-message]").length).toBeGreaterThan(0),
    );
    // La riga «New» è quella di Marco, una sola, prima del suo primo non letto.
    await waitFor(() => expect(newLineBefore()).toBe(marcoFirst));
    expect(flow().querySelectorAll("[data-new-line]").length).toBe(1);
  });

  it("un DM aperto non lascia nulla a chi non ne fa parte", async () => {
    const user = userEvent.setup();
    renderWithData(<Harness id="dm-giulia-marco" to="p-sara" />, { personId: "p-giulia" });
    await waitFor(() =>
      expect(flow().querySelectorAll("[data-message]").length).toBeGreaterThan(0),
    );
    const texts = [...flow().querySelectorAll("[data-message]")].map((el) => el.textContent ?? "");
    await user.type(composer(), "between us");
    await user.click(screen.getByRole("button", { name: "switch persona" }));
    expect(
      await screen.findByText("This channel doesn't exist or you can't see it."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("log")).toBeNull();
    expect(screen.queryByRole("combobox")).toBeNull();
    const page = document.body.textContent ?? "";
    for (const text of texts) expect(page).not.toContain(text.slice(0, 30));
    expect(page).not.toContain("between us");
  });
});

describe("ChannelView: Review Focus 5 — contenuti estremi", () => {
  const LONG_NAME = "coordinamento-campagna-autunnale-milano";

  async function extremeChannel(): Promise<string> {
    setSessionPersonId("p-giulia");
    const ch = await api.chat.createChannel({
      projectId: "prj-mkx",
      name: LONG_NAME,
      visibility: "open",
    });
    const start = Date.parse("2026-10-20T08:00:00Z");
    for (let i = 0; i < 300; i++) {
      put({
        id: `x-${i}`,
        channelId: ch.id,
        authorId: i % 2 ? "p-giulia" : "p-marco",
        createdAt: new Date(start + i * 7 * 60_000).toISOString().replace(/\.\d{3}Z$/, "Z"),
        text: `Message number ${i}`,
      });
    }
    const last = state.chatMessages.find((m) => m.id === "x-299")!;
    last.text = `${"Lunghissimo ".repeat(340)}\n\n\`\`\`ts\n${"const x = 1; ".repeat(80)}\n\`\`\``;
    const emoji = [
      ..."😀😄😂🙂😉😍🤔😅😬😮😢😴🤯🥳😎👍👎👏🙌🙏👋💪🤝👀✅❌🚀🐛🔥💡📌📎📈📉⏳🔒🧪📝📣🎯",
    ];
    last.reactions = emoji.slice(0, 40).map((e) => ({ emoji: e, personIds: ["p-marco"] }));
    return ch.id;
  }

  it("300 messaggi: si apre con gli ultimi 50 e «Load earlier»; niente si allarga", async () => {
    const id = await extremeChannel();
    renderWithData(<Harness id={id} />, { personId: "p-giulia" });
    const h1 = await screen.findByRole("heading", { level: 1 });
    expect(h1).toHaveAttribute("title", `MKX · ${LONG_NAME}`);
    expect(h1.className).toMatch(/\btruncate\b/);
    expect(h1.className).toMatch(/\bmin-w-0\b/);
    await waitFor(() => expect(flow().querySelector('[data-message="x-299"]')).not.toBeNull());
    expect(flow().querySelectorAll("[data-message]").length).toBe(50);
    expect(screen.getByRole("button", { name: "Load earlier messages" })).toBeInTheDocument();

    // La pagina non scorre in orizzontale: lo fa solo il blocco di codice.
    expect(flow().className).toMatch(/overflow-x-hidden/);
    expect(flow().className).toMatch(/\bmin-w-0\b/);
    const row = flow().querySelector<HTMLElement>('[data-message="x-299"]')!;
    const code = row.querySelector("pre")!;
    expect(code.closest("[class*='overflow-x-auto']")).not.toBeNull();
    // 40 reazioni vanno a capo.
    const reactions = within(row).getByRole("list", { name: "Reactions" });
    expect(reactions.className).toMatch(/flex-wrap/);
    expect(reactions.querySelectorAll("[data-reaction]").length).toBe(40);
    // Il testo lungo si spezza dentro la colonna di lettura.
    expect(row.querySelector(".max-w-\\[72ch\\]")).not.toBeNull();
  });

  it("caricare i più vecchi tiene fermo ciò che si stava leggendo", async () => {
    const id = await extremeChannel();
    renderWithData(<Harness id={id} />, { personId: "p-giulia" });
    await waitFor(() => expect(flow().querySelector('[data-message="x-299"]')).not.toBeNull());
    const el = flow();
    // happy-dom non impagina: l'altezza la dà il numero di messaggi (40px l'uno).
    Object.defineProperty(el, "scrollHeight", {
      configurable: true,
      get: () => el.querySelectorAll("[data-message]").length * 40,
    });
    Object.defineProperty(el, "clientHeight", { configurable: true, get: () => 600 });
    el.scrollTop = 400;
    const fromBottom = el.scrollHeight - el.scrollTop;
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Load earlier messages" }));
    });
    await waitFor(() => expect(el.querySelectorAll("[data-message]").length).toBe(100));
    expect(el.scrollHeight - el.scrollTop).toBe(fromBottom);
    expect(el.querySelector('[data-message="x-299"]')).not.toBeNull();
  });
});
