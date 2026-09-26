# La documentazione nell'app, come sul web — piano

Design: `2026-09-25-app-docs-structure-design.md`. Branch
`feature/app-docs-structure`, worktree `.worktrees/app-docs`, base
`feature/wisey-preview` (PR #56, non ancora mergiata: quando lo è, rebase su
main). Un commit per task, TDD, un test che passa al primo colpo si fa
fallire apposta, e al doppio del client si aggiunge il metodo PRIMA del test.

## Task 1 — Schemi in shared, rotte che li importano (design §2)
Sposta gli schemi degli highlights, della risposta del brief e dei risultati
della ricerca di progetto in `packages/shared/src/schemas/docs.ts`. Le rotte
del server li importano. I test esistenti del server passano **senza essere
toccati**: se uno va toccato, fermati e dimmelo, vuol dire che la forma è
cambiata. Aggiungi i test di parse in shared.

## Task 2 — api-client
`docs.repoHighlights`, `docs.projectHighlights`, `docs.brief`,
`docs.projectSearch`, `docs.viewPage`. Test accanto a quelli esistenti.

## Task 3 — Logica pura dell'app
In `lib/`: la foresta delle pagine (come `buildForest` del web: `parentId`,
`position`, poi titolo), le tab disponibili di un repository (Overview più le
categorie con pagine, ordine fisso), il parse dello slug delle release, la
fusione dei risultati di ricerca con dedup e semantica prima, e la memoria
della tab (AsyncStorage, try/catch). Test puri per ciascuna.

## Task 4 — `RepoDocsScreen` (design §4)
Rotta nello stack dei progetti, tab, Overview, alberi, Releases, ricerca nel
repository, e `RepoBrief`. Test coi doppi completi: tab mostrate solo se con
pagine, memoria della tab, albero apribile, filtro «only significant»,
ricerca che copre e scopre le tab, letture accessorie che falliscono senza
far cadere la schermata.

## Task 5 — Pagina generale (design §3)
Riscrivi `ProjectDocsScreen`. `HubDocsSection`: la riga apre `RepoDocs`.
Togli `DocSpaceBrowser` e `groupTreeByKind` coi loro test. Test: ricerca di
progetto, sezioni accessorie assenti se falliscono, tap sui repository.

## Task 6 — Pagina singola (design §5)
Badge, Related premibile e ping delle visite deduplicato. Test: il ping parte
una volta per slug entro il TTL, e un ping che fallisce non tocca la pagina.

## Verifica finale
`pnpm lint`, typecheck di tutto, test di shared, api-client, server e app.
Pusha e scrivimi: la prova la fa il maintainer sul telefono, con le etichette
inglesi di `en.json`.
