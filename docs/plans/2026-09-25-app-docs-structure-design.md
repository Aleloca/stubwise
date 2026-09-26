# La documentazione nell'app, come sul web — design

25 set 2026. Con Wisey (PR #56) il tab DOC è uscito, e con lui la ricerca
dentro la documentazione di un progetto. Il maintainer ha chiesto di
replicare nell'app la struttura del web: pagina generale del progetto,
ricerca, documentazione dei singoli repository, e dentro i repository le
categorie come tab.

Decisioni del maintainer:
1. **Pagina generale come il web**: ricerca, «Ask this project», «Start
   here», repository, novità. Le decisioni restano fuori: nell'app hanno già
   la loro sezione nell'hub del progetto.
2. **Pagina di un repository a tab**: Overview · Technical · Functional ·
   Product · Manual · Releases, solo quelle che hanno pagine. Ogni categoria
   è un albero. Graph resta fuori.

Decisioni tecniche mie, seguendo il web: **sola lettura** (generazione,
grafo, pagine manuali ed export restano sul web: sono azioni da admin e da
schermo grande), l'ultima tab aperta si ricorda per repository, e la pagina
singola guadagna badge, pagine collegate e conteggio delle visite.

## §1 — Premesse (verificate, branch base `feature/wisey-preview` a183ac2d)

Sul **web**:
- Pagina generale del progetto: `apps/web/src/routes/docs/project.$projectId.tsx`,
  dati `GET /api/projects/:id/docs/spaces`, `GET /api/projects/:id/docs/highlights`
  e il brief del repository «principale», quello con più pagine.
- Pagina del repository: `apps/web/src/routes/docs/$projectId.tsx` (il
  parametro è un `repositoryId`). L'albero si carica UNA volta
  (`GET /api/repositories/:id/docs/tree`) e le tab (`components/docs-tree.tsx`,
  ordine `technical, functional, product, manual`, solo quelle con pagine) lo
  filtrano. Dentro, una foresta da `parentId`, ordinata per `position` e poi
  per titolo (`buildForest`). La scelta della tab si ricorda per repository.
- Panoramica: `components/docs-repo-overview.tsx`, con
  `GET /api/repositories/:id/docs/highlights` e `GET .../docs/brief`.
- Changelog: `components/docs-releases.tsx`, fatto dai nodi `kind ===
  "releases"` dell'albero, con i filtri titolo e «only significant».
- Pagina: `GET .../docs/pages/:slug`, con badge (commit, data), link
  «Related» e ping delle visite `POST .../docs/pages/:slug/view`.
- Ricerca in un repository: `GET /api/search?q&repositoryId` più
  `GET /api/search/docs-semantic?q&repositoryId`, fusi e deduplicati per
  `(repositoryId, slug)` con la semantica prima.

Nell'**app**:
- `ProjectDocsScreen` elenca i repository a fisarmonica con
  `DocSpaceBrowser`, che ha tre gruppi fissi (Functional, Releases,
  Technical) in liste piatte. **Product e Manual non si vedono affatto.**
- `DocsPageScreen` mostra solo il corpo in markdown.
- `api-client` ha già: `docs.projectSpaces`, `docs.tree`, `docs.page`,
  `search.global(q, repositoryId?)`, `search.docsSemantic(q, repositoryId?)`.
  **Non ha** gli highlights (i loro schemi vivono solo in
  `apps/server/src/routes/docs-highlights.ts`), il brief (lo schema della
  risposta è scritto dentro la rotta, `docs.ts:~446`), la ricerca di progetto
  (`GET /api/projects/:id/docs/search`, `project-docs.ts:297`, il suo schema è
  a `:68` ed è ibrida come la chat; nessuno la chiama) e il ping delle visite.

## §2 — Server e pacchetti condivisi: SPOSTAMENTI, nessun cambio di forma

- `repoHighlightsSchema`, `projectHighlightsSchema` e i loro pezzi passano
  da `docs-highlights.ts` a `packages/shared/src/schemas/docs.ts`. Lo schema
  della risposta del brief e `searchResultSchema` di `project-docs.ts` passano
  anche loro in shared, con un nome esplicito
  (`docBriefResponseSchema`, `projectDocsSearchResultSchema`). Le rotte
  importano da lì. **Nessuna forma cambia**: i test esistenti del server
  devono passare senza essere toccati, come nello spostamento degli schemi
  dei server del 23 set.
- `api-client`: `docs.repoHighlights`, `docs.projectHighlights`,
  `docs.brief`, `docs.projectSearch`, `docs.viewPage` (il ping). Nessun campo
  nuovo, quindi niente trappola dei campi mancanti; gli enum passano da
  `readerSchema` come sempre.
- ⚠️ Il web ha una sua copia di questi tipi in `lib/docs-api.ts`: **non si
  tocca** in questo lavoro. Fuori perimetro.

## §3 — La pagina generale (`ProjectDocsScreen`, riscritta)

Dall'alto:
1. **Ricerca** del progetto: un campo con debounce di 300 ms che chiama
   `docs.projectSearch`. I risultati sostituiscono il contenuto della pagina
   finché il campo non è vuoto: titolo, `repositoryName · categoria`, snippet.
   Il tap apre `Page`.
2. **«Ask this project ›»**, com'è oggi.
3. **Start here**: il brief del repository principale (con più pagine,
   `mainDocSpace`, già usato prima), la panoramica del repository principale
   e l'ultima release.
4. **Repositories**: nome, numero di pagine, ultima release o ultima
   generazione. Il tap apre la pagina del repository.
5. **What's new**: le novità di tutti i repository (`latestReleases` e
   `topViewed` degli highlights di progetto), ciascuna col repository
   d'origine.

