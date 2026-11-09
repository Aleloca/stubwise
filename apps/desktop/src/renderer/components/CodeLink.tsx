import { useCodeCitations, useContextIdOf } from "../data/queries";

// Un codice citato (area 10b, Task 10; shape `claude-drafts.md` §3.1, R-E9):
// un link se chi guarda vede l'oggetto — 600, cifre tabellari, col nome se
// richiesto —, altrimenti il solo codice tenue, che non si apre. Lo usano il
// segno «Claude's draft» (le fonti) e le note di un rilascio: una regola
// sola. Visibilità e indirizzo li decide il livello dati (`resolveCodes`, e
// per una conversazione di supporto `contextIdOf`); qui non si deduce nulla.

const SUPPORT = /^([A-Z]{2,4})-S\d+$/;

export function CodeLink({
  code,
  withName = false,
  title,
  quiet = false,
}: {
  code: string;
  /** Il nome dopo il codice (titolo della task o della richiesta), se chi guarda la vede. */
  withName?: boolean;
  /** Il nome che sa chi chiama (con le sue note, «(late)»): solo per un oggetto visibile. */
  title?: string;
  /**
   * Come nella riga «Used:» della conversazione (`CitationLink`): senza
   * sottolineatura a riposo, che compare al passaggio e al fuoco
   * (Impeccable 12: «Used:» si legge uguale ovunque).
   */
  quiet?: boolean;
}) {
  const support = SUPPORT.exec(code);
  const cited = useCodeCitations(support ? [] : [code]).data;
  const supportId = useContextIdOf(support ? { kind: "support", code } : null).data;
  const view = cited?.find((c) => c.code === code && c.visible);
  const href = support
    ? supportId
      ? `#/p/${support[1]}/support/${code}`
      : null
    : (view?.route ?? null);
  if (!href) {
    return (
      <span data-code-link="hidden" className="num font-semibold text-ink-faint">
        {code}
      </span>
    );
  }
  const name = withName ? (title ?? view?.name ?? null) : null;
  return (
    <a
      href={href}
      data-code-link="open"
      className={
        quiet
          ? "rounded-[3px] underline decoration-transparent underline-offset-2 transition-colors duration-[var(--duration-fast)] ease-out hover:decoration-ink/60 focus-visible:decoration-ink/60"
          : "rounded-sm underline decoration-ink/30 underline-offset-2 hover:decoration-ink"
      }
    >
      <span className="num font-semibold text-ink">{code}</span>
      {name && <span className="text-ink"> {name}</span>}
    </a>
  );
}
