import { canStepMonth, ingestionWindow, monthEdge } from "./calendar-window";

/**
 * I bordi della finestra di ingestione (App M3, Fase D, Task 11): il punto
 * in cui la griglia smette di lasciar scorrere e comincia a spiegarsi.
 *
 * `NOW` è il 15 settembre 2026: con −30/+60 giorni la finestra va dal 16
 * agosto al 14 novembre, quindi i mesi raggiungibili sono agosto, settembre,
 * ottobre e novembre — e NON luglio né dicembre. È scelto apposta perché i
 * due bordi cadano a metà mese: è il caso che distingue "il mese INTERSECA
 * la finestra" da "il mese ci sta dentro tutto", e sbagliare quel confronto
 * renderebbe invisibile metà novembre.
 */
const NOW = new Date("2026-09-15T12:00:00.000Z");

const month = (y: number, m: number) => new Date(y, m, 1);

test("la finestra va da 30 giorni indietro a 60 avanti", () => {
  const { from, to } = ingestionWindow(NOW);
  expect(Math.round((NOW.getTime() - from.getTime()) / 86_400_000)).toBe(30);
  expect(Math.round((to.getTime() - NOW.getTime()) / 86_400_000)).toBe(60);
});

test("dentro la finestra si naviga in entrambe le direzioni", () => {
  const september = month(2026, 8);
  expect(canStepMonth(september, -1, NOW)).toBe(true);
  expect(canStepMonth(september, 1, NOW)).toBe(true);
  expect(monthEdge(september, NOW)).toBeNull();
});

test("agosto è raggiungibile anche se la finestra ne copre solo metà", () => {
  // La finestra parte dal 16 agosto: agosto INTERSECA, quindi ci si arriva.
  expect(canStepMonth(month(2026, 8), -1, NOW)).toBe(true);
  // Da agosto però non si va oltre: luglio è interamente fuori.
  expect(canStepMonth(month(2026, 7), -1, NOW)).toBe(false);
});

test("novembre è raggiungibile anche se la finestra finisce il 14", () => {
  expect(canStepMonth(month(2026, 9), 1, NOW)).toBe(true); // ottobre → novembre
  // Da novembre non si va oltre: dicembre è interamente fuori.
  expect(canStepMonth(month(2026, 10), 1, NOW)).toBe(false);
});

test("sul mese di bordo iniziale l'indietro è chiuso, l'avanti no", () => {
  expect(monthEdge(month(2026, 7), NOW)).toBe("start");
});

test("sul mese di bordo finale l'avanti è chiuso, l'indietro no", () => {
  expect(monthEdge(month(2026, 10), NOW)).toBe("end");
});

// Il caso che rompe una mutazione plausibile: confrontare gli ISTANTI invece
// dei MESI. Con `from` al 16 agosto, un confronto sugli istanti direbbe che
// il 1° agosto è prima della finestra e chiuderebbe agosto — nascondendo gli
// eventi dal 16 al 31, che invece ci sono.
test("il confronto è fra MESI, non fra istanti: il 1° agosto non chiude agosto", () => {
  const september = month(2026, 8);
  const { from } = ingestionWindow(NOW);
  expect(from.getDate()).toBeGreaterThan(1); // la finestra parte a metà mese
  expect(canStepMonth(september, -1, NOW)).toBe(true);
});

test("da un mese FUORI portata si torna comunque indietro: nessuna trappola", () => {
  // Ci si arriva solo per una via traversa (un anchor rimasto da prima che
  // la finestra scorresse, un "oggi" che avanza mentre la schermata è
  // aperta). Da lì l'avanti è chiuso e l'indietro APERTO: la via di rientro
  // esiste sempre, o si resterebbe bloccati su una griglia vuota.
  const faraway = month(2027, 5);
  expect(monthEdge(faraway, NOW)).toBe("end");
  expect(canStepMonth(faraway, -1, NOW)).toBe(true);
});

// `monthEdge` può dire anche `"both"`, e con le costanti di oggi (30/60,
// cioè 90 giorni: mai contenibili in un mese solo) quel ramo NON è
// raggiungibile — nessun test lo esercita, ed è corretto che sia così. Esiste
// per il giorno in cui qualcuno stringesse la finestra: senza, `monthEdge`
// direbbe `"start"` nascondendo che anche l'avanti è chiuso, e la pagina
// spiegherebbe metà del motivo per cui non si muove.
test("la finestra di oggi è più larga di un mese: per questo `both` non capita", () => {
  const { from, to } = ingestionWindow(NOW);
  const spanDays = (to.getTime() - from.getTime()) / 86_400_000;
  expect(spanDays).toBeGreaterThan(31);
});
