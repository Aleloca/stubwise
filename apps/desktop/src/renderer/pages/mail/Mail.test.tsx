import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { failNext, mail, resetApi, setLatency } from "../../data/api";
import { EV_AUD_REVIEW_YESTERDAY, MAIL_CASES } from "../../data/seed/mail";
import { setSessionPersonId } from "../../data/session";
import { state } from "../../data/store";
import { resetViewerGrants, revokeProjectPermission } from "../../data/viewer";
import { setMatchMedia } from "../../test/setup";
import { renderRoute } from "../../test/renderRoute";
import { closeGoogleAccount } from "../drive/GoogleAccountCard";
import { MAIL_TWO_UP_QUERY } from "./MailPage";
import { neutralize, revealImages, scrubTree } from "./UntrustedHtmlFrame";

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

  it("«Show images» non si ricorda: richiudendo e riaprendo l'originale le immagini sono di nuovo bloccate", async () => {
    const thread = threadOf(MAIL_CASES.hostileHtml);
    await openMail(`/mail/${thread}`);
    const p = await pane(thread);
    await userEvent.click(within(p).getAllByRole("button", { name: "Show original" })[0]!);
    await userEvent.click(within(p).getByRole("button", { name: "Show images" }));
    expect(within(p).getByTitle(/Original message/).getAttribute("srcdoc")).toMatch(/\ssrc="https:\/\/cdn\./);
    await userEvent.click(within(p).getAllByRole("button", { name: "Show text" })[0]!);
    await userEvent.click(within(p).getAllByRole("button", { name: "Show original" })[0]!);
    expect(within(p).getByRole("button", { name: "Show images" })).toBeInTheDocument();
    expect(within(p).getByTitle(/Original message/).getAttribute("srcdoc")).not.toMatch(/\ssrc="https:\/\/cdn\./);
  });

  it("neutralize: niente target nei link, niente base/meta; contano anche src senza virgolette, srcset e url() dei CSS", () => {
    const { html, blockedImages } = neutralize(
      '<base href="https://evil.example/"><meta http-equiv="refresh" content="0;url=https://evil.example">' +
        '<a href="https://x.example" target="_self">a</a><a target=_top href="https://y.example">b</a>' +
        '<img src=https://a.example/u.gif><img srcset="https://a.example/1x.png 1x, https://a.example/2x.png 2x">' +
        '<div style="background:url(https://a.example/bg.png)">c</div>',
    );
    expect(html).not.toMatch(/target=|<base|<meta/i);
    expect(html).toContain('data-src="https://a.example/u.gif"');
    expect(html).toContain('data-srcset="https://a.example/1x.png 1x, https://a.example/2x.png 2x"');
    expect(html).not.toMatch(/\ssrcset=|\ssrc=https/);
    expect(blockedImages).toBe(3);
    const shown = revealImages(html);
    expect(shown).toContain('src="https://a.example/u.gif"');
    expect(shown).toContain('srcset="https://a.example/1x.png 1x');
  });

  it("neutralize su DOM: niente gestori nascosti nelle virgolette, niente javascript: in nessuna forma", () => {
    const quoted = neutralize(`<img src='http://x/" onerror="alert(1)'>`);
    // Riletto come lo leggerà il frame: un solo attributo, l'indirizzo intero tenuto da parte.
    const img = new DOMParser().parseFromString(quoted.html, "text/html").querySelector("img")!;
    expect(img.getAttributeNames()).toEqual(["data-src"]);
    expect(img.getAttribute("data-src")).toBe('http://x/" onerror="alert(1)');
    expect(quoted.blockedImages).toBe(1);
    for (const payload of [
      '<a href="javascript:void(0); x">a</a>',
      `<a href="javascript:alert('1')">b</a>`,
      '<a href=" JaVaScRiPt:alert(1)">c</a>',
      '<a href="vbscript:msgbox(1)">d</a>',
      '<a href="data:text/html,<script>alert(1)</script>">e</a>',
      '<form action="javascript:alert(1)"><button formaction="javascript:alert(1)">f</button></form>',
    ]) {
      const { html } = neutralize(payload);
      expect(html, payload).not.toMatch(/javascript:|vbscript:|data:text/i);
    }
    // L'iframe con `srcdoc`, non con un indirizzo: happy-dom, a differenza del
    // browser, prova a caricare l'iframe di un documento di DOMParser e,
    // chiuso il test, lascia nel log una fetch interrotta. Si toglie per tag.
    const kept = neutralize(
      '<img src="data:image/png;base64,AA"><iframe srcdoc="<p>x</p>"></iframe><object data="x"></object>',
    );
    expect(kept.html).toContain('src="data:image/png;base64,AA"');
    expect(kept.html).not.toMatch(/<iframe|<object/i);
    expect(neutralize('<style>body{background:url("https://a.example/bg.png")}</style>').blockedImages).toBe(1);
  });

  it("neutralize: gli <style> della head restano (in cima al corpo) e i loro url() si contano", () => {
    const head = neutralize(
      '<html><head><title>x</title><style>body{background:url(https://a.example/h.png)}</style></head><body><p>x</p></body></html>',
    );
    // Il caso discrimina: il parser mette lo stile nella head, non nel corpo.
    expect(
      new DOMParser().parseFromString('<html><head><style>p{}</style></head><body></body></html>', "text/html").body
        .innerHTML,
    ).not.toContain("<style>");
    expect(head.html).toMatch(/^<style>body\{background:url\(https:\/\/a\.example\/h\.png\)\}<\/style>/);
    expect(head.blockedImages).toBe(1);
    const leading = neutralize('<style>@import "https://a.example/s.css";</style><p>y</p>');
    expect(leading.html).toContain('<style>@import "https://a.example/s.css";</style>');
    expect(leading.blockedImages).toBe(1);
  });

  it("neutralize: background= si conta, si parcheggia e torna", () => {
    const { html, blockedImages } = neutralize(
      '<table background="https://a.example/t.png"><tr><td>z</td></tr></table>',
    );
    expect(blockedImages).toBe(1);
    const doc = new DOMParser().parseFromString(html, "text/html");
    expect(doc.querySelector("table")!.getAttribute("background")).toBeNull();
    expect(doc.querySelector("table")!.getAttribute("data-background")).toBe("https://a.example/t.png");
    const shown = new DOMParser().parseFromString(revealImages(html), "text/html");
    expect(shown.querySelector("table")!.getAttribute("background")).toBe("https://a.example/t.png");
  });

  it("neutralize: le immagini di image-set() si contano, anche fra url() e stringhe", () => {
    expect(
      neutralize(
        '<p style="background-image: image-set(\'https://a.example/1.png\' 1x, \'https://a.example/2.png\' 2x)">x</p>',
      ).blockedImages,
    ).toBe(2);
    expect(
      neutralize(
        '<style>p{background:-webkit-image-set(url(https://a.example/1.png) 1x, "https://a.example/2.png" 2x)}</style><p>x</p>',
      ).blockedImages,
    ).toBe(2);
    // Un'immagine locale (data:) non si conta.
    expect(
      neutralize('<p style="background-image: image-set(\'data:image/png;base64,AA\' 1x)">x</p>')
        .blockedImages,
    ).toBe(0);
  });

  // Un `<image>` scritto nell'HTML un parser vero lo trasforma in `<img>` (e
  // `href` non vi carica nulla): esiste solo dentro un SVG, che il parser di
  // happy-dom svuota. L'albero si costruisce a mano, così il test vale in
  // happy-dom come in Chromium.
  it("scrubTree su un SVG vero (il parser di happy-dom ne scarta i figli): <style> minuscolo, <image href|xlink:href>", () => {
    const SVG = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(SVG, "svg");
    const style = document.createElementNS(SVG, "style");
    style.textContent = 'rect{fill:url(https://a.example/f.svg#g)} @import "https://a.example/s.css";';
    const image = document.createElementNS(SVG, "image");
    image.setAttribute("href", "https://a.example/i.png");
    const old = document.createElementNS(SVG, "image");
    old.setAttribute("xlink:href", "https://a.example/x.png");
    svg.append(style, image, old);
    const root = document.createElement("div");
    root.append(svg);
    expect(scrubTree(root)).toBe(4);
    expect(image.getAttribute("href")).toBeNull();
    expect(image.getAttribute("data-href")).toBe("https://a.example/i.png");
    expect(old.getAttribute("xlink:href")).toBeNull();
    expect(old.getAttribute("data-xlink-href")).toBe("https://a.example/x.png");
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
  it("se le proposte non si leggono, la conversazione si apre lo stesso: l'ultimo messaggio aperto col suo testo", async () => {
    failNext("mail.listMailProposals");
    const thread = threadOf(MAIL_CASES.stwHigh);
    await openMail(`/mail/${thread}`);
    const p = await pane(thread);
    expect(await within(p).findByText(/we freeze the copy of the desktop preview/)).toBeInTheDocument();
    // Chiuso resta solo il messaggio di contesto, già letto.
    expect(p.querySelector(`article[data-message="${MAIL_CASES.stwHigh}"][data-collapsed]`)).toBeNull();
    expect(p.querySelectorAll("article[data-collapsed]")).toHaveLength(1);
  });

  it("messaggio di contesto: aperto lo dice; il testo citato si mostra e si nasconde", async () => {
    const thread = threadOf(MAIL_CASES.stwHigh);
    await openMail(`/mail/${thread}`);
    const p = await pane(thread);
    const user = userEvent.setup();
    // L'email di oggi, aperta: il citato è piegato dietro «···».
    const today = p.querySelector<HTMLElement>(`article[data-message="${MAIL_CASES.stwHigh}"]`)!;
    expect(within(today).queryByText(/Draft schedule for the preview build attached/)).toBeNull();
    await user.click(within(today).getByRole("button", { name: "Show quoted text" }));
    expect(within(today).getByText(/Draft schedule for the preview build attached/)).toBeInTheDocument();
    await user.click(within(today).getByRole("button", { name: "Hide quoted text" }));
    expect(within(today).queryByText(/Draft schedule for the preview build attached/)).toBeNull();
    expect(today).not.toHaveTextContent("Earlier in the conversation");
    // Il messaggio di martedì, chiuso: aperto dice che è contesto, senza proposte.
    const earlier = p.querySelector<HTMLElement>(`article[data-message="${MAIL_CASES.context}"]`)!;
    expect(earlier).toHaveAttribute("data-collapsed");
    await user.click(within(earlier).getAllByRole("button")[0]!);
    const opened = await waitFor(() => {
      const el = p.querySelector<HTMLElement>(`article[data-message="${MAIL_CASES.context}"]`)!;
      if (el.hasAttribute("data-collapsed")) throw new Error("still collapsed");
      return el;
    });
    expect(opened).toHaveTextContent(
      "Earlier in the conversation · Stubwise didn't make proposals from this message",
    );
    expect(opened.querySelector("[data-mail-proposal]")).toBeNull();
  });

  it("un messaggio letto, non l'ultimo, con una proposta che mi aspetta resta aperto con la sua scheda", async () => {
    const source = state.mailMessages.find((m) => m.id === MAIL_CASES.shared)!;
    source.readByPersonIds.push("p-giulia");
    state.mailMessages.push({
      ...source,
      id: "mm-test-reply",
      messageId: "<test-reply@example.com>",
      from: source.to[0]!,
      to: [source.from],
      cc: null,
      subject: `Re: ${source.subject}`,
      at: "2026-10-18T09:00:00Z",
      text: "Thanks Sofia, we're on it.",
      attachments: [],
      readByPersonIds: ["p-giulia"],
      classification: { state: "done", projectIds: [], importance: "normal", dueDate: null, uncertainProjectIds: [] },
    });
    await openMail(`/mail/${source.threadId}`);
    const c = await card("mp-aud-billing-vat");
    expect(within(c).getByRole("button", { name: "Confirm" })).toBeInTheDocument();
    const article = c.closest("article")!;
    expect(article).toHaveAttribute("data-message", MAIL_CASES.shared);
    expect(article).not.toHaveAttribute("data-collapsed");
  });


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

  it("cambio di persona verso chi non vede la conversazione: l'indirizzo torna a #/mail, niente di chi c'era prima", async () => {
    const thread = threadOf(MAIL_CASES.personal);
    const router = await openMail(`/mail/${thread}?q=domenica`);
    expect(await pane(thread)).toHaveTextContent("Cena domenica?");
    await switchPersona(/Laura Costa/);
    await waitFor(() => expect(router.state.location.pathname).toBe("/mail"));
    expect(search(router).q).toBeUndefined();
    expect(await screen.findByRole("heading", { level: 1, name: "Mail" })).toBeInTheDocument();
    expect(screen.queryByText(/Cena domenica/)).toBeNull();
    expect(screen.queryByText("This conversation doesn't exist or you can't see it")).toBeNull();
    expect(screen.queryByText(/giulia\.ferri@example\.com/)).toBeNull();
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
    // L'esito: l'ordine parla di MKX, e ne nasce la proposta per MKX.
    const card = await waitFor(
      () => {
        const el = p.querySelector<HTMLElement>("[data-mail-proposal]");
        if (!el) throw new Error("no proposal yet");
        return el;
      },
      { timeout: 3000 },
    );
    expect(card).toHaveTextContent("Stubwise proposes · 1 change for MKX");
    expect(card).toHaveTextContent("Conferma d'ordine 2026/1187");
    expect(within(p).queryByText("Stubwise couldn't analyse this email.")).toBeNull();
    expect(within(p).queryByText("Stubwise is reading this email…")).toBeNull();
    expect(within(p).getByRole("link", { name: /MKX/ })).toBeInTheDocument();
  });

  it("proposte spente per la casella: «Turn on» apre la scheda dell'account, non cambia nulla da sé", async () => {
    await openMail("/mail?mailbox=laura.costa%40example.com", "p-laura");
    await userEvent.click(await screen.findByRole("button", { name: "Turn on" }));
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    expect(state.mailboxes.find((b) => b.personId === "p-laura")!.proposalsEnabled).toBe(false);
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
    expect(within(p).getByRole("link", { name: "Weekly review with Audin" })).toHaveAttribute(
      "href",
      `#/calendar?event=${EV_AUD_REVIEW_YESTERDAY}`,
    );
    expect(p.querySelector("[data-meeting]")).toHaveTextContent(/Yesterday \d{2}:\d{2}–/);
  });

  it("riunione registrata, destinatario che non c'era: la frase che lo dice, niente riassunto", async () => {
    const event = state.calendarEvents.find((e) => e.id === EV_AUD_REVIEW_YESTERDAY)!;
    event.attendees = event.attendees.filter((a) => a.personId !== "p-giulia");
    const thread = threadOf(MAIL_CASES.transcript);
    await openMail(`/mail/${thread}`);
    const p = await pane(thread);
    expect(
      within(p).getByText(
        "The summary and the transcript are visible only to the people who were in the meeting.",
      ),
    ).toBeInTheDocument();
    expect(within(p).queryByText("Generated by Stubwise from the transcript")).toBeNull();
    expect(within(p).queryByRole("button", { name: "Open the transcript" })).toBeNull();
    // Nemmeno il titolo del Google Doc: la riga dice l'oggetto dell'email.
    const doc = state.meetingTranscripts.find((t) => t.eventId === EV_AUD_REVIEW_YESTERDAY)!;
    expect(p.querySelector("[data-meeting]")).not.toHaveTextContent(doc.docTitle);
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
