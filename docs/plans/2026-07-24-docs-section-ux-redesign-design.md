# Redesign UX/UI della sezione Docs

Data: 2026-07-24
Stato: design validato, pronto per il piano di implementazione

## Contesto e problema

La sezione "Docs" (documentazione autogenerata, Confluence-like) presenta tre
pagine, ma tutte presumono che il visitatore sappia già cosa cerca. Osservate con
gli occhi di chi non conosce il prodotto:

- **Home di progetto (`/docs/project/:id`)** — mostra nome, una frase boilerplate
  ("Ask across all the project's repositories"), una sola card repo e un pannello
  chat vuoto che occupa metà schermo. Nessuna risposta a "cos'è questo progetto",
  "da dove comincio", "cosa c'è dentro le 346 pagine". La chat domina ma il nuovo
  arrivato non sa cosa chiederle.
- **Home di repo (`/docs/:repoId`)** — atterra su "SELECT A PAGE / Pick a page from
  the tree": schermo vuoto. A sinistra un albero di 117+ pagine tecniche con titoli
  troncati. Nessun "inizia da qui", nessuna sintesi, nessun percorso di lettura.
- **Sidebar** — titoli tagliati a metà, annidamento profondo, testo piccolo, tutte
  le voci sullo stesso piano visivo: impossibile distinguere il centrale dal
  periferico dentro 117+ voci in un'unica lista concatenata.
- **Release** — renderizzate come una `docPage` qualsiasi: nessuna data visibile,
  nessuna versione, nessuna cronologia, nessun segnale "importante vs minore".

**Nodo comune:** manca contesto d'ingresso e orientamento. Nessun overview, nessun
"start here", nessuna panoramica di "cosa c'è". Il focus del redesign è la UX di
orientamento; la UI è secondaria.

## Mappa del codice esistente (stato attuale)

Route (TanStack Router, `apps/web/src/router.tsx`, tutte sotto `authedRoute`):

| Route | Path | Componente | File |
|---|---|---|---|
| hub | `/docs` | `DocsPage` | `routes/docs/index.tsx` |
| home progetto | `/docs/project/$projectId` | `ProjectDocsLanding` | `routes/docs/project.$projectId.tsx` |
| spazio repo | `/docs/$projectId` | `DocsSpaceLayout` | `routes/docs/$projectId.tsx` |
| overview repo | `/docs/$projectId/` | `DocsSpaceIndex` | stesso file |
| brief | `/docs/$projectId/brief` | `DocsBriefView` | `routes/docs/brief.$projectId.tsx` |
| pagina | `/docs/$projectId/$slug` | `DocsPageView` | `routes/docs/$projectId.tsx` |

Nota naming: nelle route per-repo il param `projectId` è in realtà un
`repositoryId`. Solo `/docs/project/$projectId` usa un vero projectId.

Componenti chiave: `DocsSidebar` (`components/docs-sidebar.tsx`), `DocsTree`
(`components/docs-tree.tsx`, `buildForest` da nodi piatti via `parentId`/`position`),
`DocsGenerationPanel`, `DocsChat` (`components/docs-chat.tsx`, SSE, scope repo/project),
`GlobalSearchPalette` (⌘K), `Markdown` (`components/markdown.tsx`).

Classi doc (`docPageKind`, `packages/shared/src/schemas/docs.ts`): `technical`,
`functional`, `product`, `manual`, `releases`.

**Release (modello attuale):** non esiste tabella dedicata. Una release è una
`docPage` con `kind="releases"`, `generationId=null`, `isManual=false`,
`parentId=null`, creata dal worker in `apps/worker/src/docs/auto-update.ts`:
- `slug` = `release-<YYYYMMDD-HHmm>-<shortSha>` (data codificata nello slug).
- `title` con prefisso `[minore]` se non significativa.
- `position = -floor(now/1000)` (epoch negativo) → più recenti in cima.
- `significant`/`affectedSlugs` calcolati da `parseReleaseNotes`
  (`packages/docs-engine/src/releases.ts`) ma **non persistiti** come colonna.

**Cosa il backend NON espone oggi:**
- Nessun `viewCount` (assente in DB e API).
- `docPages.createdAt` esiste in DB ma non è in `treeNodeSchema` né `pageSchema`.
- Significatività release non è una colonna: solo prefisso `[minore]` nel titolo.

API rilevanti (`apps/server/src/routes/docs.ts`, client `apps/web/src/lib/docs-api.ts`):
`GET /api/docs/spaces`, `GET /api/projects/:id/docs/spaces` → `DocSpace`
`{ repositoryId, slug, name, pageCount, lastGenerationAt, lastCommitSha }`;
`GET /api/repositories/:id/docs/tree` → nodi `{ id, slug, title, kind, parentId,
position, sourcePath, isManual }`; `GET .../docs/pages/:slug` → `{ ..., body,
commitSha, links, updatedAt }`; `GET .../docs/status` → generation/latestJob/
pinnedProvider; `GET .../docs/brief` → brief completo + data generazione.

## Principio guida

Ogni pagina deve rispondere **"cosa è questo / da dove comincio"** prima di chiedere
di navigare.

## Sezione 1 — Home di progetto (`/docs/project/:id`)

Da pagina di smistamento a vera home a colonna singola (la chat diventa pannello
richiamabile, non protagonista):

1. **Hero orientativo** — nome progetto + sintesi "cos'è" dal `identity` del Project
   Brief (non la frase boilerplate). Multi-repo: sintesi del repo principale + link
   al brief completo.
2. **"Inizia da qui"** — 3-4 punti d'ingresso curati automaticamente: Project Brief,
   Architecture Overview (top page technical), Product docs, ultima release. Card
   grandi e cliccabili.
