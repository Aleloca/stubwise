# Command palette di ricerca dei Docs — Design

**Data:** 2026-06-24
**Stato:** approvato, pronto per il piano di implementazione

## Obiettivo

Sostituire la ricerca inline nella sidebar dello spazio Docs con una **command
palette** centrale (modale) apribile cliccando il trigger o con **Cmd/Ctrl+K**.
La palette offre autocomplete sui risultati (titolo + tag kind + anteprima testo)
e, a input vuoto, una **cronologia per-utente e per-progetto** delle pagine
aperte dai risultati, con cancellazione singola e totale.

Motivazione: la search inline attuale è poco visibile e poco ergonomica; una
palette Cmd/K è lo standard de-facto e si sposa con l'estetica "terminal".

## Stato di partenza

- Il backend di ricerca **esiste già**: `GET /api/projects/:projectId/docs/search?q=`
  fa ricerca ibrida (semantica pgvector + full-text `search_tsv`) e restituisce
  `{slug,title,kind,snippet,score,source}` (`apps/server/src/routes/docs.ts:525`,
  `docs-retrieval.ts`). Nessuna modifica necessaria alla search vera e propria.
- Frontend attuale: `DocsSearch` (input inline + lista) montato in `DocsSidebar`.
- Pattern route docs: `preHandler: requireAuth`, utente corrente in
  `request.user!.id`, check esistenza progetto; nessuna membership oltre l'auth.

## UX & interazione

**Trigger.** Al posto dell'input inline, un box-pulsante in stile terminal
`⌕ Cerca nella documentazione… ⌘K`. Apertura: clic o **Cmd/Ctrl+K** (scorciatoia
globale attiva nello spazio Docs). Su mobile: pulsante che apre lo stesso modale.

**Modale.** Overlay centrale (`role="dialog"`, `aria-modal`), backdrop scuro,
focus-trap, **Esc** chiude. Estetica Stubwise (sfondo `ink`, bordi `line`), non
bianco. Input in alto con icona, autofocus.

**Due stati nel corpo:**
- Input vuoto (o < 2 caratteri) → sezione **RECENTI**: la cronologia (utente +
  progetto) delle pagine aperte dai risultati. Ogni riga: titolo + tag kind, con
  **✕** per cancellare la voce; in testa **"Cancella tutto"**.
- ≥ 2 caratteri → **risultati live**: autocomplete debounced (250ms) dalla search
  esistente — titolo + tag kind + **anteprima testo** (snippet). Stato
  "nessun risultato" esplicito.

**Tastiera.** `↑/↓` muovono la selezione, `↵` apre la voce evidenziata, `Esc`
chiude. Footer-hint `↑↓ naviga · ↵ apri · esc chiudi`.

**Al clic/Enter.** Naviga a `/docs/$projectId/$slug`, chiude il modale e
**registra il clic** in cronologia (dedup per slug: il re-clic la sposta in cima).
Recenti mostrati: ultime ~8 voci.

## Backend

### Tabella `doc_search_history` (migrazione 0028)

| campo | tipo | note |
|---|---|---|
| `id` | uuid PK `defaultRandom` | |
| `projectId` | uuid FK → projects | `onDelete: cascade` |
| `userId` | uuid FK → users | `onDelete: cascade` |
| `slug` | text notNull | pagina cliccata |
| `title` | text notNull | snapshot (mostra senza join) |
| `kind` | docPageKind notNull | TECH/FUNZ/MANUALE |
| `clickedAt` | timestamptz notNull `defaultNow` | aggiornato al re-clic |

Indici:
- `uniqueIndex(userId, projectId, slug)` → re-clic = **upsert** (aggiorna
  `clickedAt`), niente duplicati.
- `index(userId, projectId, clickedAt desc)` → lettura ultimi N veloce.

**Snapshot title/kind invece di FK a `doc_pages`**: le pagine autogenerate
vengono distrutte/ricreate ad ogni rigenerazione (slug deterministico, id nuovo).
Lo snapshot fa sopravvivere la cronologia alle rigenerazioni; se lo slug non
esiste più, il clic ricade sul placeholder "pagina non trovata" già esistente.

### Endpoint (tutti `requireAuth`, scope `request.user.id` + `projectId`, check progetto)

- `GET /projects/:projectId/docs/history` → ultime ~8 voci, `clickedAt desc`.
- `POST /projects/:projectId/docs/history` `{slug,title,kind}` → upsert
  (`onConflict (userId,projectId,slug) do update set clickedAt = now()`).
- `DELETE /projects/:projectId/docs/history/:slug` → cancella una voce.
- `DELETE /projects/:projectId/docs/history` → svuota per utente+progetto.

**Ritenzione.** Dopo l'upsert, pota le voci oltre le ultime ~20 per
utente+progetto (`DELETE ... WHERE id NOT IN (top 20 by clickedAt)`), così la
tabella non cresce illimitata.

## Frontend

**Componenti**
- `DocsCommandPalette` — il modale; stato `open` nel layout `routes/docs/$projectId.tsx`
  (Cmd/K ovunque nello spazio; sidebar desktop e drawer mobile aprono la stessa
  istanza).
- `DocsSearchTrigger` — sostituisce `DocsSearch` inline in `DocsSidebar`: il
  box-pulsante che apre la palette.
- Listener globale Cmd/Ctrl+K nel layout (`preventDefault`; ignora se un input
  fuori dalla palette ha già il focus).
- `DocsSearch` attuale: la logica risultati viene assorbita nella palette.

**Dati (`docs-api` + React Query)**
- `searchDocs` (esiste); nuove: `getDocsHistory`, `recordDocsHistoryClick`,
  `deleteDocsHistoryEntry`, `clearDocsHistory`.
- Query cronologia (`docsKeys.history(projectId)`); mutation clic/delete/clear
  con **update ottimistico** (la ✕ e "Cancella tutto" aggiornano subito la cache).
- Clic su un risultato: `recordDocsHistoryClick` fire-and-forget (non blocca la
  navigazione) → naviga.

**Accessibilità**: `role="dialog"` + `aria-modal`, focus-trap, `aria-label`,
ripristino del focus al trigger alla chiusura, selezione tastiera via
`aria-activedescendant`.

## Testing

- *Server*: i 4 endpoint — auth, scoping per utente/progetto (isolamento tra
  utenti), upsert/dedup, delete singola/tutte, 404 progetto, poda oltre N.
- *Web*: la palette — Cmd/K apre; digitando compaiono i risultati (search
  mockata); input vuoto mostra i RECENTI (history mockata); clic registra +
  naviga + chiude; ✕ rimuove una voce; "Cancella tutto" svuota; navigazione
  tastiera ↑↓↵.
- Migrazione 0028 + copertura schema.

## Deploy

Frontend → ribuilda `caddy`; endpoint → ribuilda `server`. Migrazione applicata
dal server all'avvio. (Vedi `CLAUDE.md`.)

## Fuori scope

- Ricerca globale dell'app (questa palette è solo per i Docs del progetto corrente).
- Sync cross-dispositivo oltre a quello già garantito dallo storage server-side.
- Cronologia delle query digitate (registriamo solo le pagine cliccate).
