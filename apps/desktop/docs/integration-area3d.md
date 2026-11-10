# Integrazione area 3, fetta 3d «Activity per persona» — parità col prototipo (10 nov 2026)

La scheda «By person» di Activity (Tutti i progetti) nella **build app**, sullo
standup aggregato dal server (decisione del maintainer). Piano:
`docs/plans/2026-11-10-integrazione-area3bcde-plan.md` (3d.2).

| Voce | Dove vive (renderer) | Rotta | Test |
|---|---|---|---|
| La scheda c'è con il permesso d'istanza `people.activity.view`, che ora sta nel registro vero (`@stubwise/shared`) e arriva da `/api/auth/me`; tolto da `LocalInstancePermission` | `pages/projects/AllProjectsPage.tsx`; `data/types.ts`, `data/access/catalog.ts` | `GET /api/auth/me` | `real/peopleActivityPage.test.tsx` |
| La rassegna del giorno per persona (task chiuse e spostate, commenti, decisioni, richieste, commit), filtrabile per reparto | `pages/projects/PeopleActivity.tsx`; `real/peopleActivity.ts` (`listPeopleActivity`) | `GET /api/people/activity?date=&departmentId=` (403 senza permesso) | `real/peopleActivity.test.ts`, `real/peopleActivityPage.test.tsx` |
| I commit di autori non collegati, col nome dell'autore | `PeopleActivity.tsx` | come sopra (`personId: null`) | `real/peopleActivityPage.test.tsx` |
| Il report giornaliero del progetto: fatto (la sintesi), fallito, non ancora; i commit arrivati dopo | `PeopleActivity.tsx`; `listDailyReports` | `GET /api/activity?date=` (`staleCommitCount`, campo nuovo dello schema condiviso con default 0) | `real/peopleActivity.test.ts`, `packages/shared/src/schemas/activity.test.ts` |

## Scelte e limiti

| Scelta o limite | Chi ha deciso |
|---|---|
| `tasksDeleted` sempre vuoto (il server non tiene le task eliminate), `viaClaude` sempre falso, i commit legati alla persona per email | server |
| «Generate report» per progetto spento (`daily-report-generate`): il server rigenera i report di tutti i progetti insieme (`POST /api/activity/generate`, `settings.manage`) | costruttore |
| «Link a person» per un autore di commit spento (`commit-author-link`): non c'è ancora una rotta | costruttore |
| Un report in coda o in scrittura non si mostra come report (la riga dice «non generato»); il server non dice quando è stato scritto (`generatedAt: null`) | costruttore |
