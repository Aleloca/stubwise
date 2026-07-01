# Ricerca globale (spotlight Cmd/K) — Design

**Data:** 2026-07-01
**Stato:** VALIDATO in brainstorming con l'utente. Pronto per il piano di implementazione.

## Obiettivo

Una **ricerca globale** invocabile da qualsiasi pagina (spotlight **Cmd/K**) che cerca
in **tutto** — Ticket, Progetti, Repository, Documentazione — e permette di **saltare**
al risultato. Riusa e generalizza la command palette dei Docs (`docs-command-palette`) e
la sua cronologia (`doc_search_history`), rendendole globali. Preserva la ricerca
**dentro** una singola documentazione (scope-aware).

## Decisioni validate (brainstorming)

- **D1 — Entità (4 core):** **Ticket** (titolo + body + **commenti**), **Progetti**
  (nome/slug/descrizione), **Repository** (nome/slug/URL), **Documentazione** (pagine:
  titolo + contenuto). Milestone / persone / viste salvate → fase successiva (l'impianto
  le renderà banali da aggiungere).
- **D2 — Metodo a DUE VELOCITÀ:**
  - *Corsia veloce* (debounce ~150 ms): **full-text istantaneo** su Ticket, Progetti,
    Repository, **e** full-text sui Docs → risultati mentre digiti.
  - *Corsia lenta* (debounce ~600 ms): **retrieval semantico sui Docs** (embedding della
    query via Ollama), che **arricchisce/ri-ordina** il gruppo Documentazione. Il gruppo
    Docs non è mai vuoto (full-text immediato) e "diventa più intelligente" alla pausa.
  - Niente semantica su ticket/progetti/repo (nessun embedding da mantenere lì).
- **D3 — UX: spotlight modale Cmd/K** (e Ctrl/K), overlay centrato, estetica terminal.
  Risultati **raggruppati per tipo** (`TKT` / `PRJ` / `REP` / `DOC`), ognuno ordinato
  internamente per rilevanza (`ts_rank`/score) + recenza; **~5 per gruppo** con "mostra
  altri" inline. Ogni riga: sigla del tipo + titolo + **contesto** (es. progetto del
  ticket, snippet con match evidenziato). Navigazione da tastiera (frecce, Invio = salta,
  Esc = chiudi). Invio su un risultato → naviga alla pagina dell'entità.
- **D4 — Cronologia** dei risultati **cliccati** (recenti), generalizzando
  `doc_search_history` in una cronologia **globale** poliforma (qualsiasi tipo). A query
  vuota la palette mostra i recenti. Quando lo scope è "questa documentazione", i recenti
  sono quelli di quello spazio (comportamento Docs attuale preservato).
- **D5 — Palette UNICA scope-aware** (preserva la ricerca interna ai Docs): un solo Cmd/K.
  Aperta **dentro uno spazio Docs** (`/docs/<repo>`) parte **ristretta a "questa
  documentazione"** (full-text + semantica di quello spazio + sua cronologia), con uno
  **switch di scope** in cima `[ Questa documentazione ] · [ Tutto ]` (Tab per alternare).
  Fuori dai Docs è **globale**. Il debounce a due velocità vale in entrambi gli scope.
- **D6 — Permessi:** tutti gli utenti autenticati vedono tutto (Stubwise non ha ACL
  per-progetto; i ruoli admin/member sono d'istanza). La ricerca globale ritorna tutto.

## Backend

Due endpoint, per separare pulitamente le due corsie e le loro latenze:

- **`GET /api/search?q=&scope=&repositoryId=`** — *corsia veloce, federata full-text.*
  Esegue in parallelo:
  - **Ticket**: `websearch_to_tsquery('english', q)` sull'indice esistente (titolo+body,
    e i commenti già indicizzati — migrazione 0017); ritorna top-N con `ts_rank`, numero,
    stato, progetto. Cross-progetto (globale).
  - **Progetti**: full-text/ILIKE su nome/slug/descrizione (pochi record; un indice
    minimo o ILIKE va bene).
  - **Repository**: full-text/ILIKE su nome/slug/repoUrl.
  - **Docs (full-text)**: `doc_pages.searchTsv` (già esistente) su **tutti** i repo con
    generazione corrente (globale) oppure sul `repositoryId` dello scope; ritorna
    slug/titolo/kind/snippet + repository.
  Risposta raggruppata per tipo, top-N per gruppo + flag "haMore".
- **`GET /api/search/docs-semantic?q=&repositoryId=`** — *corsia lenta, semantica Docs.*
  Riusa il retrieval della Fase 2: `retrieveChunks(repositoryId)` se scope = una
  documentazione, altrimenti una variante **globale** `retrieveChunksAll` (stesso
  predicato OR-di-coppie per-repo, ma su **tutti** i repo con generazione corrente).
  Ritorna i chunk/pagine con repository e score. Il client lo chiama sul debounce lungo e
  fonde i risultati nel gruppo Docs (dedup per (repositoryId, slug), semantica prima).
