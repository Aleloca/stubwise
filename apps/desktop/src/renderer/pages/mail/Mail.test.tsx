import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mail, resetApi, setLatency } from "../../data/api";
import { MAIL_CASES } from "../../data/seed/mail";
import { setSessionPersonId } from "../../data/session";
import { state } from "../../data/store";
import { resetViewerGrants, revokeProjectPermission } from "../../data/viewer";
import { setMatchMedia } from "../../test/setup";
import { renderRoute } from "../../test/renderRoute";
import { closeGoogleAccount } from "../drive/GoogleAccountCard";
import { MAIL_TWO_UP_QUERY } from "./MailPage";
import { neutralize, revealImages } from "./UntrustedHtmlFrame";

// La pagina della Posta (Task 7, shape mail.md): filtri nell'indirizzo,
// contenuti estremi (Review Focus 5), proposte condivise e cambio di persona
// (Review Focus 2), conferma con e senza permesso, allineamento vecchio,
// analisi fallita, senza account Google, finestra stretta.

const threadOf = (id: string) => state.mailMessages.find((m) => m.id === id)!.threadId;
const search = (router: ReturnType<typeof renderRoute>) =>
  router.state.location.search as Record<string, string | undefined>;

async function openMail(url: string, personId = "p-giulia") {
  const router = renderRoute(url, personId);
  await screen.findByRole("heading", { level: 1, name: "Mail" });
  return router;
}

const list = () => screen.findByRole("listbox", { name: "Conversations" });
const pane = (threadId: string) =>
  waitFor(() => {
    const el = document.querySelector<HTMLElement>(`[data-reading-pane="${threadId}"]`);
    if (!el) throw new Error("no pane");
    return el;
  });
const card = (id: string) =>
  waitFor(() => {
    const el = document.querySelector<HTMLElement>(`[data-mail-proposal="${id}"]`);
    if (!el) throw new Error(`no card ${id}`);
    return el;
  });

async function switchPersona(name: RegExp) {
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Profile and settings" }));
  const menu = await screen.findByRole("dialog", { name: "Profile and settings" });
  await user.click(within(menu).getByRole("radio", { name }));
}

beforeEach(() => {
  setLatency(0);
  resetApi();
  setMatchMedia(MAIL_TWO_UP_QUERY, true);
});
afterEach(() => {
  resetViewerGrants();
  closeGoogleAccount();
  setSessionPersonId("p-giulia");
});

