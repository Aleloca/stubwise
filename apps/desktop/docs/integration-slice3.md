# Integrazione area 2, fetta 3 — parità col prototipo (9 nov 2026)

Cosa della `area2-parity.md` funziona sul server vero nella **build app**
(desktop e `/app`) con la fetta 3: Home a blocchi, ruoli di reparto, «Da
decidere», catalogo dei blocchi dell'area 2 e filtri salvati. Design:
`docs/plans/2026-11-09-integrazione-area2-fetta3-design.md`; piano:
`docs/plans/2026-11-09-integrazione-area2-fetta3-plan.md`. Le fette precedenti
stanno in `integration-slice1.md` e `integration-slice2.md`.

Le convenzioni sono quelle delle fette precedenti:
- i percorsi del renderer sono relativi a `apps/desktop/src/renderer/`;
- «real/» è `data/backend/real/`, l'implementazione vera dietro `@backend/api`;
- le rotte sono di `apps/server/src/routes/`.

Il prototipo resta com'era. Le regole della Home (`FIXED_BLOCKS`, `sameBlock`,
`withFixed`, `resolveHome`) e dei criteri (`filterCriteriaSchema`,
`parseCriteria`, `periodRange`, `canUseStatusIds`) stanno ora in
`@stubwise/shared` (`packages/shared/src/tasks/home.ts`,
`packages/shared/src/schemas/task-filter.ts`, `packages/shared/src/tasks/filters.ts`),
e `domain/{home,filters}.ts` le riesportano; `matches` resta del finto. I test
«app» montano l'implementazione vera davanti a un server finto
(`real/fakeServer.ts`). Migrazioni: `0116_task_filters.sql`, `0117_homes.sql`.

## Home a blocchi

| Voce | Dove vive (renderer) | Rotta | Test |
|---|---|---|---|
| Home su `/home`, e dopo il login si atterra lì (non più su La mia settimana) | `pages/home/HomePage.tsx`; `data/integration.ts` (`home`, `landingSearch`) | `GET /api/me/home` | `pages/ComingSoon.test.tsx` («dopo il login si atterra sulla Home a blocchi»), `real/loginFlow.test.tsx`, `data/integration.test.ts` |
| Home predefinita del reparto e unione per chi sta in più reparti (stesso blocco una volta, nell'ordine del primo) | `data/queries.ts` (`useHome`, `resolveHome` condivisa); `real/home.ts` (`listDepartmentHomes`, `getPersonalHome`) | `GET /api/departments/:id/home`, `GET /api/me/home` | `real/home.test.ts`, `real/homePage.test.tsx`; `packages/shared/src/tasks/home.test.ts`; server `home.test.ts` («senza Home personale: l'unione…») |
| Home personale: personalizza, nascondi, aggiungi, riordina (mouse e tastiera), ripristina | `pages/home/HomeEditor.tsx`; `real/home.ts` (`setPersonalHome`, `resetPersonalHome`) | `PUT /api/me/home`, `DELETE /api/me/home` | `HomePage.test.tsx` (prototipo), `real/home.test.ts`; server `home.test.ts` («si salva normalizzata…») |
| Home di un reparto disposta da chi la gestisce (solo filtri pubblici) | `HomeEditor.tsx` (bersaglio reparto); `real/home.ts` (`setDepartmentHome`) | `PUT /api/departments/:id/home` | `real/home.test.ts` (rifiuto `filter_not_public`); server `home.test.ts` («la cambia un full admin o chi ha department.home.manage…», «nella Home di un reparto solo filtri pubblici…») |
| «La Home del reparto è cambiata · Vedi le novità» | `HomePage.tsx` (`ChangedLine`, `WhatsNew`); `real/home.ts` (`markDepartmentHomeSeen`) | `POST /api/me/home/seen/:departmentId` | `HomePage.test.tsx`, `real/home.test.ts`; server `home.test.ts` («la Home del reparto cambia dopo…») |
| Blocchi fissi «Da decidere» e «La mia settimana» | `domain/home.ts` → `@stubwise/shared` (`FIXED_BLOCKS`, `withFixed`) | il server normalizza in scrittura | `packages/shared/src/tasks/home.test.ts`; server `home.test.ts` |
| Un blocco di un tipo che questa app non conosce si ignora, ma salvando la Home non si perde (né quello di un'area non integrata) | `real/home.ts` (`knownBlocks`, blocchi grezzi), `domain/home.ts` (`withHiddenBlocks`), `HomeEditor.tsx`, `registry.ts` (`isHiddenBlock`) | `GET`/`PUT /api/me/home`, `PUT /api/departments/:id/home` | `real/home.test.ts`, `domain/hiddenBlocks.test.ts`, `real/homePage.test.tsx` («personalizzare dall'app non cancella un blocco di un'area non integrata né un kind sconosciuto») |

## Catalogo dei blocchi

| Voce | Dove vive (renderer) | Rotta | Test |
|---|---|---|---|
| Le mie task, Lavoro di Claude per me (stato letto dalla vista), Ferme nei miei progetti, Traguardi in arrivo | `pages/home/blocks/{MyTasksBlock,ClaudeForMeBlock,StalledBlock,MilestonesBlock}.tsx` | `GET /api/tasks`, `GET /api/tasks/stalled`, `GET /api/milestones` | `real/homePage.test.tsx`, `pages/ComingSoon.test.tsx` |
| Richieste nuove | `NewRequestsBlock.tsx`; `real/requests.ts` (`listRequestsToConvert`) | `GET /api/requests/to-convert` | `real/requests.test.ts`; server `requests.test.ts` |
| Un filtro salvato come blocco; eliminato o reso privato resta «non disponibile» | `FilterBlock.tsx` (`GoneFilter`); `real/filters.ts` (`getSavedFilter`: 404 → `null`) | `GET /api/filters/:id` | `real/homePage.test.tsx` («…il filtro eliminato è «non disponibile»…»); server `home.test.ts` («un filtro eliminato dopo resta nella Home come blocco…») |
| Blocchi di aree non integrate (eventi e posta, automazioni, rilasci, assistenza) fuori dal catalogo e dalle Home, senza letture; anche l'extra «Releases» | `pages/home/blocks/registry.ts` (`ofArea`), `data/queries.ts` (`useHome`, `useAutomations`) | — | `pages/ComingSoon.test.tsx` («i blocchi delle aree non integrate…», «un blocco di un'area non integrata salvato nella Home personale…», «il catalogo dei blocchi non propone…») |