Stati: caricamento, errore con riprova, nessuna documentazione. Gli
highlights e il brief sono letture ACCESSORIE, fuori dai gate: se falliscono
la sezione non compare e la pagina resta intera.

## §4 — La pagina di un repository (`RepoDocsScreen`, nuova)

- Rotta `RepoDocs { repositoryId, repositoryName }` nello stack dei
  progetti. Intestazione col nome del repository e l'icona di ricerca.
- **Fila di tab scorrevole**: Overview · Technical · Functional · Product ·
  Manual · Releases. Overview c'è sempre, le altre solo se hanno pagine.
  L'ultima tab si ricorda per repository in AsyncStorage (try/catch, mai
  bloccante); se quella tab non esiste più (nessuna pagina), si apre Overview.
- **Overview**: il brief (identità in testa e riga «Brief ›»), «Start here»
  (prima pagina technical, prima product, ultima release), un tile per
  categoria col conteggio che apre la tab e le novità (3 release, 4
  aggiornate di recente, 4 più viste).
- **Tab di categoria**: l'albero delle pagine di quella categoria, costruito
  da `parentId` come `buildForest` del web, con i nodi apribili. Il tap su un
  titolo apre `Page`. Un nodo con figli si apre col chevron e il titolo apre la
  pagina.
- **Releases**: il changelog in ordine di `position`, con data e commit
  ricavati dallo slug come sul web (`release-YYYYMMDD-HHmm-<sha>`), il badge
  «minor» e un interruttore «Only significant». Il tap apre `Page`.
- **Brief**: una schermata semplice (`RepoBrief`) col brief in markdown o in
  campi, come `DocsBriefView` del web.
- **Ricerca nel repository**: l'icona apre un campo in testa. Come il web,
  `search.global(q, repositoryId)` più `search.docsSemantic(q, repositoryId)`,
  fusi e deduplicati per `(repositoryId, slug)` con la semantica prima. I
  risultati coprono le tab finché il campo non è vuoto.

## §5 — La pagina singola (`DocsPageScreen`)

In più rispetto a oggi: badge (categoria, data di aggiornamento, commit
abbreviato), la sezione **Related** con le pagine collegate, raggruppate come
sul web (implemented by / implements / related) e premibili, e il ping delle
visite fire-and-forget, deduplicato per slug con un TTL come `useViewPing`,
che non fa mai fallire la pagina.

## §6 — Cosa si toglie

`DocSpaceBrowser` e `groupTreeByKind`, sostituiti dalla pagina del
repository. `HubDocsSection` nell'hub del progetto resta: una riga per
repository apre ora `RepoDocs`, e «see all» apre la pagina generale.

## §7 — Rilascio

L'app più `packages/shared`, `packages/api-client` e `apps/server`, dove ci
sono solo gli spostamenti. **Il server va ribuildato** per coerenza
(importa gli schemi dal posto nuovo), ma nessuna risposta cambia: il rollback
è innocuo. La PR va aperta **dopo il merge di #56**, perché ci si appoggia.
