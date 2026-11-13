# Integrazione area 8, fetta 1 «Rilasci» — parità col prototipo (13 nov 2026)

Cosa della sezione Releases del prototipo arriva sul server vero nella fetta
1 dell'area 8. Piano: `docs/plans/2026-11-13-integrazione-area8-fetta1-plan.md`
(su `feat/area8-f1`), design `docs/plans/2026-11-13-integrazione-area8-design.md`
(il lato renderer di 94), inventario e decisioni
`docs/plans/2026-11-13-integrazione-area8-inventario.md`. Server, worker e
`@stubwise/api-client` sono di stubwise-72 (`feat/area8-f1`); qui il
renderer e i moduli condivisi che il piano gli assegna
(`feat/area8-f1-renderer`).

Nella build app sono ACCESE (via di 46, 13 nov 2026), ognuna col suo
cancello (R-1 = a): `releases-prs`, `releases`, `releases-repo-settings` e la
sezione di progetto `releases`. Restano spente `releases-explain` e
`environments`.

## Renderer e moduli condivisi (stubwise-94)

| Voce del prototipo | Build app | Test | Stato |
|---|---|---|---|
| Lo stato di un rilascio (`releaseStatus`) | `releaseStatusOf` in `@stubwise/shared` (`releases/status.ts`), puro, lo stesso del server e del worker; con le run illeggibili (`unknown`) mai «riuscito» (stato `unknown`, salvo un commit già visto in produzione). Il prototipo delega | `shared/releases/status.test.ts`, `domain/releases/releaseStatus.test.ts`, `pages/releases/format.test.ts` | fatto |
| La bozza delle note della PR | `citedTaskCodes` e `releaseNotesDraft` in shared (`releases/notes.ts`), puri; i codici di progetto come li ammette il server (`^[A-Z][A-Z0-9]{1,5}$`). Il prototipo delega | `shared/releases/notes.test.ts`, `data/releases/notes.test.ts` | fatto |
| Lo stato di una PR e il ramo vietato | `prStateOf`, `isReadyForRelease` e `colleaguePrBlock` in shared (`releases/pr-state.ts`): l'invariante «Le PR dei colleghi» in un posto (lo usano anche il worker e `enqueueCorrection`); `mergeable: null` non blocca la prontezza. Il prototipo delega | `shared/releases/pr-state.test.ts`, `domain/releases/prState.test.ts` | fatto |
| Le PR aperte, la coda, il merge in due passi (`releases-prs`) | `releasePrs.ts` su `client.releases.pulls/queue` e `client.tickets.release`: stato, prontezza e permessi dal server; `canMerge` = la PR è nella coda di chi guarda; `merge_failed` (502) in parole; «AUD-V7 created» dal `releaseCode` del merge | `real/releasePrs.test.ts`, `real/releasesPrsPage.test.tsx` (anche il merge negativo), `ComingSoon.test.tsx` | fatto |
| «Chiedi modifiche», «Solo analisi», la storia delle correzioni, le note della PR | sulle rotte di 72 (correzioni post-PR, `analysis-only`, `release-notes`); la storia dal server (dalla più vecchia), la bozza delle note per il riquadro di Claude solo a chi le può scrivere | `real/releasePrs.test.ts` | fatto |
| I rilasci, il dettaglio, «Fai sistemare a Claude» (`releases`) | `releases.ts` su `client.releases.list/get/fix`: le run col link al provider (P-1 = a: niente log nell'app), la nota e `start` (Claude parte se il server lo permette), l'esito `existing/noteAdded` | `real/releases.test.ts`, `real/releasesF1Page.test.tsx` | fatto |
| La Home «Rilasci» | `listMyReleases` su `client.releases.mine()`: i falliti e le PR pronte col loro progetto | `real/releasePrs.test.ts`, `real/releasesF1Page.test.tsx` | fatto |
| Le impostazioni di rilascio del repository (`releases-repo-settings`) | `releaseRepos.ts` su `client.repositories.list` e `updateReleaseSettings`; la sezione «Repositories» RIDOTTA (46): elenco in sola lettura e nell'editor SOLO «Releases» | `real/releaseRepos.test.ts`, `real/releasesF1Page.test.tsx`, `ComingSoon.test.tsx` | fatto |
| I «Simula» dei rilasci (R-2) | non ci sono nella build app (dettaglio e pannello della PR) | `pages/releases/AppBuildPrototypeOnly.test.tsx` | fatto |
| La review dell'istanza spenta | una PR pronta senza analisi è «Not analyzed: automatic review is off», mai «senza problemi» (46); «Analysis is off for <repo>» solo per un repository spento | `pages/releases/format.test.ts`, `real/releasePrs.test.ts` | fatto |
| «Spiega» | spento (`releases-explain`) finché la chat non ha `read_release` e il suo golden è verde | `real/releasesF1Page.test.tsx` (assente) | rimandato |
| Gli ambienti per repository | spenti (`environments`): «Coming soon» nella sezione, nessuna lettura; si accendono con la F4a (46) | `real/releasesPrsPage.test.tsx`, `real/releasesF1Page.test.tsx` | rimandato |

### Differenze dichiarate

- Ciò che il server non legge nella F1 la pagina non lo inventa: niente
  rischio né autore per una PR esterna, `mergeable` non letto (mai
  «conflitti»), nessuna correzione `discarded`. I problemi di una PR
  esterna sono un elemento sintetico col riassunto della review.
- Il server di produzione si mostra col suo nome: il server vero non ha i
  codici `SRV-n` del prototipo.
- Una PR di un server di prima senza `projectId` non entra nella Home
  «Rilasci» (senza progetto non avrebbe link).
- Il registro dei rimandi (area 8) tiene ambienti, «Spiega», la sezione
  Repositories intera e i fatti non letti.
