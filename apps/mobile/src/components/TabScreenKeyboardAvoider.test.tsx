import { tabScreenKeyboardOffset } from "./TabScreenKeyboardAvoider";

/**
 * Lo scostamento delle schermate col campo in fondo (25 set 2026). La barra
 * delle schede finisce DIETRO la tastiera: se la schermata si alzasse di
 * tutta la tastiera, sopra resterebbe un vuoto alto quanto la barra — il
 * campo porta già quell'altezza nel suo `paddingBottom`.
 */
describe("tabScreenKeyboardOffset", () => {
  test("toglie l'altezza della barra delle schede, non la aggiunge", () => {
    expect(tabScreenKeyboardOffset(83)).toBe(-83);
  });
});
