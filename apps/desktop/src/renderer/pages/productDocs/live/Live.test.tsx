import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider, createMemoryHistory } from "@tanstack/react-router";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { productDocs, resetApi, setLatency, setStreamLatency } from "../../../data/api";
import { PEOPLE } from "../../../data/seed/people";
import { METER_IDS } from "../../../data/seed/productDocs/acq";
import { getSessionPersonId, setSessionPersonId } from "../../../data/session";
import { state } from "../../../data/store";
import type { ProductBlock } from "../../../data/types";
import { ViewerProvider, useViewer } from "../../../data/viewer";
import { setLanguage } from "../../../i18n";
import { DOCKED_PANEL_QUERY } from "../../../layout/useDetailPanel";
import { createAppRouter } from "../../../router";
import { setMatchMedia } from "../../../test/setup";
import { ThemeProvider } from "../../../theme/ThemeProvider";
import { placeCaret } from "../editor/domRange";

// La scrittura dal vivo (area 11a, Task 11; shape product-editor.md §3.13,
// [PE 16]–[PE 18]). Il copione di Meter reading (seme, Task 3; Task 5):
// Matteo entra senza ancora; Marco entra su «Rules», inserisce un paragrafo
// dopo l'ultimo di «Rules» e ci scrive in 8 pezzi «Readings sent after the
// 25th count for the next bill.», poi esce. 12 passi in tutto.
//
// «A metà copione» (ruling P16): timer finti che avanzano col tempo vero
// (le letture arrivano da sole) e `setStreamLatency(STEP)` con un passo
// lunghissimo, così il copione resta fermo finché il test non fa avanzare
// l'orologio di `n` passi esatti.

const LAURA = "p-laura";
const MARCO = "p-marco";
const SARA = "p-sara";
const GIULIA = "p-giulia";
const METER = METER_IDS.pageId;
const SCRIPTED = METER_IDS.scripted;
const STEP = 60_000;
const FULL = "Readings sent after the 25th count for the next bill.";

const meter = () => state.productPages.find((p) => p.id === METER)!;
const textOf = (b: ProductBlock | undefined) => (b && "content" in b ? b.content.text : null);
const presentOn = () =>
  state.productPresence.filter((p) => p.pageId === METER).map((p) => p.personId);

/** Lo spazio Prodotto su Meter reading, con i bottoni del «vedi come». */
function open(person = LAURA) {
  function Switch() {
    const { setPersona } = useViewer();
    return (
      <>
        {[SARA, GIULIA].map((id) => (
          <button key={id} type="button" onClick={() => setPersona(id)}>
            {`as ${id}`}
          </button>
        ))}
      </>
    );
  }
  const history = createMemoryHistory({ initialEntries: [`/p/ACQ/docs/product/${meter().code}`] });
  const router = createAppRouter(history);
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <ViewerProvider initialPersonId={person}>
        <Switch />
        <ThemeProvider>
          <RouterProvider router={router} />
        </ThemeProvider>
      </ViewerProvider>
    </QueryClientProvider>,
  );
  return screen.findByRole("heading", { level: 1, name: "Meter reading" });
}

/** Il copione resta fermo fino a `steps(n)`. */
function stall() {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  setStreamLatency(STEP);
}
const steps = (n: number) => act(() => vi.advanceTimersByTimeAsync(STEP * n));

const people = () => {
  const nav = screen.queryByRole("navigation", {
    name: /^(Product pages of|Pagine di prodotto di) ACQ$/,
  });
  return nav
    ? within(nav).queryByRole("group", { name: /^(People on this page|Persone nella pagina)$/ })
    : null;
};
/** I nomi accessibili degli avatar, nell'ordine. */
const avatars = () =>
  (people() ? within(people()!).queryAllByRole("img") : []).map((el) =>
    el.getAttribute("aria-label"),
  );
const body = () => document.querySelector<HTMLElement>("[data-editor-body]")!;
const blockEl = (id: string) => body().querySelector<HTMLElement>(`[data-block-id="${id}"]`);
const editing = () => document.querySelector<HTMLElement>("[data-editing]");
const cursorOf = (personId: string) =>
  document.querySelector<HTMLElement>(`[data-remote-cursor="${personId}"]`);

