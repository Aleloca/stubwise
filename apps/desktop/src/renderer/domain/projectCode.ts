/** Il codice di un progetto: 2–4 lettere maiuscole, univoco (`createProject`). */
export const PROJECT_CODE_RE = /^[A-Z]{2,4}$/;

/**
 * Le parole del nome in sole lettere maiuscole, senza accenti né simboli.
 * Le parole di una lettera («e», «a») non contano, se ce ne sono altre.
 */
function wordsOf(name: string): string[] {
  const words = name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .split(/[^A-Z]+/)
    .filter(Boolean);
  const long = words.filter((w) => w.length > 1);
  return long.length > 0 ? long : words;
}

/**
 * Le proposte in ordine di preferenza. Con tre parole o più: le iniziali
 * (fino a quattro). Con due: due lettere della prima e l'iniziale della
 * seconda («Brennero Logistics» → BRL). Con una: le prime tre lettere.
 * Dopo, le varianti: un'altra lettera della prima parola al centro, poi una
 * quarta lettera presa dal nome.
 */
function candidates(words: string[]): string[] {
  const out: string[] = [];
  const first = words[0]!;
  const last = words.at(-1)!;
  if (words.length >= 3) {
    out.push(words.slice(0, 4).map((w) => w[0]).join(""));
  } else if (words.length === 2) {
    out.push(first.slice(0, 2) + last[0]);
    for (const c of first.slice(2)) out.push(first[0] + c + last[0]);
    for (const c of last.slice(1)) out.push(first.slice(0, 2) + last[0] + c);
  } else {
    out.push(first.slice(0, 3));
    for (const c of first.slice(3)) out.push(first.slice(0, 2) + c);
  }
  const base = out[0]!.slice(0, 3);
  for (const c of words.join("").slice(1)) out.push(base + c);
  for (const c of "ABCDEFGHIJKLMNOPQRSTUVWXYZ") out.push(base + c);
  return out;
}

/**
 * Il codice proposto mentre si scrive il nome: valido e non ancora usato.
 * `null` se il nome non ha lettere o (caso estremo) ogni variante è presa.
 */
export function proposeProjectCode(name: string, taken: ReadonlySet<string>): string | null {
  const words = wordsOf(name);
  if (words.length === 0) return null;
  return candidates(words).find((c) => PROJECT_CODE_RE.test(c) && !taken.has(c)) ?? null;
}

export type ProjectCodeProblem = "required" | "format" | "taken";

/** Cosa non va in un codice scritto a mano; `null` se va bene. */
export function validateProjectCode(
  code: string,
  taken: ReadonlySet<string>,
): ProjectCodeProblem | null {
  if (!code) return "required";
  if (!PROJECT_CODE_RE.test(code)) return "format";
  if (taken.has(code)) return "taken";
  return null;
}
