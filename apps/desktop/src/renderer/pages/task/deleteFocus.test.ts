import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { focusAfterDelete } from "./deleteFocus";

// Il fuoco dopo «Elimina task» riprova finché la lista riletta non toglie la
// riga (fine area 11, giro completo su 6548cd315): i giri non devono
// sopravvivere alla pagina. Smontata la pagina, o sparito `document` (la
// chiusura dell'ambiente dei test), il retry si ferma e non lascia timer: un
// timer rimasto in coda usciva dopo la fine di taskPanel.test.tsx con
// «document is not defined» e un «Uncaught Exception».

function page() {
  const root = document.createElement("div");
  root.innerHTML = `
    <h1>Tasks</h1>
    <div data-task-row="AUD-1"><button data-row-open>AUD-1</button></div>
    <div data-task-row="AUD-2"><button data-row-open>AUD-2</button></div>`;
  document.body.append(root);
  return root;
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("focusAfterDelete", () => {
  it("la riga sparisce: il fuoco va sulla successiva, nessun timer resta", () => {
    const root = page();
    focusAfterDelete("AUD-1", "AUD-2");
    expect(vi.getTimerCount()).toBe(1);
    root.querySelector('[data-task-row="AUD-1"]')!.remove();
    vi.advanceTimersByTime(25);
    expect(document.activeElement?.textContent).toBe("AUD-2");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("la pagina si smonta durante i giri: il retry si ferma, nessun timer parte, il fuoco resta dov'è", () => {
    const root = page();
    focusAfterDelete("AUD-1", "AUD-2");
    vi.advanceTimersByTime(50);
    expect(vi.getTimerCount()).toBe(1);
    // Si va altrove: la pagina nuova ha il suo h1 e il suo campo col fuoco.
    root.remove();
    const other = document.createElement("div");
    other.innerHTML = `<h1>Inbox</h1><input aria-label="search" />`;
    document.body.append(other);
    other.querySelector("input")!.focus();
    vi.advanceTimersByTime(25);
    expect(vi.getTimerCount()).toBe(0);
    expect(document.activeElement).toBe(other.querySelector("input"));
  });

  it("`document` non c'è più (chiusura dell'ambiente): il giro in coda non lancia e non riparte", () => {
    page();
    focusAfterDelete("AUD-1", "AUD-2");
    vi.stubGlobal("document", undefined);
    expect(() => vi.advanceTimersByTime(25)).not.toThrow();
    expect(vi.getTimerCount()).toBe(0);
  });
});