function input(el: HTMLElement, inputType: string, data: string | null = null) {
  act(() => {
    el.dispatchEvent(
      new InputEvent("beforeinput", { inputType, data, bubbles: true, cancelable: true }),
    );
  });
}

beforeEach(() => {
  setLatency(0);
  resetApi();
  window.localStorage.clear();
  setMatchMedia(DOCKED_PANEL_QUERY, true);
});

afterEach(async () => {
  // Nessun copione resta a scrivere nello stato del test dopo.
  if (vi.isFakeTimers()) await act(() => vi.runAllTimersAsync());
  vi.useRealTimers();
  await productDocs.whenProductIdle();
  act(() => setLanguage("en"));
});

describe("gli avatar in cima ([PE 16])", () => {
  it("Laura apre Meter reading: Matteo (legge) e Marco (scrive in Rules), mai lei; a copione finito resta Matteo", async () => {
    stall();
    await open();
    await steps(5);
    await waitFor(() =>
      expect(avatars()).toEqual(["Matteo Conti · reading", "Marco Bellini · writing in Rules"]),
    );
    const group = people()!;
    // Il nome anche nel `title`, e mai chi guarda (case-insensitive).
    expect(within(group).getByRole("img", { name: /^Marco Bellini/ })).toHaveAttribute(
      "title",
      "Marco Bellini · writing in Rules",
    );
    expect(group.textContent!.toLowerCase()).not.toContain("lc");
    expect(group.innerHTML.toLowerCase()).not.toContain("laura");
    // Lo stesso in italiano, composto in lettura.
    act(() => setLanguage("it"));
    await waitFor(() =>
      expect(avatars()).toEqual(["Matteo Conti · legge", "Marco Bellini · scrive in Rules"]),
    );
    act(() => setLanguage("en"));

    await steps(7);
    await productDocs.whenProductIdle();
    await waitFor(() => expect(avatars()).toEqual(["Matteo Conti · reading"]));
    // Laura c'è (conta per il segnale della sezione), senza un suo avatar.
    expect(presentOn()).toContain(LAURA);
  });

  it("più di quattro: le prime quattro e «+N», col nome di chi resta nel `title`", async () => {
    // Tutti i presenti possibili, senza copione: chi guarda vede chi legge i Docs di ACQ.
    let seq = 1;
    for (const person of PEOPLE)
      if (person.id !== LAURA)
        state.productPresence.push({
          pageId: METER,
          personId: person.id,
          anchorId: null,
          offset: 0,
          selection: null,
          seq: seq++,
        });
    setSessionPersonId(LAURA);
    const visible = await productDocs.getProductPresence(METER);
    expect(visible.length).toBeGreaterThan(4);
    stall();
    await open();
    await waitFor(() => expect(avatars()).toHaveLength(5));
    const shown = avatars();
    expect(shown.slice(0, 4)).toEqual(visible.slice(0, 4).map((p) => `${p.name} · reading`));
    const more = shown.at(-1)!;
    expect(more).toMatch(new RegExp(`^\\+${visible.length - 4}`));
    expect(more).toContain(visible[4]!.name);
  });
});

