import { describe, expect, it } from "vitest";
import { compareProjectNames, needsViewer } from "./project-order.js";

const p = (id: string, name: string) => ({ id, name });
const names = (list: { name: string }[]) => list.map((item) => item.name);

describe("compareProjectNames: l'ordine alfabetico dei progetti", () => {
  it("maiuscole e minuscole non contano: «alfa» non finisce dopo «Zeta»", () => {
    // È il difetto che un ORDER BY su un Postgres `--locale=C` avrebbe.
    const sorted = [p("1", "Zeta"), p("2", "alfa"), p("3", "Beta")].sort(compareProjectNames);
    expect(names(sorted)).toEqual(["alfa", "Beta", "Zeta"]);
  });

  it("gli accenti non spostano una parola in fondo", () => {
    const sorted = [p("1", "Ottica"), p("2", "Èlite"), p("3", "Ascensori")].sort(compareProjectNames);
    expect(names(sorted)).toEqual(["Ascensori", "Èlite", "Ottica"]);
  });

  it("i numeri si leggono come numeri: «progetto 2» prima di «progetto 10»", () => {
    const sorted = [p("1", "progetto 10"), p("2", "progetto 2"), p("3", "progetto 1")].sort(compareProjectNames);
    expect(names(sorted)).toEqual(["progetto 1", "progetto 2", "progetto 10"]);
  });

  it("a parità di nome decide l'id, così l'ordine non cambia da una lettura all'altra", () => {
    // L'id minore sta sulla MAIUSCOLA apposta: un confronto che distinguesse
    // le maiuscole metterebbe «portale» primo (ICU ordina prima le minuscole),
    // e solo lo spareggio sull'id dà quest'ordine.
    const a = p("bbbb", "portale");
    const b = p("aaaa", "Portale");
    expect([a, b].sort(compareProjectNames).map((item) => item.id)).toEqual(["aaaa", "bbbb"]);
    expect([b, a].sort(compareProjectNames).map((item) => item.id)).toEqual(["aaaa", "bbbb"]);
  });
});

describe("needsViewer: qualcosa aspetta chi guarda", () => {
  const empty = { waitingForYou: [] as unknown[], waitingForMerge: [] as { canMerge: boolean }[] };

  it("no, se non c'è niente", () => {
    expect(needsViewer(empty)).toBe(false);
  });

  it("sì, con una decisione in `waitingForYou`", () => {
    expect(needsViewer({ ...empty, waitingForYou: [{}] })).toBe(true);
  });

  it("sì, con una PR che PUÒ mergiare — `canMerge` lo dice il server", () => {
    expect(needsViewer({ ...empty, waitingForMerge: [{ canMerge: true }] })).toBe(true);
  });

  it("no, con una PR che aspetta un altro", () => {
    expect(needsViewer({ ...empty, waitingForMerge: [{ canMerge: false }] })).toBe(false);
  });

  it("un polso senza `waitingForMerge` (server più vecchio, web che non parsa) non fa lanciare", () => {
    expect(needsViewer({ waitingForYou: [] })).toBe(false);
  });
});
