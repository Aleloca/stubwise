# Filtro per percorso (sourcePath) sui widget

Data: 2026-07-05 · Stato: design validato · Estende: `2026-07-05-multi-widget-design.md`

## Obiettivo

Limitare le risposte di un widget a una **parte** di un monorepo: per ogni repo
abilitato, un filtro opzionale che restringe le doc_pages esposte al RAG alle
sole sezioni scelte (es. widget "Webapp" → solo `apps/webapp`).

## Decisioni chiave

| Tema | Decisione |
|---|---|
| Selettore durevole | **Prefissi di `sourcePath`** (stabili tra rigenerazioni; semantica `pathCovers` con confine `/`) + **slug** per le pagine senza percorso (manuali, panoramiche) |
| UI | Albero docs con checkbox tri-state nell'editor del widget (riuso `DocsTree`/`buildForest` + endpoint tree esistente); si salvano paths/slugs, mai pageId (volatili tra generazioni) |
| Pagine senza sourcePath | **Fail-closed**: escluse col filtro attivo, selezionabili singolarmente per slug |
| Scope | Solo superficie widget; la chat interna Docs NON è filtrata |

## Modello dati

- `widgets.repositoryFilters` (jsonb NOT NULL default `{}`): mappa
  `repositoryId → { paths: string[], slugs: string[] }`.
- Raffinamento opzionale di `enabledRepositoryIds`: repo abilitato senza entry
  (o entry con paths+slugs vuoti... vedi warning UI) = repo intero.
- **Match** (pagina del repo filtrato visibile se): `sourcePath` coperto da un
  prefisso (`= p` oppure `LIKE p || '/%'` — `apps/webapp` NON matcha
  `apps/webapp-admin`) **oppure** `slug ∈ slugs`.
- **Robustezza dichiarata**: gli slug autogenerati derivano dai titoli — una
  rigenerazione che cambia titolo fa decadere la selezione in modo fail-closed
  (si espone meno, mai di più). I paths sono stabili; gli slug manuali pure.
- **Validazione** (POST/PUT widget): chiavi di repositoryFilters ⊆
  enabledRepositoryIds (422); paths normalizzati (no slash iniziali/finali,
  no `..`, max 50); slugs max 100.

## Retrieval

- `RetrieveChunksOptions.repositoryFilters?: Record<string, {paths, slugs}>`.
- Scope predicate cross-repo esteso: repo senza filtro → condizione invariata;
  repo con filtro → `repositoryId = X AND pageId IN (subquery su doc_pages
  con match paths/slugs, generazione corrente)`. Subquery (non join) perché lo
  scope si applica a due gambe (`doc_chunks.pageId` / `doc_pages.id`); il
  predicato riceve già la tabella.
- La chat interna Docs non passa l'opzione → invariata.

## Superficie pubblica

- `widget.ts` endpoint messages: passa `request.widget.repositoryFilters` al
  retrieval. Config/conversazioni/ticket invariati (filtro invisibile al
  client).
- `chatEnabled` invariato (`enabledRepositoryIds.length > 0`): un filtro che
  non matcha nulla produce "non ho informazioni", non chat spenta.

## Migrazione

Solo `ALTER TABLE widgets ADD COLUMN repository_filters jsonb NOT NULL
DEFAULT '{}'` — additiva, zero data migration.

## UI (editor widget, SPA)

- Sotto ogni repo spuntato: blocco collassabile "Limita alle sezioni"
  (default chiuso = nessun filtro). Aprendolo carica l'albero docs
  (`GET /api/repositories/:id/docs/tree`) con checkbox tri-state: nodo con
  sourcePath → seleziona il sottoalbero (salva il path); pagina senza path →
  checkbox individuale (salva lo slug).
- Riepilogo compatto ("3 sezioni, 2 pagine") + "rimuovi filtro"; warning se
  filtro attivo con selezione vuota ("non esporrà nulla di questo repo").
- Deselezionare un repo dalla whitelist scarta la sua entry di filtro.

## Guida

Paragrafo "Exposing only part of a monorepo" nella pagina widget.

## Testing

- Server (testcontainers): match paths (dentro/fuori/`-admin` non matcha),
  match slugs (manuale), filtro vuoto fail-closed, repo senza filtro
  invariato, 422 filtri per repo non abilitati, path traversal rifiutato;
  end-to-end su messages (citazioni solo dalla sezione esposta).
- SPA (happy-dom): albero → payload repositoryFilters; warning selezione
  vuota; entry scartata al deselect repo.
- `packages/widget`: invariato.

## Deploy

Ribuild `server` + `caddy`; migrazione additiva all'avvio; backup DB di
routine; worker non toccato.

## Fuori scope

- Filtro sulla chat interna Docs
- Esclusioni negative ("tutto tranne X")
- Filtri per `kind`