describe("i cursori degli altri ([PE 17])", () => {
  it("a metà copione: la barra di Marco con l'etichetta «Marco Bellini» nel paragrafo nuovo di «Rules», che cresce pezzo per pezzo", async () => {
    stall();
    await open();
    await steps(5);
    await waitFor(() => expect(blockEl(SCRIPTED)).toHaveTextContent("Readings sent"));
    // Il paragrafo nuovo sta dopo l'ultimo di «Rules».
    expect(blockEl(METER_IDS.afterRules)!.nextElementSibling).toBe(blockEl(SCRIPTED));
    const cursor = await waitFor(() => {
      const el = cursorOf(MARCO);
      expect(el).not.toBeNull();
      return el!;
    });
    expect(blockEl(SCRIPTED)!.contains(cursor)).toBe(true);
    // Il nome c'è sempre: il colore non è l'unico segnale.
    expect(cursor).toHaveTextContent("Marco Bellini");
    expect(cursor.querySelector("[data-remote-caret]")!.getAttribute("style")).toMatch(
      /var\(--presence-[1-6]\)/,
    );
    // Nessun lampeggio (anche col movimento ridotto): niente animazione sul cursore.
    expect(cursor.innerHTML).not.toMatch(/animate|caret-blink|stream-caret/);

    await steps(1);
    await waitFor(() =>
      expect(blockEl(SCRIPTED)!.querySelector("[data-block-text]")?.textContent).toBe(
        "Readings sent after ",
      ),
    );
    await steps(1);
    await waitFor(() =>
      expect(blockEl(SCRIPTED)!.querySelector("[data-block-text]")?.textContent).toBe(
        "Readings sent after the ",
      ),
    );
    expect(cursorOf(MARCO)).toHaveTextContent("Marco Bellini");
    await steps(5);
    await waitFor(() => expect(cursorOf(MARCO)).toBeNull());
    expect(textOf(meter().blocks.find((b) => b.id === SCRIPTED))).toBe(FULL);
  });

  it("una selezione di Marco è evidenziata nel suo colore, col suo nome", async () => {
    await open();
    await productDocs.whenProductIdle();
    // Marco sceglie «Readings close» nel primo paragrafo di «Rules».
    setSessionPersonId(MARCO);
    const done = productDocs.setProductPresence(METER, {
      anchorId: "blk-acq-meter-3",
      offset: 14,
      selection: [0, 14],
    });
    setSessionPersonId(LAURA);
    await done;
    const highlight = await waitFor(() => {
      const el = document.querySelector<HTMLElement>(`[data-remote-selection="${MARCO}"]`);
      expect(el).not.toBeNull();
      return el!;
    });
    expect(blockEl("blk-acq-meter-3")!.contains(highlight)).toBe(true);
    expect(highlight.outerHTML).toMatch(/var\(--presence-[1-6]\)/);
    expect(cursorOf(MARCO)).toHaveTextContent("Marco Bellini");
  });

  it("Sara, che legge soltanto, vede il cursore di Marco a metà copione", async () => {
    stall();
    await open(SARA);
    await steps(5);
    await waitFor(() => expect(cursorOf(MARCO)).toHaveTextContent("Marco Bellini"));
    expect(blockEl(SCRIPTED)!.contains(cursorOf(MARCO))).toBe(true);
  });
});

describe("nello stesso blocco ([PE 18], Review Focus 1)", () => {
  it("Laura col fuoco nel paragrafo di Marco: la nota sul bordo, il suo testo resta finché non esce; uscita, vale il suo testo e la cronologia ha le due revisioni", async () => {
    stall();
    await open();
    await steps(5);
    await waitFor(() => expect(blockEl(SCRIPTED)).toHaveTextContent("Readings sent"));
    const user = userEvent.setup({ advanceTimers: (ms) => vi.advanceTimersByTime(ms) });
    await user.click(blockEl(SCRIPTED)!.querySelector<HTMLElement>("[data-block-text]")!);
    await waitFor(() => expect(editing()).not.toBeNull());
    const el = editing()!;
    expect(el?.textContent).toBe("Readings sent ");
    act(() => placeCaret(el, 14));
    // La presenza di Laura: nel paragrafo di Marco.
    await waitFor(() =>
      expect(state.productPresence.find((p) => p.personId === LAURA)?.anchorId).toBe(SCRIPTED),
    );

    const note = await within(blockEl(SCRIPTED)!).findByText("Marco Bellini is writing here");
    expect(note.closest("[aria-live]")).toHaveAttribute("aria-live", "polite");
    // Niente barra di Marco dentro il blocco in modifica.
    expect(blockEl(SCRIPTED)!.querySelector(`[data-remote-cursor="${MARCO}"]`)).toBeNull();

    // Marco scrive gli altri sei pezzi: il blocco di Laura non cambia.
    await steps(6);
    await waitFor(() => expect(textOf(meter().blocks.find((b) => b.id === SCRIPTED))).toBe(FULL));
    expect(editing()).toBe(el);
    expect(el?.textContent).toBe("Readings sent ");
    input(el, "insertText", "on time.");
    expect(el?.textContent).toBe("Readings sent on time.");
    expect(
      within(blockEl(SCRIPTED)!).getByText("Marco Bellini is writing here"),
    ).toBeInTheDocument();

    // Esce: il suo salvataggio vale per ultimo, ed entrambe le versioni restano in cronologia.
    act(() => el.blur());
    await waitFor(() =>
      expect(textOf(meter().blocks.find((b) => b.id === SCRIPTED))).toBe("Readings sent on time."),
    );
    const revisions = state.productRevisions.filter((r) => r.pageId === METER);
    expect(revisions.some((r) => r.actorId === MARCO)).toBe(true);
    expect(revisions.some((r) => r.actorId === LAURA)).toBe(true);
    await waitFor(() => expect(blockEl(SCRIPTED)).toHaveTextContent("Readings sent on time."));
    // Fuori dal blocco Laura non scrive più lì.
    await waitFor(() =>
      expect(state.productPresence.find((p) => p.personId === LAURA)?.anchorId).toBeNull(),
    );
    // Marco esce: la nota non c'è più.
    await steps(1);
    await waitFor(() =>
      expect(within(blockEl(SCRIPTED)!).queryByText(/is writing here/)).toBeNull(),
    );
  });

  it("le scritture altrui sugli altri blocchi arrivano subito, col fuoco altrove", async () => {
    stall();
    await open();
    await steps(5);
    const user = userEvent.setup({ advanceTimers: (ms) => vi.advanceTimersByTime(ms) });
    await user.click(blockEl("blk-acq-meter-3")!.querySelector<HTMLElement>("[data-block-text]")!);
    await waitFor(() => expect(editing()).not.toBeNull());
    await steps(1);
    await waitFor(() =>
      expect(blockEl(SCRIPTED)!.querySelector("[data-block-text]")?.textContent).toBe(
        "Readings sent after ",
      ),
    );
    expect(within(blockEl("blk-acq-meter-3")!).queryByText(/is writing here/)).toBeNull();
  });
});