3. **Repository del progetto** — card più ricche: conteggio **per categoria**
   (Technical/Functional/Product/Releases), ultima generazione, ultima release con
   data.
4. **Novità** — striscia "Ultime release" cross-repo (con date) + "Pagine più viste /
   aggiornate di recente".
5. **Chat RAG** — resta ma come pannello aperto da pulsante "Chiedi ai docs", con 3-4
   **domande suggerite** pre-caricate per sbloccare chi non sa cosa chiedere.

## Sezione 2 — Home di repo + navigazione (`/docs/:repoId`)

### 2a. Overview di repo (rimpiazza "SELECT A PAGE")
Con nessuna pagina selezionata, la colonna centrale mostra una panoramica:
- Titolo repo + sintesi dal brief (`identity`) + "leggi il brief completo".
- **Card categoria** (Technical/Functional/Product/Releases) con conteggio e 3-4
  pagine di punta come scorciatoie.
- **Inizia da qui** — Architecture Overview + top page per categoria.
- **Novità** — ultime pagine aggiornate + ultime release con data + più viste.

### 2b. Sidebar navigabile
- **Selettore di categoria in cima** come tab/segmenti (Technical · Functional ·
  Product): si mostra **un albero per volta**, non 117+ voci concatenate. La
  categoria attiva segue la pagina in lettura.
- **Releases fuori dall'albero**: non sono una tab dell'albero ma rimandano alla
  vista changelog dedicata (Sezione 3), raggiunta da un link "Release · N".
- **Sidebar ridimensionabile** (drag, larghezza ricordata) + **tooltip** col titolo
  completo sui troncati.
- **Gerarchia visiva** migliore: pagina attiva evidenziata, contatore per sezione,
  rail di indentazione più leggibile.
- ⌘K e pannello Generation restano dove sono.

## Sezione 3 — Release come changelog first-class

Nuova vista `/docs/:repoId/releases` — timeline/changelog verticale:
- Ogni voce: **data** leggibile (es. "24 lug 2026"), **titolo**, **badge "minore"**
  quando non significativa, **commit** di riferimento.
- Corpo espandibile (markdown) con **link alle pagine impattate** (dai `links`).
- Ordine cronologico decrescente (da `position`).
- Filtro "solo significative" + ricerca testuale sul titolo.
- Entry point da sidebar ("Release · N") e dalle home come "Ultime novità".

**Changelog unificato di progetto** — nella home di progetto, una timeline release
aggregata di tutte le repo del progetto (per stakeholder/onboarding), oltre alla
vista per-repo.

Dati:
- **Data**: espongo `createdAt` (già in DB) — fonte affidabile invece dello slug.
- **Significatività**: persisto come colonna (`significant`), popolata dal worker
  (valore già calcolato da `parseReleaseNotes`); poi si toglie il prefisso `[minore]`
  dal titolo. Backfill dal prefisso esistente.
- **Pagine impattate**: già nei `links`.

## Sezione 4 — Backend e dati

1. **Esporre `createdAt`** (già in DB) in `treeNodeSchema` e `pageSchema`. Sblocca
   date release e "ultime create". Modifica banale.
2. **View count**:
   - Colonna `viewCount` (integer, default 0) su `docPages` — migrazione.
   - `POST /api/repositories/:id/docs/pages/:slug/view` con increment atomico; il
     client lo chiama **fire-and-forget** all'apertura pagina (nessun blocco della
     lettura, debounce per non contare refresh ravvicinati).
   - Esposto in `pageSchema` e nelle query di ranking.
3. **Significatività release**: colonna `significant` (boolean) su `docPages`,
   popolata dal worker alla creazione della release. Migrazione + una riga nel
   worker; backfill dal prefisso `[minore]` esistente. Rimozione successiva del
   prefisso dal titolo.
4. **Endpoint "highlights"** per alimentare le home senza scaricare tutto l'albero:
   - `GET /api/repositories/:id/docs/highlights` → `{ topViewed[], recentlyUpdated[],
     latestReleases[], countsByKind }`.
   - `GET /api/projects/:id/docs/highlights` → aggregato cross-repo, incluso il
     changelog unificato di progetto.

### Rollout / invarianti
- Migrazioni Drizzle con default (`viewCount=0`, `significant` backfillabile dal
  prefisso). Attenzione alla trappola batch-in-una-transazione (non usare un enum
  value appena aggiunto in una migrazione successiva; seed post-migrate se serve).
- Deploy: modifiche a `apps/web` → ribuildare **caddy**; modifiche a `apps/server`
  (nuovi endpoint) + worker (significant) → ribuildare server e worker.
- Non riavviare il worker con generazioni `running`/`paused` in corso.
- `pnpm lint` + `pnpm typecheck` + `pnpm test` prima del merge; E2E docs Playwright
  a mano per le modifiche UI (non girano in `pnpm -r test`).

## Decisioni prese durante il brainstorming
- Focus: tutti e tre i temi (onboarding, navigazione, release) come redesign coerente.
- Utenti: sviluppatori, nuovi arrivati, stakeholder non tecnici, chi cerca risposte
  puntuali — landing multi-pubblico.
- Ampiezza: pieno mandato, incluse modifiche backend/migrazioni dove servono.
- View count: incluso (increment fire-and-forget) oltre a "ultime aggiornate".
- Categorie sidebar: tab per Technical/Functional/Product, Releases fuori dall'albero.
- Release: versione ricca, incluso changelog cross-repo a livello progetto.

## Follow-up / non in scope (YAGNI)
- Versioning/semver esplicito delle release (oggi non c'è il dato).
- Analytics avanzate sulle viste (trend nel tempo): solo contatore assoluto per ora.
