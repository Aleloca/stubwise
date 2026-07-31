/**
 * DEFAULT DI PIATTAFORMA del `.graphifyignore` (esclusioni dall'estrazione del
 * grafo), usato in DUE punti che devono restare allineati:
 *
 *  - la BUILD del grafo (`build.ts`): se il repo NON ha un `.graphifyignore`
 *    committato — o ne ha uno che è ESATTAMENTE un nostro starter di una
 *    versione precedente, mai personalizzato dal team — il worker scrive il
 *    default corrente nel worktree effimero prima dell'extract;
 *  - la PR DI SETUP (`setup-pr.ts`): lo starter committato nel repo è lo stesso
 *    contenuto (e uno starter legacy viene aggiornato dalla PR), così le build
 *    locali dei dev (hook post-commit) producono lo stesso grafo del worker.
 *
 * Un `.graphifyignore` PERSONALIZZATO dal team (qualunque differenza dai nostri
 * starter) VINCE sempre: il worker non lo tocca e la PR di setup non lo
 * sovrascrive.
 *
 * PERCHÉ le esclusioni (decisioni del 31 lug 2026, analisi sul grafo di Audin):
 *  - migration del DB: ogni migration forma un'isola nel grafo (file + tabelle
 *    che nessun codice "importa") — centinaia di micro-componenti di storia
 *    dello schema, non architettura;
 *  - tsconfig: l'estrattore JSON-config mappa le OPZIONI dei tsconfig
 *    (compilerOptions, strict, …) in una componente separata di soli nodi di
 *    configurazione (~400 nodi su Audin). NB: la risoluzione degli alias di
 *    import NON dipende dal corpus — graphify legge i tsconfig dal disco
 *    (extractors/resolution.py: _find_js_config + read_text), quindi
 *    escluderli toglie solo il rumore, non gli archi degli import.
 */
export const PLATFORM_GRAPHIFYIGNORE = `# Percorsi esclusi dall'estrazione del grafo (graphify).
node_modules/
dist/
build/
coverage/

# Migration del database: storia dello schema, non architettura — ogni file
# formerebbe un'isola nel grafo.
**/migration.sql
**/migrations/**

# Opzioni dei tsconfig: rumore di configurazione (la risoluzione degli alias di
# import legge comunque i file dal disco, non dal grafo).
tsconfig*.json
`;

/**
 * Gli starter di piattaforma PRECEDENTI, byte-normalizzati: un file identico a
 * uno di questi non è mai stato personalizzato dal team, quindi la piattaforma
 * può aggiornarlo al default corrente. Ogni volta che PLATFORM_GRAPHIFYIGNORE
 * cambia, la versione precedente va AGGIUNTA qui.
 */
const LEGACY_PLATFORM_GRAPHIFYIGNORES = [
  // v1 — starter originale della PR di setup (fase 1, 27 lug 2026).
  `# Percorsi esclusi dall'estrazione del grafo (graphify).
node_modules/
dist/
build/
coverage/
`,
  // v2 — con le migration (e91bf1c, 31 lug 2026), prima dei tsconfig.
  `# Percorsi esclusi dall'estrazione del grafo (graphify).
node_modules/
dist/
build/
coverage/

# Migration del database: storia dello schema, non architettura — ogni file
# formerebbe un'isola nel grafo.
**/migration.sql
**/migrations/**
`,
];

/** Confronto tollerante a spazi finali/newline di coda (editor e piattaforme
 * diverse li toccano): normalizza riga per riga. */
function normalize(content: string): string {
  return content
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .trim();
}

/**
 * True se il contenuto è un NOSTRO starter (corrente o legacy), cioè mai
 * personalizzato dal team: la piattaforma può aggiornarlo in sicurezza.
 */
export function isPlatformManagedGraphifyignore(content: string): boolean {
  const n = normalize(content);
  return (
    n === normalize(PLATFORM_GRAPHIFYIGNORE) ||
    LEGACY_PLATFORM_GRAPHIFYIGNORES.some((legacy) => n === normalize(legacy))
  );
}