describe("il «vedi come»", () => {
  it("Laura diventa Sara: esce Laura, entra Sara; Giulia (che non vede ACQ) non trova la pagina e nessun avatar", async () => {
    await open();
    await productDocs.whenProductIdle();
    await waitFor(() => expect(presentOn()).toContain(LAURA));
    await waitFor(() => expect(avatars()).toEqual(["Matteo Conti · reading"]));
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: `as ${SARA}` }));
    await waitFor(() => expect(presentOn()).toContain(SARA));
    expect(presentOn()).not.toContain(LAURA);
    await waitFor(() => expect(avatars()).toEqual(["Matteo Conti · reading"]));
    expect(getSessionPersonId()).toBe(SARA);

    await user.click(screen.getByRole("button", { name: `as ${GIULIA}` }));
    await waitFor(() => expect(presentOn()).not.toContain(SARA));
    expect(presentOn()).not.toContain(GIULIA);
    await waitFor(() =>
      expect(screen.queryByRole("heading", { level: 1, name: "Meter reading" })).toBeNull(),
    );
    expect(people()).toBeNull();
    const page = document.body.innerHTML.toLowerCase();
    expect(page).not.toContain("matteo");
    expect(page).not.toContain("meter reading");
  });
});

describe("i confini", () => {
  const root = join(__dirname, "../../..");
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      return statSync(path).isDirectory() ? files(path) : [path];
    });
  const sources = files(root).filter((f) => /\.(tsx?|css)$/.test(f) && !/\.test\.tsx?$/.test(f));

  it("`writersNear` (id di persone NON filtrati per chi guarda) non arriva mai alla UI", () => {
    const offenders = sources
      .filter((f) => !relative(root, f).startsWith("data/"))
      .filter((f) => /\bwritersNear\b/.test(readFileSync(f, "utf8")));
    expect(offenders.map((f) => relative(root, f))).toEqual([]);
  });

  it("i colori della presenza stanno solo nei token e nei pezzi della scrittura dal vivo ([PE 17])", () => {
    const offenders = sources
      .filter((f) => /var\(--presence-|--presence-\d\s*:/.test(readFileSync(f, "utf8")))
      .map((f) => relative(root, f))
      .filter((f) => f !== "styles/tokens.css" && !f.startsWith("pages/productDocs/live/"));
    expect(offenders).toEqual([]);
  });
});