- **Cronologia**: `GET /api/search/history` (recenti dell'utente, opz. filtrati per
  scope), `POST /api/search/history` (registra un risultato cliccato), `DELETE` per
  voce/clear (come oggi per i Docs).

### Modello dati (migrazione 0036)

Generalizzare `doc_search_history` in **`search_history`** (cronologia dei risultati
cliccati, per utente, denormalizzata per render immediato senza join):
- `id`, `userId` (FK, cascade), `type` enum (`ticket|project|repository|doc`),
  `entityId` text (id del ticket/progetto/repo, o `repositoryId:slug` per una pagina
  doc), `title` text, `subtitle` text? (es. progetto del ticket / kind della pagina),
  `route` text (dove navigare), `repositoryId` uuid? (per filtrare i recenti in scope
  Docs), `clickedAt` timestamptz.
- UNIQUE `(userId, type, entityId)` (upsert su click, come oggi); prune oltre N per
  utente; indice `(userId, clickedAt desc)` e `(userId, repositoryId, clickedAt desc)`.
- Migrazione dati da `doc_search_history` → righe `type='doc'` (mappando
  slug/title/kind/repositoryId → il nuovo schema), poi drop della vecchia tabella. In
  alternativa, se più sicuro, **mantenere** `doc_search_history` e aggiungere `search_history`
  nuova; ma il design punta a UNIFICARE (una sola cronologia). Decidere in fase di piano
  in base alla complessità della migrazione dati.

## Web

- **`GlobalSearchPalette`** — generalizzazione di `docs-command-palette`: campo query,
  gruppi per tipo, navigazione tastiera, cronologia, stato loading/empty, snippet
  evidenziato. Props/scope: `scope: "global" | { repositoryId }`.
- **Trigger globale**: Cmd/K (e Ctrl/K) registrato a livello di `app-layout` → apre la
  palette in scope globale. Dentro `/docs/<repo>`, il Cmd/K esistente apre la **stessa**
  palette in scope `{ repositoryId }` (default "questa documentazione") con lo switch a
  "Tutto". Un affordance di ricerca (icona/scorciatoia) nell'header/sidebar.
- **Due velocità**: hook con due debounce — corto per `/api/search`, lungo per
  `/api/search/docs-semantic`; i risultati semantici confluiscono nel gruppo Docs.
- **Scope switch**: pill/tab `[ Questa documentazione ] · [ Tutto ]` (Tab), visibile solo
  quando si apre da uno spazio Docs.
- **Click su risultato**: naviga alla route dell'entità e registra la cronologia
  (`POST /api/search/history`).
- i18n it/en per label/gruppi/scope/empty.

## Testing

- Server: `/api/search` ritorna risultati corretti per ciascun tipo (ticket per
  titolo/body/commento; progetto per nome/slug; repo; doc full-text), raggruppati,
  rispettando lo scope Docs; `/api/search/docs-semantic` globale e per-repo; cronologia
  CRUD + prune + filtro per scope; migrazione 0036 (dati doc_search_history preservati).
- Web: palette apre con Cmd/K globale; due velocità (full-text subito, semantica dopo il
  debounce lungo — con retrieval mockato); gruppi e navigazione tastiera; scope switch
  dentro i Docs (default "questa documentazione", Tab → "Tutto"); cronologia (recenti a
  query vuota, click registra); la ricerca **interna ai Docs resta funzionante**.
- E2E: aggiornare/estendere se rilevante (la palette Docs esistente non deve regredire).

## Fuori scope (prima versione)

- Semantica su ticket/progetti/repo (solo full-text lì).
- Milestone / persone / viste salvate come entità cercabili (fase successiva).
- Pagina `/search` dedicata con filtri/paginazione (eventuale seconda iterazione).
- ACL per-progetto (non esiste in Stubwise).

## Piano (sotto-fasi subagent-driven)

- **1 — Backend full-text federato + cronologia + migrazione 0036.** `/api/search`, model
  `search_history`, migrazione (con dati Docs preservati). Test.
- **2 — Backend semantico globale.** `retrieveChunksAll` + `/api/search/docs-semantic`
  (globale e per-repo). Test.
- **3 — Web palette globale scope-aware.** `GlobalSearchPalette` (da docs-command-palette),
  trigger Cmd/K globale, due velocità, scope switch, cronologia, i18n. La palette Docs usa
  la stessa componente in scope repo. Test.
- **4 — Verifica full-repo + review olistico + merge** (deploy: server+worker? no — solo
  server+caddy; il worker non è coinvolto. Backup DB per la migrazione).
