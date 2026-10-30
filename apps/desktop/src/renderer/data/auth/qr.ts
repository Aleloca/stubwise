import { hashOf, seededRandom } from "../seed/servers/metrics";

// SOLO PROTOTIPO: il QR dell'app di autenticazione è FINTO e dichiarato tale
// («Prototype: this QR code is made up.»). Una funzione pura: dallo stesso
// URI lo stesso disegno, 25×25 moduli con i tre riquadri d'angolo di un QR
// vero, il resto pseudo-casuale. Non codifica niente: nemmeno la chiave,
// che quindi non si ricava dal disegno.

const SIZE = 25;

const inFinder = (x: number, y: number): boolean => {
  const corner = (cx: number, cy: number) => x >= cx && x < cx + 7 && y >= cy && y < cy + 7;
  return corner(0, 0) || corner(SIZE - 7, 0) || corner(0, SIZE - 7);
};

/** Il modulo di un riquadro d'angolo: anello esterno, bianco, centro 3×3. */
function finderDark(x: number, y: number): boolean {
  const lx = x >= SIZE - 7 ? x - (SIZE - 7) : x;
  const ly = y >= SIZE - 7 ? y - (SIZE - 7) : y;
  const ring = lx === 0 || lx === 6 || ly === 0 || ly === 6;
  const core = lx >= 2 && lx <= 4 && ly >= 2 && ly <= 4;
  return ring || core;
}

/** L'SVG (viewBox in moduli, colore `currentColor`) del QR finto di `uri`. */
export function fakeQrSvg(uri: string): string {
  const rnd = seededRandom(hashOf(uri));
  const rects: string[] = [];
  for (let y = 0; y < SIZE; y++)
    for (let x = 0; x < SIZE; x++) {
      const dark = inFinder(x, y) ? finderDark(x, y) : rnd() < 0.5;
      if (dark) rects.push(`<rect x="${x}" y="${y}" width="1" height="1"/>`);
    }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-2 -2 ${SIZE + 4} ${SIZE + 4}" fill="currentColor" shape-rendering="crispEdges">${rects.join("")}</svg>`;
}
