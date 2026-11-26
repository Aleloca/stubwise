/** Il nome e le iniziali di una persona nell'app nuova (integrazione area 2). */

/** `display_name` se c'è, altrimenti la parte locale dell'email. */
export function personName(row: { email: string; displayName: string | null }): string {
  const display = row.displayName?.trim();
  return display ? display : (row.email.split("@")[0] ?? row.email);
}

/** Due iniziali del nome: le prime lettere delle prime due parole, o le prime due lettere. */
export function initialsOf(name: string): string {
  const parts = name.split(/[\s._-]+/u).filter((p) => p.length > 0);
  const letters = parts.length >= 2 ? `${parts[0]![0]}${parts[1]![0]}` : (parts[0] ?? "").slice(0, 2);
  return letters.toUpperCase();
}
