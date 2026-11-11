# Integrazione area 5, fetta 1 — Docs nel desktop — piano (11 nov 2026)

> Autore: stubwise-72 (server e worker); renderer a stubwise-94. Branch
> `feat/area5-docs-server`, da `feat/integrazione-area4` (a9ad4556).
> Design e decisioni: `docs/plans/2026-11-11-integrazione-area5-docs-design.md`
> (D2 = a: codici D stabili con backfill).
>
> **Specifica**: il prototipo.
> - `apps/desktop/src/renderer/data/docs/{reads,writes,chat}.ts`;
> - `data/model.ts` (`DocPage.code`, `DocSearchHit`, `CitationRef` di tipo `doc`);
> - `data/api.ts` (la rotta di una citazione `doc`);
> - `apps/desktop/docs/area5-parity.md`.
>
> I Docs arrivano «come oggi» (maintainer): niente funzioni nuove, solo ciò che
> manca perché il desktop li mostri come il prototipo.

## Dove siamo

Il server ha già le rotte dei Docs.
- Per repository: albero, pagina, brief, release, export, generazione e ripresa, stato, pagine manuali, chat RAG.
- Per progetto: spazi, highlights, ricerca ibrida, chat.
- Il grafo (`repo-graph.ts`).

Mancano cinque cose:
1. Codici stabili delle pagine.
2. Citazioni `doc` che sopravvivono alle rigenerazioni, perché oggi puntano a `doc_pages.id`, e con una destinazione.
3. Embedding delle pagine manuali.
4. La lettura di una pagina intera per i tool di Claude.
5. I metodi mancanti di `@stubwise/api-client`: CRUD manuale, generazione, ripresa, stato, export.

## Task

- **F1.1 — Migrazione 0142: i codici `<PRJ>-D<n>`.** È il primo numero libero: la 0141 è della fetta 4 dell'area 4, e lo ricontrollo prima di scrivere.
  - La tabella `doc_page_codes (id, project_id, number, repository_id, slug, created_at)`, con due unici: `(project_id, number)` e `(repository_id, slug)`. In cascata sul repository e sul progetto.
  - Un TRIGGER `AFTER INSERT` su `doc_pages` dà il codice a ogni pagina nuova che non sia una nota di rilascio. Prende il numero dopo l'ultimo del progetto, sotto un advisory lock per progetto, e non fa niente se la coppia repository e slug ha già il suo codice. Così il giro notturno, la generazione completa e le pagine manuali prendono il codice in UN posto.
  - Il backfill dei codici per le pagine visibili di oggi (generazione corrente più quelle senza generazione), per progetto, nell'ordine:
    1. repository per nome;
    2. tipo: technical, functional, product, manual;
    3. posizione;
    4. data.
  - Il backfill delle citazioni della Chat: `chat_message_citations` di tipo `doc` passano dall'id della pagina all'id del codice. Una citazione di una pagina che non c'è più se ne va, come a lettura.
  - Test: la migrazione con il trigger su una pagina nuova; una rigenerazione con lo stesso slug che tiene il codice; uno slug nuovo che prende il numero dopo; nessun codice per una nota di rilascio; il backfill delle citazioni.
- **F1.2 — I codici nelle letture e la risoluzione.**
  - `code` su albero, pagina, highlights, ricerca di progetto e gruppo docs della ricerca globale. È un campo additivo, con default `null`.
  - `GET /api/docs/codes/:code` restituisce `{ projectId, repositoryId, repositorySlug, slug, available }`, con `docs.view` nel progetto del codice. Un progetto invisibile e un codice che non c'è danno lo stesso 404, `available` falso per una pagina tolta. Va registrata prima delle rotte parametriche, per la trappola di routing.
  - La ricerca globale, con un codice D esatto, lo mette in cima.
  - Test: il negativo di `docs.view` (un Contributor senza il modulo; un progetto invisibile: 404 per tutti e due); un codice esatto in cima.