## «Da decidere»

| Voce | Dove vive (renderer) | Rotta | Test |
|---|---|---|---|
| Richieste di decisione rivolte a me (fetta 1) | `DecideBlock.tsx` | `GET /api/decisions` | `DecideBlock.test.tsx` (prototipo), `pages/ComingSoon.test.tsx` |
| Richieste da trasformare: codice, titolo, «Turn into task»; il titolo apre la voce nel web vecchio | `DecideBlock.tsx` (`RequestItem`, `openInWeb`); `real/requests.ts` (`listRequestsToConvert`, `convertRequest`) | `GET /api/requests/to-convert`, `POST /api/tasks` (`requestId`) | `real/requests.test.ts`, `real/homePage.test.tsx` (««Da decidere»: una richiesta da trasformare si apre nel web») |
| Voci di Claude, chat, posta e automazioni spente (e il blocco non resta in caricamento) | `DecideBlock.tsx` (sorgenti per area), `data/queries.ts` (`useClaudeDecisions`, `useChatQuestions`, `useChatClaudeQuestions`) | — | `pages/ComingSoon.test.tsx` (««Da decidere» non legge Claude, chat, posta né automazioni…») |

## Ruoli di reparto

| Voce | Dove vive (renderer) | Rotta | Test |
|---|---|---|---|
| Chi dispone la Home di un reparto (`department.home.manage`), dalla pagina Reparti | `pages/admin/DepartmentPanel.tsx`, `DepartmentsPage.tsx` (`featureIntegrated("department-home")`); `real/departments.ts` (`listDepartments`, `saveDepartment`) | `GET /api/departments/roles`, `PUT /api/departments/:id/roles` | `real/departments.test.ts` («i responsabili della Home vengono dai ruoli…», «salvare il pannello… poi i responsabili della Home…»); server `departments.test.ts` |
| Ruoli di reparto di una persona | `real/home.ts` (`listDepartmentRoles`) | `GET /api/departments/roles` | `real/home.test.ts` |
| Permessi di reparto di chi guarda | `real/session.ts` (`getViewer`: `departmentPermissions`) | `GET /api/auth/me` | `real/session.test.ts`; server `home.test.ts` («li assegna chi ha departments.manage, senza riconferma…») |

## Filtri salvati

