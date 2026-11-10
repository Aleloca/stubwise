# Integrazione area 2, fetta 4 — parità col prototipo (10 nov 2026)

Cosa della `area2-parity.md` funziona sul server vero nella **build app**
(desktop e `/app`) con la fetta 4: Requests coi codici R<n>, Overview,
gestione dei traguardi, Tutti i progetti e Nuovo progetto con modelli e moduli.
Con questa fetta l'**area 2 è completa** (in fondo, cosa resta «in arrivo» e di
quale area è). Design: `docs/plans/2026-11-09-integrazione-area2-fetta4-design.md`;
piano: `docs/plans/2026-11-09-integrazione-area2-fetta4-plan.md`. Le fette
precedenti: `integration-slice{1,2,3}.md`.

Le convenzioni sono quelle delle fette precedenti:
- i percorsi del renderer sono relativi a `apps/desktop/src/renderer/`;
- «real/» è `data/backend/real/`, l'implementazione vera dietro `@backend/api`;
- le rotte sono di `apps/server/src/routes/`.

Il prototipo resta com'era. Regole pure nuove in `@stubwise/shared`
(`tasks/{templates,project-code,requests,request-next-step,decision-log,pulse}.ts`),
riesportate da `domain/`. Migrazioni: `0118_project_templates.sql`,
`0121_request_numbers.sql` (e, per le correzioni della fetta 2,
`0119_day_arrangements_effective_week.sql`, `0120_tickets_week_index.sql`).
I test «app» montano l'implementazione vera davanti a un server finto
(`real/fakeServer.ts`); quelli delle superfici stanno in `pages/ComingSoon.test.tsx`.

## Requests