- **F1.3 — Le citazioni `doc` della Chat.**
  - Il riferimento è l'id del CODICE, non della pagina.
  - La vista ha tre campi additivi:
    - `code`;
    - `doc: { repositoryId, repositorySlug, slug } | null`, con cui il desktop costruisce `#/p/<CODE>/docs/<repo>/<slug>`;
    - `label`, che resta il titolo.
  - `stillNamed` accetta il codice, col confine di `codesIn`, o il titolo, col confine di parola.
  - `codesIn` riconosce `<PRJ>-D<n>`: un codice D scritto a mano diventa una citazione per chi legge la pagina, come i codici delle task. Per gli altri resta testo (R-G5).
  - Le citazioni dei messaggi di Claude seguono la stessa regola.
  - Test: una citazione `doc` che sopravvive a una rigenerazione; un codice scritto a mano; chi non ha `docs.view` non la vede.
- **F1.4 — Embedding delle pagine manuali.**
  - Alla creazione e alla modifica, `chunkMarkdown` di `@stubwise/docs-engine` (nuova dipendenza del server, che dipende solo da shared) più l'embedder del server (`app.embeddingClient`), in `doc_chunks` con `generation_id` nullo. Alla modifica i chunk si rifanno; all'eliminazione vanno via in cascata.
  - Fail-open: senza embedder, la pagina si salva e si trova per testo. Il log lo dice.
  - Test: una pagina manuale trovata dalla ricerca semantica (embedder finto); un embedder giù che non blocca il salvataggio.
- **F1.5 — Claude legge una pagina.**
  - `GET /api/repositories/:repositoryId/docs/pages/:slug` entra nell'allowlist del turno (`chat-tool-routes.ts`), col test del registro.
  - Un tool `read_doc_page` (repositoryId, slug) nel server MCP della chat e nel ponte, col tetto di 12.000 caratteri dei tool.
  - `CHAT_READ_TOOLS` lo nomina, e la ricerca dei Docs dà già repository e slug.
  - Il contratto lo dice in una riga.
  - Golden: un giro di `chat-read` e `chat-mention-read`. Cambia l'elenco dei tool, quindi la regola è rilanciarli.
- **F1.6 — `@stubwise/api-client`.**
  - I metodi che mancano: CRUD manuale, generazione e ripresa, stato, l'URL dell'export, la risoluzione per codice.
  - La chat RAG in streaming resta al renderer, che ha già lo stream del main (`apiStream`); il client dà la forma `?stream=false`.
  - Lo dico a 94.
- **F1.7 — Chiusura.**
  - Il deploy-log della 0142. Rollback: il trigger resta e un server vecchio lo ignora, ma le citazioni `doc` puntano ai codici, e un server vecchio le cercherebbe fra le pagine. Quindi o si riportano agli id delle pagine con una query scritta nella voce, o si accettano citazioni che spariscono.
  - Il registro, la parità server (`apps/desktop/docs/integration-area5-f1.md`), una sezione Docs in un invariante nuovo `docs/invariants/docs.md`.
  - Le righe di CLAUDE.md, per l'orchestratrice.

## Fuori

- Il Drive (fette 2–4).
- Le pagine prodotto dell'area 11.
- Le funzioni nuove dei Docs.
- Le note di rilascio come pagine con codice: nel prototipo non sono pagine, ma voci delle release.
- La cronologia della ricerca: i clic sui documenti già salvati puntano a id che le rigenerazioni cambiano. Limite di oggi, nel registro.

## Global Constraints

- `docs.view` nel progetto del repository decide chi legge. Un progetto o una pagina invisibili si comportano come se non esistessero, anche nelle citazioni, nella ricerca e per Claude.
- Il codice non si riusa mai, nemmeno dopo l'eliminazione di una pagina manuale.
- Verso i client solo cambi additivi, con un default per ogni campo nuovo.
- Il registro decisioni non si scrive.
- Test filtrati, mutazioni sui test passati al primo colpo, Docker coordinato con stubwise-94.

## Review Focus

- La concorrenza del trigger: due generazioni dello stesso progetto (repository diversi) in parallelo. Il lock per progetto le mette in fila: va misurato su una generazione grande, e un tempo eccessivo dentro la transazione del worker sarebbe un problema.
- Il backfill delle citazioni: una citazione di una pagina di una generazione vecchia, già potata, non trova il codice e se ne va, come a lettura.