describe("Posta — elenco e filtri nell'indirizzo", () => {
  it("le righe dicono progetto, importanza e proposte; i filtri vanno e tornano dall'indirizzo", async () => {
    const router = await openMail("/mail");
    const box = await list();
    const shared = within(box).getByRole("option", { name: /Billing export/ });
    expect(shared).toHaveAccessibleName(/^Unread · High importance · Sofia Marchetti/);
    expect(shared).toHaveAccessibleName(/AUD Audin 2\.0/);
    expect(shared).toHaveAccessibleName(/1 proposal to decide/);
    expect(within(shared).getByText("1 to decide")).toBeInTheDocument();
    // Bassa importanza: in parole, senza glifo.
    expect(within(box).getByRole("option", { name: /Smashing Newsletter/ })).toHaveAccessibleName(
      /Low importance/,
    );

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /^Importance/ }));
    await user.click(await screen.findByRole("menuitemradio", { name: "High" }));
    await waitFor(() => expect(search(router).importance).toBe("high"));
    await waitFor(() =>
      expect(within(screen.getByRole("listbox")).queryByRole("option", { name: /Smashing/ })).toBeNull(),
    );
    expect(within(screen.getByRole("listbox")).getAllByRole("option").length).toBeGreaterThan(0);
    for (const o of within(screen.getByRole("listbox")).getAllByRole("option")) {
      expect(o).toHaveAccessibleName(/High importance/);
    }
    await user.click(screen.getAllByRole("button", { name: "Clear filters" })[0]!);
    await waitFor(() => expect(search(router).importance).toBeUndefined());
  });

  it("«No project» (`project=none`) mostra solo la posta senza progetto, ed è una voce della colonna", async () => {
    await openMail("/mail?project=none");
    const box = await list();
    expect(within(box).getByRole("option", { name: /Cena domenica/ })).toBeInTheDocument();
    expect(within(box).queryByRole("option", { name: /Billing export/ })).toBeNull();
    const nav = screen.getByRole("navigation", { name: "Mail views" });
    expect(within(nav).getByRole("link", { name: "No project" })).toHaveAttribute("aria-current", "page");
  });

  it("la ricerca sta nell'indirizzo e un filtro senza risultati lo dice, con «Clear filters»", async () => {
    const router = await openMail("/mail?q=zzzz-nothing");
    expect(await screen.findByText("Nothing matches “zzzz-nothing”")).toBeInTheDocument();
    await userEvent.click(screen.getAllByRole("button", { name: "Clear filters" }).at(-1)!);
    await waitFor(() => expect(search(router).q).toBeUndefined());
    expect(await list()).toBeInTheDocument();
  });

  it("J/K scorrono le conversazioni e le aprono; Enter porta il fuoco nel pannello", async () => {
    const router = await openMail("/mail");
    const box = await list();
    const first = within(box).getAllByRole("option")[0]!;
    await userEvent.click(first);
    await waitFor(() => expect(router.state.location.pathname).toMatch(/^\/mail\/th-/));
    const firstPath = router.state.location.pathname;
    first.focus();
    await userEvent.keyboard("j");
    await waitFor(() => expect(router.state.location.pathname).not.toBe(firstPath));
    await userEvent.keyboard("k");
    await waitFor(() => expect(router.state.location.pathname).toBe(firstPath));
    await userEvent.keyboard("{Enter}");
    const threadId = firstPath.split("/").at(-1)!;
    expect(await pane(threadId)).toHaveFocus();
  });
});

