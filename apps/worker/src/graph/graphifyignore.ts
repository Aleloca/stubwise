/**
 * DEFAULT DI PIATTAFORMA del `.graphifyignore` (esclusioni dall'estrazione del
 * grafo), usato in DUE punti che devono restare allineati:
 *
 *  - la BUILD del grafo (`build.ts`): se il repo NON ha un `.graphifyignore`
 *    committato, il worker scrive questo default nel worktree effimero prima
 *    dell'extract — così l'esclusione vale da subito, senza attendere il merge
 *    della PR di setup;
 *  - la PR DI SETUP (`setup-pr.ts`): lo starter committato nel repo è lo stesso
 *    contenuto, così le build locali dei dev (hook post-commit) producono lo
 *    stesso grafo del worker.
 *
 * Un `.graphifyignore` già presente nel repo VINCE sempre (è una scelta del
 * team): il worker non lo tocca e la PR di setup non lo sovrascrive.
 *
 * PERCHÉ le migration sono escluse di default (decisione del 31 lug 2026): ogni
 * migration forma un'isola nel grafo (file + tabelle SQL che nessun codice
 * "importa") — centinaia di micro-componenti di storia dello schema, non
 * architettura. Chi le rivuole nel grafo committa un proprio `.graphifyignore`
 * senza quelle righe.
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
`;