| Voce | Dove vive (renderer) | Rotta | Test |
|---|---|---|---|
| «Tutti i filtri»: i miei e i pubblici (con i cinque di esempio) | `pages/filters/AllFiltersPage.tsx`; `real/filters.ts` (`listSavedFilters`) | `GET /api/filters` | `AllFiltersPage.test.tsx`, `real/filters.test.ts`, `pages/ComingSoon.test.tsx`; server `filters.test.ts` («l'elenco ha i miei e i pubblici…») |
| Pagina del filtro: le task, vista e raggruppamento salvati; un privato d'altri non si vede | `FilterPage.tsx`; `real/filters.ts` (`getSavedFilter`) | `GET /api/filters/:id`, `GET /api/tasks` | `FilterPage.test.tsx`, `real/filters.test.ts`; server `filters.test.ts`, `tasks.filter-parity.test.ts` |
| «Salva come filtro» dalla barra di Tasks; modifica ed eliminazione | `SaveFilterDialog.tsx`, `pages/tasks/TasksPage.tsx`; `real/filters.ts` (`saveFilter`, `updateFilter`, `deleteFilter`) | `POST /api/filters`, `PATCH /api/filters/:id`, `DELETE /api/filters/:id` | `SaveFilterDialog.test.tsx`, `real/filters.test.ts`; server `filters.test.ts` |
| Chi modifica ed elimina un filtro lo dice il server (`canEdit`) | `FilterPage.tsx` (`canManageFilter`) | `GET /api/filters[/:id]` (`canEdit`) | `pages/filters/canManageFilter.test.ts` |
| Fissati nella colonna | `layout/PersonalColumn.tsx`; `real/filters.ts` (`listPinnedFilterIds`, `setFilterPinned`) | `GET /api/me/pinned-filters`, `PUT`/`DELETE /api/me/pinned-filters/:id` | `real/filters.test.ts`, `FilterPage.test.tsx`; server `filters.test.ts` («fissati: personali e in ordine…») |
| Un filtro pubblico mostra a ciascuno solo le task che vede già, anche nel conteggio | (lettura con `listTasks(criteria)`) | `GET /api/tasks` | server `filters.test.ts` («un filtro pubblico mostra a ciascuno solo le task che vede già…») |
| Stessi risultati del prototipo sui periodi (`matches` ↔ `/api/tasks`) | `domain/filters.ts` (`matches`, del finto) | `GET /api/tasks?period…` | server `tasks.filter-parity.test.ts` |

## Rimandate

| Voce | Fetta |
|---|---|
| Requests (elenco, dettaglio, metadati, fusione, rifinitura): oggi una richiesta si apre nel web vecchio | 4 |
| Overview, gestione dei traguardi, Tutti i progetti | 4 |
| Blocchi di eventi e posta (area 6), automazioni (area 7), rilasci e assistenza (area 8) | aree 6–8 |
| Voci di Claude e della chat in «Da decidere» | area 3 |
| Permessi di progetto dati da un reparto (`department-permissions`) | non previsti dal server |

## Scelte e limiti

| Scelta o limite | Chi ha deciso |
|---|---|
| I filtri stanno in una tabella nuova (`task_filters`, `pinned_task_filters`), si parte da zero; le viste salvate del web vecchio restano intatte | maintainer |
| I cinque filtri pubblici di esempio li crea la migrazione, di nessuno (`owner_id` null): li modifica solo un full admin, e nell'app si vedono come «Public», senza autore | maintainer |
| I ruoli di reparto si assegnano senza riconferma; il registro delle modifiche per ora è solo una riga di log | maintainer |
| La Home d'apertura dei reparti esistenti: «Da decidere», «La mia settimana», «Le mie task», «Lavoro di Claude per me», «Ferme nei miei progetti» | orchestratrice |
| Il server normalizza i blocchi (fissi sempre presenti, niente doppi) e risponde con la Home già risolta | orchestratrice (design) |
| Un filtro eliminato o reso privato resta nella Home come blocco «non disponibile» | orchestratrice (design) |
| Un tipo di blocco sconosciuto non si mostra; un blocco di un'area non integrata non si mostra né si elenca nell'editor. Salvando la Home (personale o di reparto) tornano entrambi al loro posto relativo, o in coda (`withHiddenBlocks`): si tolgono solo con «Ripristina» | orchestratrice |
| `department-home` integrato (chi dispone la Home), `department-permissions` spento | orchestratrice |
| I blocchi delle aree non integrate si escludono con `ofArea` nel registro: un controllo solo per catalogo, Home e novità | costruttore |
| Dopo il login si atterra di nuovo sulla Home | maintainer |
| I criteri arrivano come record e si normalizzano con `parseCriteria`: un criterio sconosciuto si scarta | orchestratrice |
| Chi non ha `backlog.view_all` (un Contributor) vede fra le richieste da trasformare solo le sue: nel prototipo le vede tutte chi può creare task | orchestratrice |
| Il codice R<n> delle richieste è derivato dal server (posizione per data di creazione); diventa un numero vero nella fetta 4, con gli stessi valori | orchestratrice |
| L'urgenza «urgent» del server si mostra «high»; una richiesta senza stima si legge «medium» | costruttore |
| «Turn into task» crea la task con `POST /api/tasks` e `requestId` (i campi del dialogo); finché il server non segna la voce `converted` in quel percorso, la richiesta resta fra quelle da trasformare | da decidere (segnalato all'orchestratrice) |
| Le Home dei reparti si leggono una per reparto (`GET /api/departments/:id/home`), così l'editor ha anche quelle dei reparti che non sono miei | costruttore |

## Da provare a mano

- Personalizza la Home col mouse e con la tastiera: aggiungi, nascondi, riordina, ripristina.
- La Home di un reparto disposta da chi la gestisce, e da un full admin; un filtro privato rifiutato.
- «Vedi le novità» dopo che la Home del reparto è cambiata.
- «Salva come filtro» dalla barra di Tasks, poi modifica ed eliminazione.
- Un filtro come blocco della Home, e lo stesso filtro dopo averlo eliminato.
- Fissare e togliere un filtro nella colonna.
- «Turn into task» da «Da decidere»: la task nasce collegata e la richiesta esce dall'elenco.