describe("Posta — contenuti estremi (Review Focus 5)", () => {
  it("oggetto lunghissimo: una riga con ellissi in elenco, per intero nel pannello", async () => {
    const long = `Billing export ${"and the VAT column ".repeat(55)}end`;
    for (const m of state.mailMessages) if (m.id === MAIL_CASES.shared) m.subject = long;
    await openMail(`/mail/${threadOf(MAIL_CASES.shared)}`);
    const row = within(await list()).getByRole("option", { name: /Billing export and the VAT/ });
    const line = within(row).getByTitle(long);
    expect(line).toHaveClass("truncate");
    const heading = within(await pane(threadOf(MAIL_CASES.shared))).getByRole("heading", { level: 2 });
    expect(heading).toHaveTextContent(long);
    expect(heading).not.toHaveClass("truncate");
  });

  it("60 messaggi: aperto l'ultimo, i 59 chiusi in una fascia che li mostra come righe", async () => {
    const thread = threadOf(MAIL_CASES.longThread);
    await openMail(`/mail/${thread}`);
    const p = await pane(thread);
    const band = await within(p).findByRole("button", { name: "59 earlier messages" });
    expect(p.querySelectorAll("article[data-message]")).toHaveLength(1);
    await userEvent.click(band);
    expect(p.querySelectorAll("article[data-message]")).toHaveLength(60);
    // Aprire la fascia mostra le righe chiuse, non le espande.
    expect(p.querySelectorAll("article[data-collapsed]")).toHaveLength(59);
  });

  it("40 destinatari: «to <due del team> and 38 others», l'elenco si apre per gruppi e si richiude", async () => {
    const thread = threadOf(MAIL_CASES.fortyRecipients);
    await openMail(`/mail/${thread}`);
    const p = await pane(thread);
    expect(within(p).getByText(/to Giulia Ferri, Matteo Conti/)).toBeInTheDocument();
    await userEvent.click(within(p).getByRole("button", { name: "and 38 others" }));
    const listEl = p.querySelector<HTMLElement>("[data-recipients]")!;
    expect(listEl).toHaveTextContent(/To Matteo Conti, Speaker a1/);
    expect(listEl).toHaveTextContent(/Cc Giulia Ferri, Speaker c1/);
    expect(listEl).toHaveClass("max-h-40", "overflow-y-auto");
    await userEvent.click(within(p).getByRole("button", { name: "Show less" }));
    expect(p.querySelector("[data-recipients]")).toBeNull();
  });

  it("HTML ostile: di default il testo; l'originale in un frame senza permessi, niente script, immagini solo al clic", async () => {
    const thread = threadOf(MAIL_CASES.hostileHtml);
    await openMail(`/mail/${thread}`);
    const p = await pane(thread);
    expect(p.querySelector("iframe")).toBeNull();
    await userEvent.click(within(p).getAllByRole("button", { name: "Show original" })[0]!);
    const frame = within(p).getByTitle("Original message from Fiera Digitale");
    expect(frame.getAttribute("sandbox")).toBe("");
    const doc = () => frame.getAttribute("srcdoc") ?? "";
    expect(doc()).not.toMatch(/<script/i);
    expect(doc()).not.toMatch(/onclick/i);
    expect(doc()).not.toMatch(/<img[^>]*\ssrc="https:/i);
    expect(doc()).toContain('data-src="https://tracker.example/pixel.gif?u=giulia"');
    expect(doc()).toMatch(/img-src data:;/);
    expect(within(p).getByText("Remote images are blocked to protect your privacy.")).toBeInTheDocument();
    await userEvent.click(within(p).getByRole("button", { name: "Show images" }));
    expect(doc()).toContain('src="https://cdn.fieradigitale.example/banner.jpg"');
    expect(doc()).not.toMatch(/<script/i);
    expect(within(p).queryByRole("button", { name: "Show images" })).toBeNull();
    // «Show text» torna al testo pulito.
    await userEvent.click(within(p).getAllByRole("button", { name: "Show text" })[0]!);
    expect(p.querySelector("iframe")).toBeNull();
  });

  it("neutralize/revealImages: nessuno script né gestore, le immagini tornano solo coi loro indirizzi", () => {
    const { html, blockedImages } = neutralize(
      '<script>x()</script><img src="https://a.example/p.gif" onerror="x()"><img src="data:image/png;base64,AA"><a href="javascript:x()">y</a>',
    );
    expect(blockedImages).toBe(1);
    expect(html).not.toMatch(/script|onerror|javascript:/i);
    expect(html).toContain('src="data:image/png;base64,AA"');
    expect(revealImages(html)).toContain('src="https://a.example/p.gif"');
  });
});

describe("Posta — proposte condivise (Review Focus 2)", () => {
  it("esito altrui: chi ha deciso, quando, e il codice nato apribile", async () => {
    const thread = threadOf(MAIL_CASES.confirmed);
    await openMail(`/mail/${thread}`);
    const c = await card("mp-aud-callbacks-monday");
    expect(c).toHaveTextContent(/Confirmed by Matteo Conti/);
    expect(await within(c).findByRole("link", { name: /AUD-9/ })).toHaveAttribute(
      "href",
      "#/p/AUD/tasks?task=AUD-9",
    );
    expect(within(c).queryByRole("button", { name: "Confirm" })).toBeNull();
  });

  it("decisa da un altro mentre la avevo aperta: lo dice, nessuna task doppia", async () => {
    const thread = threadOf(MAIL_CASES.shared);
    await openMail(`/mail/${thread}`);
    const c = await card("mp-aud-billing-vat");
    expect(within(c).getByText(/Also for Matteo Conti, Laura Costa/)).toBeInTheDocument();
    const before = state.tasks.length;
    // Matteo conferma prima di Giulia.
    setSessionPersonId("p-matteo");
    await mail.confirmMailProposal("mp-aud-billing-vat");
    setSessionPersonId("p-giulia");
    expect(state.tasks.length).toBe(before + 1);
    await userEvent.click(within(c).getByRole("button", { name: "Confirm" }));
    const done = await card("mp-aud-billing-vat");
    await waitFor(() =>
      expect(done).toHaveTextContent(
        "Matteo Conti confirmed this a moment ago. Nothing was created twice.",
      ),
    );
    expect(done).toHaveTextContent(/Confirmed by Matteo Conti/);
    expect(state.tasks.length).toBe(before + 1);
  });

  it("cambio di persona con il passo «fuori dal progetto» aperto: si chiude senza effetti", async () => {
    const thread = threadOf(MAIL_CASES.transcript);
    await openMail(`/mail/${thread}`);
    const c = await card("mp-aud-weekly-review");
    expect(within(c).getByText(/Chiara Lombardi/)).toBeInTheDocument();
    expect(within(c).getByText("not in AUD")).toBeInTheDocument();
    await userEvent.click(within(c).getByRole("button", { name: "Confirm" }));
    expect(await within(c).findByRole("alert")).toHaveTextContent(/Chiara Lombardi isn't in AUD/);
    const tasks = state.tasks.length;
    await switchPersona(/Laura Costa/);
    const again = await card("mp-aud-weekly-review");
    expect(again.querySelector("[data-outsider-prompt]")).toBeNull();
    expect(document.querySelector("[data-outsider-prompt]")).toBeNull();
    expect(state.tasks.length).toBe(tasks);
    expect(state.mailProposals.find((p) => p.id === "mp-aud-weekly-review")!.status).toBe("open");
  });

  it("fuori dal progetto: «Leave unassigned» conferma senza aggiungere nessuno", async () => {
    const thread = threadOf(MAIL_CASES.transcript);
    await openMail(`/mail/${thread}`);
    const c = await card("mp-aud-weekly-review");
    // Conferma parziale: solo la task di Chiara.
    for (const box of within(c).getAllByRole("checkbox").slice(0, 3)) await userEvent.click(box);
    await userEvent.click(within(c).getByRole("button", { name: "Confirm 1 of 4" }));
    await within(c).findByRole("alert");
    await userEvent.click(within(c).getByRole("button", { name: /Leave unassigned|Confirm unassigned/ }));
    const done = await card("mp-aud-weekly-review");
    await waitFor(() => expect(done).toHaveTextContent(/Confirmed by you/));
    expect(done).toHaveTextContent("1 of 4 done");
    const project = state.projectsById.get("prj-aud")!;
    expect(project.memberIds).not.toContain("p-chiara");
  });
});

describe("Posta — conferma con e senza permesso", () => {
  it("con il permesso: modifica sul posto, poi Confirm crea la task con il titolo nuovo", async () => {
    const thread = threadOf(MAIL_CASES.stwHigh);
    await openMail(`/mail/${thread}`);
    const c = await card("mp-stw-copy-freeze");
    expect(within(c).queryByRole("button", { name: "Hand to the project" })).toBeNull();
    await userEvent.click(within(c).getByRole("button", { name: "Edit line 1" }));
    const title = within(c).getByLabelText("Title");
    await userEvent.clear(title);
    await userEvent.type(title, "Freeze the onboarding copy");
    await userEvent.click(within(c).getByRole("button", { name: "Done" }));
    expect(c).toHaveTextContent("Create task in STW: “Freeze the onboarding copy”");
    expect(c).toHaveTextContent("Edited");
    await userEvent.click(within(c).getByRole("button", { name: "Confirm" }));
    const done = await card("mp-stw-copy-freeze");
    await waitFor(() => expect(done).toHaveTextContent(/Confirmed by you/));
    expect(state.tasks.some((t) => t.title === "Freeze the onboarding copy")).toBe(true);
  });

  it("senza il permesso: righe in sola lettura, la frase del perché, «Hand to the project»", async () => {
    revokeProjectPermission("p-giulia", "prj-stw", "tickets.create" as never);
    const thread = threadOf(MAIL_CASES.stwHigh);
    await openMail(`/mail/${thread}`);
    const c = await card("mp-stw-copy-freeze");
    expect(c).toHaveTextContent(
      "You can't create tasks in STW. Hand it to the project and someone who can will decide.",
    );
    expect(within(c).queryByRole("button", { name: /^Edit/ })).toBeNull();
    expect(within(c).queryByRole("button", { name: "Confirm" })).toBeNull();
    await userEvent.click(within(c).getByRole("button", { name: "Hand to the project" }));
    const done = await card("mp-stw-copy-freeze");
    await waitFor(() => expect(done).toHaveTextContent(/Handed to the project by you/));
    expect(done).toHaveTextContent(/waiting for someone who can create tasks in STW/);
  });
});

describe("Posta — allineamento, analisi, stati", () => {
  it("oltre 5 minuti la casella è vecchia: «may be behind Gmail» e «Refresh now»; aggiornata non lo è", async () => {
    await openMail("/mail", "p-matteo");
    const status = await waitFor(() => {
      const el = document.querySelector<HTMLElement>("[data-sync]");
      if (!el) throw new Error("no status");
      return el;
    });
    expect(status).toHaveAttribute("data-sync", "stale");
    expect(status).toHaveTextContent("Updated 12 min ago — may be behind Gmail");
    setLatency(20);
    await userEvent.click(within(status).getByRole("button", { name: "Refresh now" }));
    await waitFor(() => expect(document.querySelector("[data-sync]")).toHaveTextContent("Updating…"));
    await waitFor(() => expect(document.querySelector("[data-sync]")).toHaveAttribute("data-sync", "ok"), {
      timeout: 3000,
    });
  });

  it("casella aggiornata da 2 minuti: «Updated 2 min ago · Refresh»", async () => {
    await openMail("/mail");
    await waitFor(() =>
      expect(document.querySelector("[data-sync]")).toHaveTextContent("Updated 2 min ago·Refresh"),
    );
  });

  it("analisi fallita → «Repropose» → in lettura → esito", async () => {
    const thread = threadOf(MAIL_CASES.failed);
    await openMail(`/mail/${thread}`, "p-matteo");
    const p = await pane(thread);
    expect(await within(p).findByText("Stubwise couldn't analyse this email.")).toBeInTheDocument();
    setLatency(20);
    await userEvent.click(within(p).getByRole("button", { name: "Repropose" }));
    expect(await within(p).findByText("Stubwise is reading this email…")).toBeInTheDocument();
    await waitFor(() => expect(within(p).queryByText("Stubwise couldn't analyse this email.")).toBeNull());
  });

  it("collegamento scaduto: la fascia lo dice con «Reconnect», l'elenco resta leggibile", async () => {
    await openMail("/mail", "p-laura");
    const banner = await waitFor(() => {
      const el = document.querySelector<HTMLElement>("[data-expired-banner]");
      if (!el) throw new Error("no banner");
      return el;
    });
    expect(banner).toHaveTextContent(/Your Google connection expired on Oct 18/);
    expect(within(banner).getByRole("button", { name: "Reconnect" })).toBeInTheDocument();
    expect(await list()).toBeInTheDocument();
  });

  it("senza account Google: «Connect your Google account», che apre la scheda dell'account", async () => {
    await openMail("/mail", "p-marco");
    expect(await screen.findByText(/Connect your Google account to read your mail here/)).toBeInTheDocument();
    expect(screen.queryByRole("listbox")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Connect Google account" }));
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
  });

  it("riunione registrata: riassunto e «Open the transcript» per chi c'era", async () => {
    const thread = threadOf(MAIL_CASES.transcript);
    await openMail(`/mail/${thread}`);
    const p = await pane(thread);
    expect(within(p).getByText("Recorded meeting")).toBeInTheDocument();
    expect(within(p).getByText("Generated by Stubwise from the transcript")).toBeInTheDocument();
    expect(within(p).getByRole("button", { name: "Open the transcript" })).toBeInTheDocument();
  });

  it("conversazione che non vedo: la stessa frase di una che non esiste", async () => {
    await openMail(`/mail/${threadOf(MAIL_CASES.lauraOff)}`);
    expect(await screen.findByText("This conversation doesn't exist or you can't see it")).toBeInTheDocument();
    await act(() => Promise.resolve());
  });

  it("finestra stretta: uno per volta, con «← Mail» per tornare all'elenco", async () => {
    setMatchMedia(MAIL_TWO_UP_QUERY, false);
    const thread = threadOf(MAIL_CASES.shared);
    const router = await openMail(`/mail/${thread}`);
    const p = await pane(thread);
    expect(screen.queryByRole("listbox")).toBeNull();
    await userEvent.click(within(p).getByRole("link", { name: "Mail" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/mail"));
    expect(await list()).toBeInTheDocument();
  });
});