| Voce | Dove vive (renderer) | Rotta | Test |
|---|---|---|---|
| Elenco delle richieste di progetto coi codici R<n>, filtri | `pages/requests/RequestsPage.tsx`; `real/requests.ts` (`listRequests`) | `GET /api/requests?projectId=` | `RequestsPage.test.tsx` (prototipo), `real/requests.test.ts`, `real/requestsPage.test.tsx`; server `project-requests.test.ts` |
| Dettaglio a pannello (richiedenti, simili, task nate, metadati), per id e per codice | `RequestDetail.tsx`; `real/requests.ts` (`getRequest`, `getRequestByCode`) | `GET /api/requests/:id`, `GET /api/requests/by-code/:code` (404 per una invisibile) | `RequestDetail.test.tsx`, `real/requests.test.ts`, `real/requestsPage.test.tsx` |
| Urgenza «urgent» del server: si mostra «Urgent» al livello più alto, senza perdere il dato | `pages/requests/marks.tsx` (`UrgencyMark`, `urgent`) | vista `urgency` + `urgent` | `pages/requests/marks.test.tsx`, `real/requestsPage.test.tsx` |
| Nuova richiesta: passa dall'intake; se fusa in una esistente l'app dice «Unita a R12» e apre quella | `NewRequestDialog.tsx` (attesa, `sentMerged`); `real/requests.ts` (`createRequest`: job, `landedByMerge`) | `POST /api/requests` (202 `{jobId}`), `GET /api/requests/jobs/:jobId` | `real/requests.test.ts`, `pages/ComingSoon.test.tsx` («una richiesta fusa dall'intake…»); server `project-requests.test.ts` |
| Titolo, descrizione e metadati (urgenza, taglia, rischio e nota), suggerimenti dell'intake da accettare o scartare | `RequestDetail.tsx`, `RequestGuidance.tsx`; `real/requests.ts` (`updateRequest`) | `PATCH /api/requests/:id` (409 `request_read_only`), `POST /api/requests/:id/suggestions/{accept,dismiss}` | `real/requests.test.ts`; server `project-requests.test.ts` |
| «Fondi in…», con la riscrittura AI: attesa, e un errore con «Try again» che non ha cambiato nulla | `MergeDialog.tsx`; `real/requests.ts` (`mergeRequest`) | `POST /api/requests/:id/merge` (502 `merge_failed`) | `real/requests.test.ts`, `pages/ComingSoon.test.tsx` («Fondi in…: l'attesa della riscrittura…»); server `project-requests.test.ts` |
| Archivia, Riapri, Ripristina | `RequestDetail.tsx`; `real/requests.ts` | `POST /api/requests/:id/{archive,reopen,restore}` | `real/requests.test.ts` |
| Trasforma in task (dal dettaglio, da «Da decidere», dal blocco «Richieste nuove») | `pages/task/NewTaskDialog.tsx`; `real/requests.ts` (`convertRequest`) | `POST /api/tasks` con `requestId` (la voce diventa converted; 409 su una converted/archived, 400 `request_not_found` su una che non vedo) | `real/requests.test.ts`, `pages/ComingSoon.test.tsx` («trasformare una richiesta che non vedi più…»); server `tasks.convert.test.ts` |
| Esporta in Markdown | `RequestDetail.tsx`, `domain/export.ts` | (letture sopra) | `domain/export.test.ts` |

## Overview

| Voce | Dove vive (renderer) | Rotta | Test |
|---|---|---|---|
| Un progetto atterra sull'Overview | `router.tsx` (`landingSection`), `data/integration.ts` | — | `pages/ComingSoon.test.tsx` («aprire un progetto atterra sull'Overview») |
| A che punto è: traguardi con avanzamento in taglie, chiuse nelle ultime due settimane | `pages/overview/ProgressSection.tsx` (`progress` condiviso) | `GET /api/tasks`, `GET /api/milestones` | `OverviewPage.test.tsx` (prototipo), `pages/ComingSoon.test.tsx` |
| Brief settimanale, etichettato come testo generato | `BriefCard.tsx`; `real/overview.ts` (`getLatestBrief`) | `GET /api/projects/:id/briefs/latest` (`tickets.view_all`) | `real/overview.test.ts`; server `projects.chronology.test.ts` |
| Cosa è aperto (per famiglia e persona), cosa è fermo (in cima, dal più vecchio) | `OpenSection.tsx`, `StalledSection.tsx` | `GET /api/tasks`, `GET /api/tasks/stalled` | `OverviewPage.test.tsx` |
| Cronologia a pagine di 28 giorni, coi traguardi futuri nella prima; «Show earlier» chiede la pagina prima | `ProjectTimeline.tsx`; `data/queries.ts` (`useTimeline`, a pagine); `real/overview.ts` (`listTimelinePage`) | `GET /api/projects/:id/chronology?before=` | `real/overview.test.ts`, `real/overviewPage.test.tsx`; server `projects.chronology.test.ts` |
| Registro decisioni: lettura, registrazione a mano, «superata da» (un ciclo è rifiutato) | `DecisionLog.tsx`; `real/overview.ts` (`listDecisionLog`, `recordDecision`, `setDecisionSuperseded`) | `GET`/`POST /api/projects/:id/decisions` (`supersedesId`, 400 `invalid_supersede`), `PATCH …/:decisionId` (400 `decision_cycle`) | `real/overview.test.ts`; server `projects.decisions-chain.test.ts`, `packages/shared/src/tasks/decision-log.test.ts` |
| Polso del progetto (aperte, ferme, «aspetta te», prossimo traguardo) | `PulseText.tsx`, `pulseLine.ts`; `real/overview.ts` (`projectPulse` con `pulseOf` condiviso) | letture sopra, `GET /api/requests/to-convert`, `GET /api/decisions` | `real/overview.test.ts`, `packages/shared/src/tasks/pulse.test.ts` |

## Traguardi

| Voce | Dove vive (renderer) | Rotta | Test |
|---|---|---|---|
| Crea, modifica, chiudi/riapri, elimina (le task restano, senza traguardo) | `pages/overview/MilestonesDialog.tsx`; `real/milestones.ts` | `POST /api/milestones`, `PATCH /api/milestones/:id` (`status`), `DELETE /api/milestones/:id` | `real/overview.test.ts` («i traguardi dal server»); server `milestones.test.ts` |

## Tutti i progetti

| Voce | Dove vive (renderer) | Rotta | Test |
|---|---|---|---|
| Portafoglio col polso, filtri, fissa/sgancia | `pages/projects/AllProjectsPage.tsx`, `portfolio.ts`; `real/overview.ts` (`listProjectPulses`) | `GET /api/projects`, `GET /api/me/follows` | `AllProjectsPage.test.tsx`, `pages/ComingSoon.test.tsx` («Tutti i progetti è disponibile») |
| Ferme trasversali | `PortfolioStalled.tsx` | `GET /api/tasks/stalled` | `AllProjectsPage.test.tsx` |
| Attività trasversale per giorno, a pagine | `ActivityFeed.tsx`; `data/queries.ts` (`usePortfolioActivity`); `real/overview.ts` (`listPortfolioActivityPage`) | `GET /api/activity/portfolio?before=` | `real/overview.test.ts` |
| Nuovo progetto: codice, interno/commessa, cliente, modello (stati iniziali e moduli); un codice già usato non crea niente | `NewProjectDialog.tsx`; `real/projects.ts` (`createProject`) | `POST /api/projects` (409 `code_taken`) | `real/projects.test.ts`; server `projects.templates.test.ts`, `packages/shared/src/tasks/project-code.test.ts` |
| Moduli dei progetti: Docs, Releases, Support e Servers seguono i moduli del server | `layout/ProjectColumn.tsx`, `data/routes.ts`; `real/projects.ts` (`toProject`) | `GET /api/projects` (`template`, `modules`, `clientName`, `kind`) | `real/projects.test.ts` |

## Rimandate

| Voce | Area |
|---|---|
| «Rifinisci con Claude» (bottone spento, `?refine=1` resta il dettaglio) | 3 |
| Attività «By person» (standup per sviluppatore) | 3 |
| Canale «general» creato col progetto | 4 (Chat) |
| Origine di una richiesta da Support | 8 |
| Origine di una richiesta dalla documentazione di prodotto | 11 |
| Task eliminate nella cronologia | 10 |
| Archiviati, interruttori di brief e report | 9 (9c) |
| Pausa della coda e lavoro di Claude fermo | 9 (9b) |

## Scelte e limiti

| Scelta o limite | Chi ha deciso |
|---|---|
| L'intake resta anche nell'app: una richiesta nuova può essere fusa da sola in una esistente, e l'app lo dice («Unita a R12») aprendo quella | maintainer |
| «Fondi in…» con la riscrittura AI della destinazione; se il modello non risponde, 502 `merge_failed`, niente cambia, l'app offre «Try again» | maintainer (502: server) |
| I progetti esistenti sono Software con tutti e quattro i moduli, interni; da un server più vecchio l'app li legge così | maintainer |
| Cronologia e attività a pagine di 28 giorni; «Show earlier» scopre le settimane lette e poi chiede la pagina prima | maintainer |
| Codici R<n>: un contatore per progetto assegnato da un trigger, le voci esistenti numerate per data di creazione comprese fuse e archiviate, mai riusati | server |
| Chi non ha `backlog.view_all` (un Contributor) vede solo le richieste sue | server |
| Urgenza «urgent» mostrata come «Urgent» al livello più alto; l'app non la scrive | orchestratrice |
| Sforzo E1–E5 della voce → taglia XS–XL con la mappa delle task | orchestratrice |
| Il polso del portafoglio e «fermo» come nel prototipo, calcolati nel renderer con `pulseOf` condiviso; `/api/projects/pulse` resta del web vecchio e del mobile | orchestratrice |
| Claude non entra nel polso («aspetta te», «al lavoro») finché l'area 3 non è integrata | costruttore |
| «Nuova richiesta» aspetta l'intake per circa un minuto (un controllo ogni 400 ms); oltre, è un errore e si riprova | costruttore |
| «Accetta» i suggerimenti quando la patch porta esattamente i valori suggeriti (come la scrive il pannello), «Scarta» quando chiude i suggerimenti e basta | costruttore |
| Nel prototipo cronologia e attività sono una pagina sola (`nextBefore` null): non cambia nulla | costruttore |

## Area 2 completa

Con la fetta 4 tutte le voci di `area2-parity.md` funzionano sul server vero
nella build app. Resta «in arrivo» ciò che appartiene alle altre aree:

| In arrivo | Area |
|---|---|
| Claude: destinazione, assegnare a Claude, sezione Claude del pannello con le azioni, domande e piani in «Da decidere», sessione dal vivo, refinement delle richieste, attività per sviluppatore | 3 |
| Chat (canali, thread, domande della Chat in «Da decidere») | 4 |
| Docs del progetto e Drive | 5 |
| Posta e Calendario (e i loro blocchi della Home) | 6 |
| Automazioni (e il loro blocco della Home) | 7 |
| Rilasci, ambienti, avvisi, Support e clienti in attesa; Servers | 8 |
| Preferenze, persone e accessi, istanza, le altre impostazioni di progetto, archiviati, interruttori, pausa della coda | 9 |
| Azioni di Claude sul catalogo, task eliminate | 10 |
| Documentazione di prodotto | 11 |
| Permessi di progetto dati da un reparto | non previsti dal server |

## Da provare a mano

- Nuova richiesta che l'intake fonde in una esistente: «Unita a R…» e si apre quella; una richiesta nuova resta nuova.
- «Fondi in…» con l'attesa della riscrittura; con il modello spento, l'errore e «Try again».
- Una richiesta «urgent» del web vecchio nell'elenco e nel dettaglio.
- Trasformare una richiesta in task dal dettaglio e da «Da decidere»: la voce diventa trasformata ed esce dagli elenchi da trasformare.
- Archivia, Riapri, Ripristina; i metadati e i suggerimenti dell'intake.
- Overview: traguardi (crea, chiudi, riapri, elimina), registro decisioni con «superata da», brief, cronologia con «Show earlier» oltre le quattro settimane.
- Tutti i progetti: polso, ferme, attività con «Show earlier»; Nuovo progetto con un codice già usato e con un modello «Client».
