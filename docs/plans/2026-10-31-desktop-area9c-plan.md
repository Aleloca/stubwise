# App desktop, area 9c: impostazioni del progetto, archivia ed elimina — piano di implementazione

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Costruire nel prototipo `apps/desktop` la terza parte dell'area 9,
Progetto → Settings:
- le sezioni nuove General, AI, Automations, Integration, Plugins, Usage e
  Archive, accanto a Statuses, Members, Repositories e Change log;
- Repositories completa: creazione guidata, modifica, webhook, file
  d'ambiente;
- archiviare, riaprire ed eliminare un progetto;
- gli **effetti visibili** di queste impostazioni nelle altre aree.

**Architecture:**
- **Lo stato delle impostazioni di progetto** è una parte nuova dello store,
  `projectSettings` (`data/projectSettings/state.ts`), una riga per progetto.
  Restano sul `Project` solo i fatti che `store.ts` legge per la visibilità e
  i campi che esistono già: `description`, `archived`, `correctionCap`. I
  campi nuovi del repository stanno sul `Repository`; i file d'ambiente in
  `state.envFiles`.
- **Le scritture** seguono l'ordine di `data/admin/common.ts`:
  `not_found` → `forbidden` → `invalid` → `busy`/`conflict` →
  `reauth_required` → scrittura + voce del registro. Rispondono
  `ProjectResult<T>`, cioè `InstanceResult` del 9b più `busy`.
- **Un progetto archiviato esce da `visibleProjectIds`** (`data/store.ts`),
  anche per i full admin e per Claude. Le ~120 letture che già passano da lì
  lo nascondono da sole: binario, All projects, ⌘K, Home, notifiche, «Who
  can?», consumi, Stato dell'istanza. Chi lo vede da archiviato ha una
  seconda funzione, `archivedProjectIdsFor`, letta solo dalle viste
  dell'archivio e dal registro. Una scrittura su un progetto archiviato
  trova `not_found`, come su uno che non c'è: nessun lavoro nuovo parte, e
  non serve un controllo per ogni scrittura.
- **Gli effetti** passano da poche funzioni del livello dati, che le altre
  aree chiamano:
  - `projectSwitchOn(projectId, sw)` (gli interruttori, falsi su un
    archiviato);
  - `pickProvider(projectId)` (l'account del progetto);
  - `skillsForRun(projectId)` (i plugin);
  - `capOf` (esiste già).
- **I tre meccanismi del 9a e del 9b si riusano senza toccarli:**
  - il registro (`registerChangeTypes`);
  - la riconferma (`REAUTH_REQUIRED`);
  - il caveau (`data/admin/secrets.ts`): due kind generati, la chiave
    d'ingestione e il secret del webhook git, e un kind scritto, il valore
    d'ambiente.

**Tech Stack:** quello delle aree 1–9b, senza dipendenze nuove.

**Spec:** `docs/plans/2026-10-29-desktop-area9-admin-design.md` (approvato
il 29 ott 2026). Di quel documento valgono:
- tutto ciò che «Tre piani» assegna a 9c;
- «Il principio», «Anti-obiettivi», «Invarianti del CLAUDE.md che quest'area
  tocca»;
- «Il registro delle modifiche» (voci di 9c);
- «Impostazioni del progetto (9c)», tutta;
- «Permessi»;
- «Quanto è vero nel prototipo»: interruttori, account AI preferito, tetto
  alle correzioni, plugin, progetto archiviato;
- «Dati finti»: il progetto archiviato;
- «Parità con il web», D;
- «Review Focus» 2 e 4.

Contesto da leggere:
- `apps/desktop/docs/area9-inventory.md`, sezione D: è il perimetro;
- `apps/desktop/docs/area9-parity.md` («Voci D: rimandate al 9c»);
- `apps/desktop/docs/ossatura-follow-ups.md`:
  - «Area 9a — minori aperti»: «View only» su Settings (Task 10 Minor 2);
  - «Area 9b — minori aperti»: Ruling T3 (valori stabili nel registro),
    T7 I1 (progetto salvato come id e risolto a lettura), T10 (`gcTime: 0`);
  - le invarianti §6–§10;
- «Plugin e skill dell'agente» in `CLAUDE.md` (sottrazione, preset
  consigliato chiavato sul `name` del manifest, `stubwise-base` mai filtrato,
  il limite «una persona per volta») e «Solo l'ambiente `test` entra in un
  worktree»;
- sul web:
  - `apps/web/src/routes/projects/$projectId.tsx`;
  - `apps/web/src/components/{project-form,repository-wizard,repository-form,webhook-config-panel,integration-panel,project-env-files-section,project-plugins-section}.tsx`;
  - `apps/web/src/routes/repositories/$slug.tsx`;
- nel desktop: `pages/settings/*`, `data/adminSections.ts`, `data/routes.ts`
  (`PROJECT_SETTINGS_SECTIONS`), `data/instance/*`, `data/changelog/*`,
  `data/seed/commands.ts` (`PROJECT_PLUGINS`, `commandsFor`),
  `pages/admin/ai/UsagePanel.tsx`;
- `apps/desktop/DESIGN.md`.

## Global Constraints

- **Valgono tutte le Global Constraints delle aree 2–9b:**
  - nessuna rete;
  - en/it con parità;
  - temi;
  - niente monospace, salvo logo, codice, log, comandi, script, token,
    chiavi, URL e percorsi di file;
  - colore mai unico segnale;
  - movimento 150–250 ms, con reduced-motion;
  - pagine solo via `data/queries.ts` (e `data/queries/*`);
  - stati completi: caricamento, vuoto, errore con «Riprova», pieno, senza
    permessi;
  - orologio `now()` di `data/store.ts`;
  - commenti in italiano.
- **L'app fa tutto quello che fa il sito, e di più** (maintainer). Ogni voce
  D di `area9-inventory.md` che non è «fuori» ha un posto e un test. Fuori:
  regole della posta del progetto, «Rigenera il brief» (e, per tutta l'area,
  Slack e posta ammessa).
- **Le sezioni e i loro permessi** (*scelta del controller*, dal web).
  Una sezione che chi guarda non vede non è nella colonna, e il suo
  indirizzo porta alla prima. Una sezione che vede senza il permesso di
  scrittura si legge in sola lettura, con la frase e il «Who?».

  | Sezione | Si vede con | Si scrive con | «Who?» |
  |---|---|---|---|
  | General | membro del progetto | `project.settings.manage` | `manageProjectSettings` |
  | Statuses | membro | `project.settings.manage` | `manageProjectSettings` |
  | Members | membro | `project.members.manage` | `manageMembers` |
  | AI | membro | `project.settings.manage` | `manageProjectSettings` |
  | Automations | membro | `project.settings.manage` | `manageProjectSettings` |
  | Repositories | `repos.view` | `repos.manage`; i file d'ambiente si vedono **solo** con `repos.manage`, come sul web | `manageRepos` |
  | Integration | membro | rigenerare la chiave: `project.settings.manage`; il secret del webhook git: `repos.manage` | i due |
  | Plugins | membro | `project.settings.manage` | `manageProjectSettings` |
  | Usage | `project.usage.view` | — | — |
  | Change log | `project.settings.manage` o `project.members.manage` (9a) | — | — |
  | Archive | membro | Archive e Reopen: `project.settings.manage`; Delete: full admin | `manageProjectSettings`, `deleteProjects` |

  Repositories non dipende più dal modulo Releases (*scelta del
  controller*): i repository servono anche ai Docs. Le parti dell'8a (modo
  delle PR dei colleghi, pipeline e ramo di rilascio) restano solo col
  modulo.
- **«View only»** per chi gestisce i membri e non le impostazioni (follow-up
  9a, Task 10 Minor 2): la forma la fissa lo shape `project-settings.md`.
  Il livello dati dice per ogni sezione `{ visible, canEdit, editAction }`
  (`projectSettingsAccess`); colonna, rotta e pagine leggono da lì.
- **Lezioni della 9b, valide per ogni task:**
  - **ogni bottone spento** per permesso ha la sua frase **e** il `WhoCanLink`
    con un'azione di `ACTIONS`; un bottone spento per una regola (un
    progetto non archiviato, il pulse senza discovery backlog) ha la sua
    frase, senza «Who?»;
  - **la pagina non ricalcola regole del livello dati**: niente `can()` nelle
    pagine delle impostazioni, si legge `canEdit` (vale anche per
    `ProjectStatusesSettings.tsx`, che oggi lo calcola: Task 7). Lo stesso
    per busy, «solo su un archiviato», «pulse senza backlog»: li dice il
    livello dati;
  - **il registro salva valori stabili** (`on`/`off`, id dell'account o
    `auto`, numeri, chiavi di campo) e li traduce a lettura
    (`changelog/settingValues.ts`); un nome dato da una persona (un
    repository, un percorso, il nome di una variabile) si salva com'è;
  - **R-G5 ovunque**: nessun nome o codice di un progetto o di una persona
    che chi guarda non vede, in nessuna superficie, registro, notifiche,
    «Who?», conteggi dell'eliminazione e Amministrazione compresi. Un
    progetto archiviato è invisibile a chi non era membro e non è full
    admin; uno eliminato a tutti, salvo nella voce `project.deleted` e nella
    provenienza di un repository senza progetto (`formerProject`), che si
    risolvono a lettura per gli ex membri e il full admin (Task 5);
  - **le mutazioni con un segreto** negli argomenti o nel risultato usano
    `{ secret: true }` (`gcTime: 0`): file d'ambiente, valori, chiave
    d'ingestione, secret del webhook;
  - **a 1024 px il layout segue lo shape**, non si comprime da solo;
  - **gli scatti si rifanno dopo ogni correzione** visiva, prima del commit
    che la chiude;
  - **la UI non afferma cose che il dato non dimostra**: «Nightly Docs are
    off» solo se l'interruttore è spento, «Webhook configured» solo con uno
    stato `configured`, mai «Skills in this run» su una sessione nata prima
    del cambio;
  - **dopo un dialogo aperto da «⋯»** (o da un bottone) il fuoco torna a chi
    l'ha aperto, anche dopo una conferma che cambia la riga.
- **Le impostazioni hanno effetti visibili** (maintainer), e solo questi
  (Task 6):
  - brief settimanale spento;
  - Docs notturni spenti;
  - pulse spento;
  - report giornaliero spento;
  - account AI preferito;
  - tetto alle correzioni;
  - plugin spenti;
  - progetto archiviato.

  La discovery backlog spenta spegne il pulse, come sul web, e nient'altro
  (**confermata dal maintainer il 31 ott 2026**, domanda 3 (a)). Grafo del
  codice, comandi di install e test e rami
  protetti si salvano e basta, come auto-fix e soglie nel 9b.
- **Registro delle modifiche per ogni cambio** (maintainer). Ogni scrittura
  riuscita di questo piano scrive una voce da template i18n; una rifiutata
  no. Entrano anche le scritture di progetto che oggi non scrivono (Task 3):
  - stati e soglia «ferma» (area 2);
  - modo delle PR e pipeline di rilascio (8a);
  - ambienti (8a);
  - widget (8a).
- **+R sulle azioni sensibili** (maintainer). Ogni funzione che crea,
  sostituisce o cancella un segreto, più l'eliminazione del progetto:
  - `projectSettings.regenerateIngestionKey`;
  - `projectSettings.regenerateWebhookSecret`;
  - `projectSettings.importEnvFile`;
  - `projectSettings.setEnvVar`;
  - `projectSettings.removeEnvVar`;
  - `projectSettings.deleteEnvFile`;
  - `projectSettings.deleteProject`;
  - `instance.deleteDetachedRepository` (**confermata dal maintainer il 31
    ott 2026**, domanda 4 (b)).

  Archive e Reopen **non** chiedono la riconferma: si tornano indietro
  (*scelta del controller*). `reauth.test.ts` confronta l'elenco.
- **I segreti si mostrano una sola volta** (design, «Integration» e
  «Repositories»):
  - la chiave d'ingestione e il secret del webhook git escono in `SecretOnce`
    alla rigenerazione; poi solo le ultime 4 cifre;
  - il DSN e lo snippet `init()` si mostrano con la chiave mascherata
    (`••••1a2b`), e «Copy» copia il testo mascherato con la frase che lo
    dice (*scelta del controller*);
  - un valore d'ambiente non ha nemmeno le ultime 4 cifre: si vede il nome,
    «set» e quando (design: «si vede il nome, mai il valore»);
  - nessun segreto entra nel DOM dopo la navigazione, in una lettura, nel
    registro o in una notifica.
- **Solo l'ambiente `test` entra in un worktree** (`CLAUDE.md`). La sezione
  dei file d'ambiente dice in parole che solo i file di `test` arrivano a
  Claude, e nessun altro (come `usedByPipeline` del web).
- **Archiviare invece di eliminare** (maintainer):
  - **Archive** (`project.settings.manage`):
    - il progetto sparisce da binario, All projects, ⌘K, Home e notifiche;
    - le sue automazioni si fermano e non parte lavoro nuovo;
    - è `busy` con una sessione di Claude viva del progetto (anche in
      attesa per la coda in pausa) o un rilascio in corso
      (`releaseStatus` `running`), e il dialogo dice cosa aspettare;
  - **Reopen** lo riporta com'era: gli interruttori non si toccano
    all'archiviazione, quindi tornano quelli di prima;
  - **Delete** solo dal full admin, solo su un archiviato, scrivendo il
    codice e con la riconferma; lascia la voce `project.deleted` nel
    registro d'istanza.
  - **I repository di un progetto eliminato restano senza progetto**
    (**confermata dal maintainer il 31 ott 2026**, domanda 2 (b)):
    - si spostano in `state.detachedRepositories` e compaiono in
      Amministrazione → Repositories nel gruppo «Not in any project»;
    - da lì si collegano a un altro progetto: lo può fare chi ha
      `repos.manage` nel progetto di destinazione, o il full admin;
    - il dialogo di Delete dice quanti repository restano senza progetto;
    - il collegamento scrive la voce `repository.linked`;
    - R-G5: un repository senza progetto dice da quale progetto eliminato
      viene **solo** a chi ne era membro e al full admin. Per gli altri
      quel progetto non c'è, né nella riga né nella voce.
  - **Un repository senza progetto si può eliminare** (**confermata dal
    maintainer il 31 ott 2026**, domanda 4 (b)):
    - solo dal full admin, da Amministrazione → Repositories, con
      conferma in rosso e riconferma (+R);
    - scrive la voce d'istanza `repository.deleted`, che dice la
      provenienza solo agli ex membri e al full admin;
    - l'account git a cui era collegato smette di contarlo «in uso»
      (`deleteGitAccount` non lo rifiuta più per lui);
    - un repository che sta in un progetto resta non eliminabile, come sul
      web.
  - I server rimasti senza progetto seguono R-L7, come prima.
- **Claude** non riceve nessun permesso nuovo: `deleteProjects` è del full
  admin, e Claude non lo è mai (R-L9).
- **Simulazioni** solo nel riquadro «Prototype only» (`PrototypeBox`):
  - verifica degli accessi del repository;
  - configurazione automatica del webhook.
- **Istanza vuota** (9a): `resetToEmptyInstance()` non lascia progetti,
  quindi niente da aggiungere. `emptyInstance.test.tsx` copre le rotte
  nuove (Task 13).
- **Impeccable obbligatorio per la UI**, con gli shape del Task 0 approvati e
  vincolanti, e la revisione visiva di Impeccable dopo l'ultimo task.
- **Comandi.**
  - Un singolo file di test: `pnpm --filter @stubwise/desktop test --
    <file>`.
  - Prima di ogni commit: la suite desktop (`pnpm --filter @stubwise/desktop
    test`), `pnpm --filter @stubwise/desktop typecheck` e `pnpm lint` dalla
    radice. Alla fine anche `pnpm --filter "@stubwise/desktop..." build`.
  - Commit `feat(desktop): …` / `fix(desktop): …` in italiano, con i trailer
    `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` e
    `Claude-Session: https://claude.ai/code/session_01C9DcEFDJAasjVWKkutyVLm`.
  - Verifica UI: `pnpm --filter @stubwise/desktop preview:web` +
    `apps/desktop/scripts/capture.mjs`, a 1440 e 1024, chiaro e scuro, en e
    it, scatti `a9c-*`.
  - Uccidere vite alla fine. Mai `pkill` su vitest.

## Review Focus

1. **Un progetto archiviato che riappare.** Dopo `archiveProject(RNC)` (e
   per il seme, che lo ha già archiviato), RNC non compare per codice, nome
   o link in:
   - binario e fissati;
   - All projects (fuori dalla scheda «Archived»);
   - ⌘K;
   - Home e La mia settimana;
   - notifiche;
   - «Who can?» (scelta del progetto e persone);
   - Usage d'istanza, Stato dell'istanza, Repositories d'istanza;
   - i filtri del registro d'Amministrazione;
   - le automazioni generali;
   - l'elenco dei progetti di Claude.

   Dopo `reopenProject` le stesse superfici lo rimostrano, notifiche
   comprese. → Task 5, 6, 11.
2. **Un segreto nel DOM o nel registro.** Dopo la rigenerazione della chiave
   d'ingestione o del secret del webhook, e dopo `setEnvVar`/`importEnvFile`,
   nessuno di questi contiene il valore (`__secretValuesForTest()`):
   - la serializzazione di ogni lettura di `api.projectSettings`;
   - quella di `api.changelog` e delle notifiche;
   - il DOM dopo la navigazione.

   DSN e snippet restano mascherati. → Task 4, 9.
3. **R-G5 sull'archivio e sull'eliminazione.**
   - Sara, che non era membro di RNC, non trova RNC nella scheda
     «Archived», in `getArchivedProject("RNC")` (`null`, come uno
     inesistente), nel registro, né per `project.deleted`.
   - Chi ha `changelog.view` senza essere stato membro legge
     `project.deleted` come «a project you couldn't see».
   - Un server rimasto solo in progetti archiviati si legge in
     Amministrazione → Servers senza nome di progetto.
   - Un repository rimasto senza progetto dopo Delete: Laura (che non era
     membro di RNC, con `repos.manage` in ACQ) lo vede in «Not in any
     project» senza «RNC» né «Ronchi», in nessuna lettura, voce o DOM;
     Giulia (ex membro) e Roberta leggono «from RNC».

   → Task 5, 11, 12.
4. **Archivia ed elimina ai bordi.**
   - `busy` con una sessione viva **o in attesa** del progetto e con un
     rilascio in corso; una sessione finita non conta.
   - Reopen rimette gli interruttori di prima, compreso uno spento prima
     dell'archiviazione.
   - Delete rifiutato:
     - su un progetto non archiviato;
     - a chi non è full admin;
     - con il codice scritto diverso (minuscole comprese: il codice si
       confronta esatto);
     - senza riconferma.
   - Dopo Delete nessuna riga dello stato nomina l'id del progetto, salvo
     il registro, `deletedProjects` e `detachedRepositories[].formerProjectId`.
   - Collegare un repository senza progetto: rifiutato verso un progetto
     archiviato o invisibile (`not_found`), senza `repos.manage` nel
     progetto di destinazione (`forbidden`), con un nome già usato lì
     (`name_taken`); due collegamenti dello stesso repository: il secondo
     trova `not_found`.
   - Eliminare un repository senza progetto (**confermata dal maintainer
     il 31 ott 2026**, domanda 4 (b)): rifiutato a chi non è full admin
     (`forbidden`), senza riconferma (`reauth_required`), su un repository
     già collegato o eliminato (`not_found`); dopo, l'account git lo lascia
     eliminare, e la voce `repository.deleted` non nomina RNC per chi non
     ne era membro.

   → Task 5, 11.
5. **Plugin: un salvataggio che spegne o riaccende in silenzio.** Due
   finestre sulla sezione Plugins: la seconda salva con una versione vecchia
   e riceve `conflict`, senza toccare le scelte della prima.
   - Il preset consigliato è chiavato sul `name` del manifest
     (`superpowers`), non sullo slug.
   - Il plugin base `stubwise` non si può spegnere e resta in «/».
   - Un plugin `failed` del registro non entra nei run.

   → Task 4, 10.

---

### Task 0 (controller): shape di Impeccable

Brief `shape`, approvati dal maintainer, in `apps/desktop/.impeccable/shape/`.
Nessun codice.

- **`project-settings.md`:**
  - la colonna di Settings con le undici sezioni, nell'ordine di
    `PROJECT_SETTINGS_SECTIONS`, e **la forma di «View only»**: un segno sulla
    voce della colonna, nella testata della sezione, o tutte e due. È la
    scelta che il follow-up del 9a rimanda al 9c;
  - General (il codice non si cambia, e lo si dice);
  - AI («Automatic» o un account, «Use only this account», lo stato
    dell'account scelto: spento, al limite, eliminato);
  - Automations (cinque interruttori, i giorni del pulse, il tetto alle
    correzioni con «0 = off»; il pulse spento senza discovery backlog, con
    la frase);
  - Usage (la `UsagePanel` del 9b con il progetto fisso: cosa cade, cioè la
    dimensione «project»);
  - come si dice la sola lettura in ogni sezione, e dove sta il «Who?».
- **`project-repositories.md`:**
  - l'elenco dei repository;
  - la creazione guidata in quattro passi (account git, repository, ramo,
    verifica degli accessi) più i comandi;
  - la modifica dei campi del web e i rami protetti;
  - il webhook con «Configure automatically» e il suo stato;
  - i file d'ambiente per ambiente (import `KEY=value` o `.env`, nome senza
    valore, sostituisci, rimuovi, la frase «only test reaches Claude»);
  - Integration (chiave mascherata, DSN, snippet, webhook in arrivo, webhook
    git per repository, guida SDK, rigenera con `SecretOnce`);
  - a 1024 px: come si impilano i passi della creazione guidata e le righe
    delle variabili.
- **`project-plugins.md`:** i plugin `ready` del registro, skill e gruppi di
  hook per sottrazione, «Apply recommended preset», il plugin base che non si
  spegne, i plugin `failed` o `materializing` (non entrano nei run, e lo si
  dice), il `conflict` («Someone changed these in the meantime»: ricarica
  senza perdere la propria bozza? Lo decide lo shape).
- **`project-archive.md`:**
  - la sezione Archive (archivia con il dialogo e il `busy` in parole;
    riapri; elimina);
  - la scheda «Archived» di All projects;
  - la pagina del progetto archiviato, in sola lettura, con sintesi, membri,
    conteggi, Reopen e Delete (**confermata dal maintainer il 31 ott 2026**,
    domanda 1 (a));
  - il dialogo dell'eliminazione: conteggi, i server e i repository che
    restano senza progetto, il codice da scrivere, poi la riconferma;
  - cosa si legge dopo l'eliminazione (toast, ritorno ad All projects →
    Archived);
  - in Amministrazione → Repositories (shape `admin-instance.md` del 9b, che
    qui si estende): il gruppo «Not in any project», la riga «from RNC» solo
    per chi può saperlo, il dialogo «Link to a project…» con i soli progetti
    dove chi guarda può collegare, e il «Who?» quando non ce n'è nessuno.
- **`project-effects.md`:**
  - le frasi degli effetti: brief spento (BriefCard), Docs notturni spenti
    (DocsHome e note di rilascio), pulse spento (la riga del polso
    nell'Overview), report giornaliero spento (Activity);
  - l'account del progetto nella sezione Claude della task;
  - la riga «Skills in this run» nella sessione;
  - un'automazione generale che punta a un progetto archiviato.

### Task 1: Lo stato delle impostazioni, le sezioni, le voci, i segreti

**Files:**
- Create: `data/projectSettings/{state.ts,types.ts,seed.ts,common.ts,changeTypes.ts,index.ts}`, con il test `data/projectSettings/projectSettings.test.ts`.
- Modify:
  - `data/model.ts`:
    - `Project.description?: string` e
      `Project.archived?: { at: string; byId: string } | null`;
    - i campi nuovi di `Repository` (sotto);
    - il tipo `EnvFile`;
  - `data/store.ts`:
    - `State.projectSettings`, `State.envFiles`, `State.deletedProjects`,
      `State.detachedRepositories`, `freshState`;
    - `visibleProjectIds` salta i progetti con `archived`, per tutti (full
      admin e Claude compresi): RNC nasce archiviato già in questo task;
    - `ApiFnName` con i nomi `projectSettings.*` dei Task 2–5;
  - `data/seed/projects.ts`: il progetto archiviato RNC; le descrizioni;
  - `data/access/seed.ts`: le appartenenze di RNC, se non le prende già da
    `PROJECTS`;
  - `data/admin/secrets.ts`:
    - `GeneratedSecretKind` + `"ingestion_key" | "git_webhook_secret"`;
    - `ProvidedSecretKind` + `"env_value"`;
  - `data/architecture.secrets.test.ts`: importatori ammessi, anche
    `data/projectSettings/*`;
  - `data/auth/reauth.ts` e `reauth.test.ts` (`REAUTH_REQUIRED`);
  - `data/routes.ts` (`PROJECT_SETTINGS_SECTIONS`);
  - `data/adminSections.ts`: `projectSettingsAccess`, con
    `canSeeProjectSettingsSection` che ne diventa un involucro;
  - `layout/ProjectColumn.tsx` e `router.tsx`, che leggono
    `projectSettingsAccess` (niente più regola del modulo su Repositories);
  - `domain/access/actions.ts`: `deleteProjects` e i18n
    `whoCan.actions.deleteProjects`;
  - `data/changelog/types.ts`: `ChangeObjectLink` +
    `{ to: "projectSettings"; code: string; section: ProjectSettingsSection }`;
  - `data/changelog/visibility.ts` (`GROUP_ORDER`);
  - `data/changelog/reads.ts` (`objectLinkOf`) e `pages/admin/ChangeEntry.tsx`:
    il ramo del link nuovo, con un controllo d'esaustività che chiude anche
    il minore T1 del 9b («l'ultimo ramo dà per scontato `server`»);
  - `data/changelog/settingValues.ts`: le forme di 9c;
  - i18n `changelog.kinds.*` e `changelog.groups.{project,repositories,projects}`;
  - `data/api.ts`: `export * as projectSettings from "./projectSettings"`.

**Interfaces, prodotte:**

```ts
// data/projectSettings/state.ts
export const PROJECT_SWITCHES = ["docsNightly", "dailyReport", "backlogDiscovery", "pulse", "weeklyBrief"] as const;
export type ProjectSwitch = (typeof PROJECT_SWITCHES)[number];
export const PULSE_DAYS_MIN = 1;          // come il CHECK del web
export const PULSE_DAYS_MAX = 30;
export const CORRECTION_CAP_MIN = 0;      // 0 = ciclo automatico spento
export const CORRECTION_CAP_MAX = 10;
export interface ProjectPluginChoices {
  /** Cresce a ogni salvataggio: il controllo del «una persona per volta». */
  version: number;
  /** Per sottrazione: ciò che è spento, per `name` del manifest. Assente = tutto acceso. */
  disabled: { plugin: string; skills: string[]; hookGroups: string[] /* "SessionStart#0" */ }[];
}
export interface ProjectSettings {
  projectId: string;
  /** `null` = «Automatic» (la catena dell'istanza). */
  aiProviderId: string | null;
  aiProviderExclusive: boolean;
  switches: Record<ProjectSwitch, boolean>;
  pulseEveryDays: number;
  /** La chiave d'ingestione: solo l'id nel caveau (null nel seme: mai mostrata) e le ultime 4. */
  ingestion: { secretId: string | null; last4: string; createdAt: string };
  plugins: ProjectPluginChoices;
}
// data/model.ts
export interface Repository {
  /* …campi di oggi… */
  url?: string;                                 // https
  installCommand?: string | null;               // null = rilevato dal lockfile
  testCommand?: string | null;                  // null = rilevato
  reviewGitAccountId?: string | null;           // null = il revisore predefinito
  graphEnabled?: boolean;
  protectedBranches?: string[];                 // «release/*» = prefisso
  webhook?: { state: "not_configured" | "configured" | "failed"; configuredAt: string | null; secretId: string | null; last4: string | null };
}
export interface EnvFile { id: string; repositoryId: string; environmentId: string; path: string; vars: { key: string; secretId: string | null; setAt: string }[] }
/**
 * Un repository rimasto senza progetto dopo un Delete (maintainer, 31 ott
 * 2026). Sta fuori da `state.repositories`, così `Repository.projectId` resta
 * `string` e nessuna lettura di progetto lo incontra; collegarlo lo rimette
 * lì col progetto nuovo. `formerProjectId` si risolve a lettura con
 * `deletedProjects` (R-G5).
 */
export interface DetachedRepository { repository: Repository; formerProjectId: string; detachedAt: string; detachedById: string }
// data/projectSettings/types.ts
export type BusyReason =
  | { kind: "claude_session"; code: string | null; title: string; waiting: boolean }
  | { kind: "release"; code: string };
export type ProjectRefusal = InstanceRefusal | { ok: false; error: "busy"; reasons: BusyReason[] };
export type ProjectResult<T extends object = object> = ({ ok: true } & T) | ProjectRefusal;
// data/adminSections.ts
export interface SectionAccess { visible: boolean; canEdit: boolean; /** azione di ACTIONS per il «Who?», null se nessuna */ editAction: string | null }
export function projectSettingsAccess(viewer: Viewer, projectId: string): Record<ProjectSettingsSection, SectionAccess>;
```

- `PROJECT_SETTINGS_SECTIONS` diventa, in quest'ordine: `general`,
  `statuses`, `members`, `ai`, `automations`, `repositories`, `integration`,
  `plugins`, `usage`, `changelog`, `archive`. Le regole di
  `projectSettingsAccess` sono la tabella delle Global Constraints.
  Integration ha due permessi (*ruling del controller*, 31 ott 2026, [PS 4]
  dello shape): `access.integration.canEdit` = `project.settings.manage`
  **oppure** `repos.manage`, perché chi può rigenerare un secret dei webhook
  git non legga «View only»; i singoli bottoni leggono
  `canRegenerateKey` e `gitWebhooks[].canRegenerate` dalla lettura del
  Task 4. Test: una persona con `repos.manage` senza
  `project.settings.manage` ha Integration `canEdit: true` e
  `canRegenerateKey: false`.
- `/p/<CODE>/settings` apre General (*ruling del controller*, 31 ott 2026,
  [PS 2]).
- `ACTIONS` aggiunge `instance("deleteProjects", "instance.full_admin")`. Un
  test prova che «Who can?» su `deleteProjects` elenca solo i full admin.
- `changeTypes.ts` registra **tutti** i tipi dei Task 2–5:
  - gruppo `project` (scope progetto, `project.settings.manage`):
    `project.renamed`, `project.description_changed`,
    `project.ai_account_changed`, `project.switch_changed` (param `switch`),
    `project.pulse_interval_changed`, `project.correction_cap_changed`,
    `project.statuses_changed`, `project.stall_thresholds_changed`,
    `project.plugins_changed`, `project.ingestion_key_regenerated`,
    `project.archived`, `project.reopened`;
  - gruppo `repositories` (scope progetto, `repos.manage`):
    `repository.created`, `repository.updated` (param `field`),
    `repository.pr_mode_changed`, `repository.release_pipeline_changed`,
    `repository.webhook_configured`, `repository.webhook_secret_regenerated`,
    `env_file.created`, `env_file.deleted`, `env_file.imported` (param
    `count`), `env_var.set` (param `key`), `env_var.removed` (param `key`);
    `repository.linked` (nel progetto di **destinazione**; non nomina il
    progetto eliminato da cui viene: R-G5);
    `environment.created`, `.updated`, `.deleted` (`environments.manage`);
    `widget.created`, `.updated`, `.deleted` (`widget.manage`);
  - gruppo `projects` (scope **istanza**): `project.deleted`, con
    `readPermission` `instance.full_admin`, param `detachedRepositories`
    (il numero). Il nome lo risolve il Task 5. E `repository.deleted`
    (**confermata dal maintainer il 31 ott 2026**, domanda 4 (b)), stesso
    gruppo e stessa lettura, col nome del repository com'è e
    `formerProjectId` risolto a lettura come `project.deleted`.

  `GROUP_ORDER` diventa `[…9b, "project", "repositories", "projects"]`. Il
  nome di una variabile d'ambiente entra nella voce (non è un segreto); il
  valore mai.
- Seme (`seed.ts` e `seed/projects.ts`):
  - impostazioni di ogni progetto:
    - i progetti `software`: Docs notturni e report accesi;
    - tutti: discovery backlog acceso, pulse acceso ogni 7 giorni, brief
      acceso;
    - MKX col brief spento; CBV col pulse spento;
    - AUD con l'account «Backup Max» e «Use only this account» (vicino alla
      soglia: l'effetto si vede);
  - descrizioni per STW, AUD, ACQ;
  - repository di STW e AUD con URL, comandi, rami protetti (`main`,
    `release/*`), webhook `configured`; uno di ACQ `not_configured`: ACQ
    oggi non ne ha, quindi nasce `portale-utenti`
    (`audin/portale-utenti`, Bitbucket Audin) (*ruling del controller*, 31
    ott 2026, [RE 9]);
  - STW riceve l'ambiente `test` («Test»), che oggi non ha: ci stanno i
    file `test` qui sotto (*ruling del controller*, 31 ott 2026, [RE 9]);
  - il plugin base `stubwise` vale per tutti i progetti e non sta più fra
    le scelte del seme: `PROJECT_PLUGINS` perde `plg-stubwise`, e con lui
    la skill `start` spenta in AUD (*ruling del controller*, 31 ott 2026);
  - file d'ambiente:
    - per il repository `stubwise`: `test` → `.env` con 3 chiavi,
      `production` → `.env` con 2;
    - ACQ senza file;
    - nessun valore nel caveau (`secretId: null`): come i segreti del seme
      9b, senza import dei segreti da `seed.ts`;
  - **RNC** «Vetrina online Tenuta Ronchi» (cliente «Tenuta Ronchi Srl»,
    template `client`):
    - membri Giulia (Project Lead), Marco ed Elena; Sara e Laura **no**;
    - archiviato da Roberta il giorno −28;
    - 6 task, 2 richieste, una conversazione finita, un canale «general», 3
      file nel Drive;
    - un repository `shop-frontend` (il nome non ricorda il progetto, così
      la prova R-G5 dei repository senza progetto è pulita), con 2 pagine
      dei Docs, un file d'ambiente in `production` e un ambiente
      `production` su un server `SRV-` che non sta in altri progetti;
    - nessun repository senza progetto nel seme: il gruppo «Not in any
      project» nasce dal primo Delete (*scelta del controller*; lo scatto si
      prepara dallo script);
    - le sue notifiche del seme restano, nascoste a lettura.

Test (`projectSettings.test.ts`):
- [ ] Sezioni per persona:
  - Roberta (full admin) vede tutte le undici in ACQ, tutte scrivibili;
  - Laura (Project Lead in ACQ) le vede tutte e scrive tutto tranne Delete;
  - Sara (Contributor in ACQ) non vede Usage né Change log, legge General
    in sola lettura con `editAction: "manageProjectSettings"`;
  - una persona con il solo `project.members.manage` (concessione nel test)
    ha General `canEdit: false` e Members `canEdit: true`: è il caso del
    «View only».
- [ ] Repositories c'è anche in un progetto senza il modulo Releases (OLV).
- [ ] Ogni tipo registrato qui ha frase e gruppo in en e it (il test di
  `Audit.test.tsx`).
- [ ] Claude non legge nessuna voce dei gruppi `project`, `repositories`,
  `projects`.
- [ ] `ChangeEntry`: il link `projectSettings` apre
  `#/p/<CODE>/settings/<section>`; un `ChangeObjectLink` sconosciuto non
  compila (esaustività).
- [ ] Il registro della riconferma: `REAUTH_REQUIRED` è l'elenco del 9b più
  gli otto di questo piano (i sette di prima più
  `instance.deleteDetachedRepository`, **confermata dal maintainer il 31 ott
  2026**).
- [ ] Seme (*ruling del controller*, 31 ott 2026): STW ha un ambiente
  `test`; ACQ ha `portale-utenti` con webhook `not_configured`; `stubwise`
  non è in `PROJECT_PLUGINS`, e `commandsFor(AUD)` elenca `/stubwise:start`.
- [ ] RNC non è in `visibleProjectIds` di nessuno, nemmeno di Roberta e di
  Claude; la suite delle aree 2–9b resta verde col progetto in più.
- [ ] Commit `feat(desktop): stato delle impostazioni di progetto, sezioni e voci del 9c`.

### Task 2: General, AI, Automations, Usage — livello dati

**Files:** Create `data/projectSettings/{general.ts,ai.ts,automations.ts,usage.ts,reads.ts}`, con il test `data/projectSettings/general.test.ts`. Modify `data/instance/usage.ts` (estrae il calcolo con un filtro di progetto), `data/instance/blocks.ts` (`pickProvider(projectId?)`), `data/queries/projectSettings.ts` (nuovo) e `data/queries.ts` (`export * from "./queries/projectSettings"`).

**Interfaces, prodotte** (le scritture rispondono `ProjectResult`):

```ts
export interface ProjectSettingsView {
  projectId: string; code: string; name: string; description: string;
  ai: { providerId: string | null; exclusive: boolean;
        /** Gli account per la scelta: solo nome, tipo e stato, mai quota o segreto. */
        choices: { id: string; name: string; kind: "subscription" | "api_key"; enabled: boolean; limited: boolean }[];
        /** L'account scelto non c'è più o è spento: si dice, e vale «Automatic». */
        chosenUnavailable: boolean };
  switches: Record<ProjectSwitch, boolean>;
  pulseEveryDays: number;
  correctionCap: number;
  /** Il pulse senza discovery backlog non propone niente: la frase la mette la UI. */
  pulseNeedsBacklog: boolean;
  access: Record<ProjectSettingsSection, SectionAccess>;
}
export function getProjectSettings(projectId: string): Promise<ProjectSettingsView | null>; // null = invisibile o inesistente
export function updateProjectGeneral(projectId: string, input: { name?: string; description?: string }): Promise<ProjectResult>;
export function setProjectAi(projectId: string, input: { providerId: string | null; exclusive: boolean }): Promise<ProjectResult>;
export function saveProjectAutomations(projectId: string, input: { switches: Record<ProjectSwitch, boolean>; pulseEveryDays: number; correctionCap: number }): Promise<ProjectResult>;
export function projectSwitchOn(projectId: string, sw: ProjectSwitch): boolean; // falso su un archiviato o inesistente
export function getProjectUsage(projectId: string, input: { range: UsageRange; groupBy: Exclude<UsageDimension, "project">; thenBy?: Exclude<UsageDimension, "project"> }): Promise<UsageView>; // project.usage.view
// data/instance/blocks.ts
export function pickProvider(projectId?: string | null): RunProvider | null;
```

- `updateProjectGeneral`:
  - `invalid: "name"` per un nome vuoto;
  - nessun campo per il codice;
  - una voce per campo cambiato (`project.renamed` con prima e dopo,
    `project.description_changed` senza il testo intero: dice che è
    cambiata, *scelta del controller*).
- `setProjectAi`:
  - `invalid: "provider"` per un id che non c'è;
  - `invalid: "exclusive_needs_account"` con `exclusive` e `providerId:
    null`;
  - la voce salva `auto` o `account:<id>` più `exclusive` (valori stabili),
    e il nome dell'account si risolve a lettura.
- `pickProvider(projectId)`:
  - col progetto su un account abilitato e non al limite, quell'account;
  - se è al limite o spento, la catena dell'istanza;
  - con `exclusive`, `null`: la sessione parte con `provider: null` come il
    ruling 11 del 9b, e la sezione Claude dice «No account free: this
    project uses only Backup Max» (*scelta del controller*: niente attesa
    per quota nel prototipo);
  - senza progetto, come oggi.
- `saveProjectAutomations`:
  - `invalid: "pulse_days"` fuori da 1–30 o non intero;
  - `invalid: "correction_cap"` fuori da 0–10 o non intero;
  - `invalid: "pulse_needs_backlog"` con il pulse acceso e la discovery
    spenta (regola del web);
  - una voce per ogni valore cambiato;
  - il tetto scrive `Project.correctionCap`, che `capOf` legge già.
- `getProjectUsage`:
  - è il calcolo di `getUsage` col filtro del progetto; `forbidden` senza
    `project.usage.view`, `null` su un progetto invisibile;
  - l'istanza non cambia regola: `usage.view` resta d'istanza.

Test:
- [ ] Ogni scrittura senza `project.settings.manage` (Sara in ACQ) →
  `forbidden`, stato invariato, nessuna voce.
- [ ] Le voci: `project.switch_changed` con `before: "on"`, `after: "off"` e
  `params.switch: "weeklyBrief"`; nessuna parola tradotta nella voce.
- [ ] I bordi: pulse 0, 31, 2.5 → `invalid`; 1 e 30 passano; tetto −1, 11 →
  `invalid`; 0 passa.
- [ ] Pulse senza backlog → `pulse_needs_backlog`; spegnendo prima il pulse
  e poi la discovery, nello stesso salvataggio, passa.
- [ ] `pickProvider`:
  - AUD (Backup Max, `exclusive`) → Backup Max;
  - Backup Max al limite → `null`;
  - senza `exclusive` → Team Max;
  - ACQ (Automatic) → Team Max;
  - l'account eliminato → `chosenUnavailable: true` e la catena.
- [ ] `getProjectUsage(ACQ)`: i totali sono le righe di ACQ di `getUsage`; per
  Sara senza `project.usage.view` → `forbidden`.
- [ ] Commit `feat(desktop): impostazioni generali, AI e automazioni del progetto`.

### Task 3: Il registro per le scritture di progetto che c'erano già

**Files:** Modify `data/api-mutations.ts` (`setProjectStatuses`, `setStallThresholds`), `data/releases/writes.ts` (`setRepoPrMode`, `setReleasePipeline`, `createEnvironment`, `updateEnvironment`, `deleteEnvironment`), `data/support/writes.ts` (`createWidget`, `updateWidget`, `deleteWidget`). Test: `data/projectSettings/legacyWrites.test.ts`.

**Interfaces:** Consumes: i tipi del Task 1. Nessuna firma cambia: ogni funzione chiama `recordChange` dopo la scrittura riuscita, con valori stabili:
- gli stati: l'elenco dei nomi prima e dopo;
- la soglia: i giorni;
- il modo delle PR: l'id del modo;
- la pipeline: `auto` o `named:<n1,n2>`;
- il nome dell'ambiente o del widget com'è.

Test:
- [ ] Per ognuna delle dieci funzioni: una scrittura riuscita scrive una
  voce del tipo giusto, nel progetto giusto, leggibile da Laura in Progetto →
  Settings → Change log; una rifiutata (permesso o input) non ne scrive.
- [ ] Le suite delle aree 2 e 8a restano verdi.
- [ ] Commit `feat(desktop): il registro dice anche stati, ambienti, widget e rilasci`.

### Task 4: Repository, file d'ambiente, Integration, Plugins — livello dati

**Files:**
- Create: `data/projectSettings/{repositories.ts,envFiles.ts,integration.ts,plugins.ts}`.
- Test: `data/projectSettings/repositories.test.ts`, `envFiles.test.ts`,
  `integration.test.ts`, `plugins.test.ts`.
- Modify:
  - `data/seed/commands.ts`: `commandsFor` legge da `skillsForRun`;
    `PROJECT_PLUGINS` e `PLUGINS` diventano il seme delle scelte e del
    plugin base;
  - `data/projectSettings/index.ts`.

**Interfaces, prodotte:**

```ts
// repositories.ts
export interface RepositoryView { id: string; name: string; fullName: string; url: string; provider: "github" | "bitbucket" | null; defaultBranch: string; gitAccount: { id: string; name: string } | null; reviewAccount: { id: string; name: string } | null; installCommand: string | null; testCommand: string | null; graphEnabled: boolean; protectedBranches: string[]; webhook: { state: "not_configured" | "configured" | "failed"; configuredAt: string | null } }
export function listProjectRepositories(projectId: string): Promise<{ canManage: boolean; repositories: RepositoryView[] } | null>; // repos.view
export function listRemoteRepositories(gitAccountId: string): Promise<{ fullName: string; defaultBranch: string; branches: string[] }[]>; // finto, per account
export function checkRepositoryAccess(input: { projectId: string; gitAccountId: string; fullName: string; branch: string }): Promise<ProjectResult<{ outcome: TestOutcome }>>;
export function simulateNextRepositoryCheck(outcome: TestOutcome): Promise<void>;   // riquadro «Prototype only»
export function createRepository(projectId: string, input: { gitAccountId: string; fullName: string; name: string; branch: string; installCommand: string | null; testCommand: string | null }): Promise<ProjectResult<{ repositoryId: string }>>;
export function updateRepository(repositoryId: string, patch: Partial<Pick<RepositoryView, "name" | "url" | "installCommand" | "testCommand" | "graphEnabled" | "protectedBranches">> & { gitAccountId?: string; reviewGitAccountId?: string | null; defaultBranch?: string }): Promise<ProjectResult>;
export function configureRepositoryWebhook(repositoryId: string): Promise<ProjectResult<{ state: "configured" | "failed"; updated: boolean }>>;
export function simulateNextWebhookSetup(outcome: "configured" | "failed"): Promise<void>;
// envFiles.ts
export interface EnvFileView { id: string; path: string; keys: { key: string; setAt: string }[] }
export function listEnvFiles(repositoryId: string): Promise<{ environments: { id: string; name: string; kind: "test" | "staging" | "production"; reachesClaude: boolean; files: EnvFileView[] }[] }>; // solo repos.manage
export function createEnvFile(repositoryId: string, input: { environmentId: string; path: string }): Promise<ProjectResult<{ fileId: string }>>;
export function importEnvFile(fileId: string, content: string): Promise<ProjectResult<{ imported: string[]; replaced: string[]; skipped: { line: number; reason: "syntax" | "key" }[] }>>; // +R
export function setEnvVar(fileId: string, key: string, value: string): Promise<ProjectResult>;   // +R
export function removeEnvVar(fileId: string, key: string): Promise<ProjectResult>;               // +R
export function deleteEnvFile(fileId: string): Promise<ProjectResult>;                           // +R
// integration.ts
export interface IntegrationView { ingestion: { last4: string; createdAt: string; maskedDsn: string; maskedSnippet: string }; inbound: { url: string; auth: string /* «Bearer ••••1a2b» */ }; gitWebhooks: { repositoryId: string; name: string; url: string; secretLast4: string | null; canRegenerate: boolean }[]; canRegenerateKey: boolean; guide: string }
export function getIntegration(projectId: string): Promise<IntegrationView | null>;             // membri
export function regenerateIngestionKey(projectId: string): Promise<ProjectResult<{ key: string; dsn: string; snippet: string }>>; // +R, project.settings.manage
export function regenerateWebhookSecret(repositoryId: string): Promise<ProjectResult<{ secret: string }>>; // +R, repos.manage
// plugins.ts
export const BASE_PLUGIN = "stubwise";
export const RECOMMENDED_PRESETS: Readonly<Record<string, readonly string[]>>; // superpowers → le 4 skill
export interface ProjectPluginsView { version: number; canEdit: boolean; plugins: { name: string; slug: string; status: "ready" | "materializing" | "failed"; base: boolean; inRuns: boolean; skills: { name: string; description: string; enabled: boolean }[]; hooks: { key: string; event: string; command: string; enabled: boolean }[]; preset: string[] | null }[] }
export function getProjectPlugins(projectId: string): Promise<ProjectPluginsView | null>;
export function saveProjectPlugins(projectId: string, input: { version: number; disabled: ProjectPluginChoices["disabled"] }): Promise<ProjectResult<{ version: number }>>;
export function skillsForRun(projectId: string): { plugin: string; skill: string; description: string }[];
```

- **Repository:**
  - la creazione chiede `repos.manage` e una verifica `ok` della stessa
    terna (account, repository, ramo) fatta da chi crea, altrimenti
    `invalid: "access_not_verified"`;
  - il nome è unico nel progetto (`invalid: "name_taken"`: è nell'indirizzo
    dei Docs);
  - l'URL è `https`;
  - l'account di review deve essere della stessa piattaforma e diverso da
    quello principale (`invalid: "review_account"`, regola del web);
  - un ramo protetto vuoto o con spazi è `invalid`;
  - nessuna eliminazione di un repository che sta in un progetto, come sul
    web (quello rimasto senza progetto si elimina dal Task 5, **confermata
    dal maintainer il 31 ott 2026**).
- **Webhook:**
  - «Configure automatically» dà l'esito simulato (default `configured`);
  - `updated: true` se era già configurato (il web distingue «aggiornato»);
  - la voce `repository.webhook_configured` registra lo stato.
- **File d'ambiente:**
  - si leggono e si scrivono solo con `repos.manage`; altrimenti `forbidden`
    sulle scritture, e `listEnvFiles` lancia `forbidden`;
  - il percorso è relativo, senza `..` e senza `/` iniziale
    (`invalid: "path"`), unico per ambiente (`invalid: "path_taken"`);
  - una chiave rispetta `^[A-Za-z_][A-Za-z0-9_]*$`;
  - `importEnvFile` accetta `KEY=value`, `export KEY=value`, valori fra
    virgolette, commenti `#` e righe vuote; ogni altra riga va in `skipped`
    col numero di riga, mai col contenuto;
  - ogni valore va nel caveau (`storeProvidedSecret("env_value", fileId,
    value)`) e nessuna lettura lo restituisce;
  - `reachesClaude` è vero solo per l'ambiente `test` (invariante del
    `CLAUDE.md`);
  - le voci dicono la chiave, mai il valore; `env_file.imported` dice il
    conteggio.
- **Integration:**
  - la chiave d'ingestione è `storeSecret("ingestion_key", projectId)` alla
    rigenerazione, e il valore esce **una volta** nel risultato;
  - il seme ha solo `last4`;
  - `maskedDsn` e `maskedSnippet` hanno `••••<last4>` al posto della chiave;
  - il secret del webhook git è per repository, allo stesso modo;
  - rigenerare invalida il valore di prima (`forgetSecret`) e lo dice la
    voce.
- **Plugin:**
  - l'elenco viene dal registro dell'istanza (`state.instance.plugins`);
  - un plugin non `ready` compare con `inRuns: false` e la sua ragione;
  - il plugin base `stubwise` (le skill di Stubwise in «/») sta fuori dal
    registro e non si spegne, come `stubwise-base` del worker (*scelta del
    controller*): `saveProjectPlugins` con lui fra gli spenti →
    `invalid: "base_plugin"`;
  - `saveProjectPlugins` con una `version` diversa da quella di adesso →
    `conflict`, senza scrivere; se va bene incrementa la versione e scrive
    una voce sola, con le skill e i gruppi di hook accesi e spenti (chiavi
    stabili `plugin:skill`, `plugin#Evento#i`);
  - `skillsForRun` dà le skill dei plugin `ready`, meno le spente, più il
    plugin base;
  - `RECOMMENDED_PRESETS.superpowers` è `using-git-worktrees`,
    `finishing-a-development-branch`, `dispatching-parallel-agents`,
    `subagent-driven-development`, chiavato sul `name` del manifest.

Test:
- [ ] Repository: creazione senza verifica → `access_not_verified`; con la
  verifica `invalid_credentials` simulata → la creazione resta rifiutata; con
  `ok` il repository compare in `listProjectRepositories`, in Amministrazione
  → Repositories (9b) e fra gli spazi dei Docs.
- [ ] `updateRepository`: account di review uguale al principale o d'un'altra
  piattaforma → `review_account`; nome già usato → `name_taken`.
- [ ] Webhook: primo configura → `updated: false`; il secondo `true`; con
  `failed` simulato lo stato è `failed` e la UI potrà dirlo.
- [ ] File d'ambiente:
  - l'import di un testo con una riga rotta riporta `imported`,
    `replaced`, `skipped: [{ line: 3, reason: "syntax" }]`;
  - RF 2: nessuna lettura, voce o notifica contiene i valori importati;
  - senza `repos.manage` → `forbidden`;
  - ogni scrittura +R senza riconferma → `reauth_required`, stato
    invariato;
  - `reachesClaude` vero solo su `test`.
- [ ] Integration:
  - RF 2: dopo `regenerateIngestionKey` il valore è nel risultato e in
    `__secretValuesForTest()`, e in nessuna lettura successiva; il DSN
    mascherato finisce con le stesse ultime 4;
  - Sara legge Integration con `canRegenerateKey: false`.
- [ ] Plugin:
  - RF 5: due letture con `version: 3`, la prima salva (versione 4), la
    seconda → `conflict` e le scelte restano quelle della prima;
  - spegnere `superpowers:brainstorming` lo toglie da `skillsForRun` e da
    `listCommands` del progetto;
  - `lint-helpers` (`failed`) non è in `skillsForRun`;
  - il preset tocca solo le quattro skill;
  - il plugin base → `base_plugin`.
- [ ] Commit `feat(desktop): repository, file d'ambiente, integrazione e plugin del progetto`.

### Task 5: Archivia, riapri, elimina — livello dati

**Files:**
- Create: `data/projectSettings/archive.ts`, con i test `data/projectSettings/archive.test.ts` e `data/instance/detachedRepositories.test.ts`.
- Modify:
  - `data/store.ts`: `archivedProjectIdsFor`; il salto degli archiviati in
    `visibleProjectIds` è del Task 1;
  - `data/changelog/reads.ts`: le letture delle voci di un archiviato;
    `project.deleted` risolto a lettura;
  - `data/automations/entry.ts`: nessun avvio per un progetto archiviato;
  - `data/servers/reads.ts`: `inArchivedOnly`;
  - `data/instance/repositories.ts` (9b): `listDetachedRepositories`,
    `linkRepository`;
  - `data/instance/git.ts` (9b): `GitAccountView.repositories[].projectCode`
    diventa `string | null`, e il rifiuto `in_use` di `deleteGitAccount`
    conta anche i repository senza progetto. Senza questo, un account git
    usato solo da un repository senza progetto si cancellerebbe;
  - `data/queries/instance.ts`;
  - `data/store.ts` (`ApiFnName`): `instance.listDetachedRepositories`,
    `instance.linkRepository`, `instance.deleteDetachedRepository`
    (**confermata dal maintainer il 31 ott 2026**) e
    `projectSettings.getArchivePreview` (*ruling del controller*).

**Interfaces, prodotte:**

```ts
// data/store.ts
/** Gli archiviati che una persona vede, in sola lettura: chi ne era membro e i full admin. Claude no. */
export function archivedProjectIdsFor(personId: string): Set<string>;
// archive.ts
export function busyReasonsOf(projectId: string): BusyReason[];
/** Ruling del controller (31 ott 2026, [AR 3]): cosa dice il dialogo prima di archiviare. */
export function getArchivePreview(projectId: string): Promise<ProjectResult<{ openAutomationRuns: number; busy: BusyReason[] }>>; // project.settings.manage
export function archiveProject(projectId: string): Promise<ProjectResult>;   // project.settings.manage
export function reopenProject(projectId: string): Promise<ProjectResult>;    // project.settings.manage, su un archiviato
export interface ArchivedProjectRow { projectId: string; code: string; name: string; clientName: string | null; archivedAt: string; archivedBy: string; canReopen: boolean; canDelete: boolean }
export function listArchivedProjects(): Promise<ArchivedProjectRow[]>;
export interface ArchivedProjectView extends ArchivedProjectRow { description: string; members: { personId: string; name: string; role: string }[]; counts: DeletionCounts; /** nomi: a Delete restano senza progetto */ repositories: string[]; switchesOnReopen: Record<ProjectSwitch, boolean> }
export function getArchivedProject(code: string): Promise<ArchivedProjectView | null>;
export type DeletionCountKey = "tasks" | "requests" | "docPages" | "conversations" | "channels" | "driveFiles" | "automations" | "environments" | "envFiles" | "releases";
export type DeletionCounts = Record<DeletionCountKey, number>;
/** Cosa resta senza progetto: server (R-L7) e repository (maintainer, 31 ott 2026). Li legge solo il full admin. */
export function getDeletionPreview(projectId: string): Promise<ProjectResult<{ counts: DeletionCounts; orphanServers: string[] /* codici SRV- */; detachedRepositories: string[] /* nomi */ }>>; // full admin, archiviato
export function deleteProject(projectId: string, input: { confirmCode: string }): Promise<ProjectResult>; // +R
// store: deletedProjects
export interface DeletedProject { id: string; code: string; name: string; memberIds: string[]; deletedAt: string; deletedById: string }
// data/instance/repositories.ts (9b, esteso)
export interface DetachedRepositoryRow {
  id: string; name: string; fullName: string | null; gitAccountName: string | null; detachedAt: string;
  /** Da quale progetto eliminato viene: solo a chi ne era membro e al full admin, altrimenti null (R-G5). */
  formerProject: { code: string; name: string } | null;
  /** Dove chi guarda può collegarlo: progetti visibili, non archiviati, con `repos.manage` (tutti per il full admin). */
  linkTargets: { projectId: string; code: string; name: string }[];
  /** Solo il full admin (confermata dal maintainer il 31 ott 2026, domanda 4 (b)). */
  canDelete: boolean;
}
export function listDetachedRepositories(): Promise<DetachedRepositoryRow[]>; // chi vede la voce Repositories (9b), o il full admin
export function linkRepository(repositoryId: string, projectId: string): Promise<ProjectResult>;
export function deleteDetachedRepository(repositoryId: string): Promise<ProjectResult>; // full admin, +R
```

- **Visibilità:**
  - `visibleProjectIds` salta `archived` per tutti, full admin e Claude
    compresi;
  - `archivedProjectIdsFor` dà gli archiviati dove la persona ha
    un'appartenenza (che l'archiviazione non tocca), o tutti se è full
    admin;
  - `can()` non cambia: i permessi dell'archiviato servono solo a Reopen e
    a leggere il suo registro.
- **`archiveProject`:**
  - `busy` con le ragioni di `busyReasonsOf`: le sessioni del progetto non
    terminate (anche in attesa per la coda) e i rilasci con
    `releaseStatus(...).kind === "running"`;
  - `invalid: "already_archived"` se lo è già;
  - scrive `archived = { at: now(), byId }` e la voce `project.archived`;
  - le esecuzioni aperte delle automazioni del progetto si annullano con una
    nota «Project archived» nel loro registro, e non rendono il progetto
    `busy` (**confermata dal maintainer il 31 ott 2026**, domanda 4 (a));
  - gli interruttori e le pause della coda **non** si toccano: a Reopen
    valgono quelli di prima;
  - i lavori fermi per la coda in pausa non possono esistere (sono `busy`).
- **`reopenProject`:**
  - toglie `archived` e scrive `project.reopened`;
  - le notifiche e i fissati tornano a lettura, senza riscritture;
  - le automazioni riprendono a scattare **dagli eventi nuovi**: niente
    recupero di ciò che è successo mentre era archiviato (*scelta del
    controller*).
- **`deleteProject`:**
  - `forbidden` senza `instance.full_admin`;
  - `invalid: "not_archived"` su un progetto attivo;
  - `invalid: "code_mismatch"` se `confirmCode !== code` (confronto
    esatto);
  - poi `reauth_required`;
  - toglie da ogni parte dello stato le righe del progetto (task, richieste,
    stati, traguardi, brief, report, decisioni, conversazioni ed eventi,
    canali e messaggi, Drive, pagine dei Docs, automazioni del progetto,
    file d'ambiente e i loro segreti, ambienti, rilasci, PR, widget,
    conversazioni del supporto, notifiche, appartenenze, concessioni,
    fissati, impostazioni);
  - i server restano, senza quegli ambienti: chi resta senza progetto è
    orfano (R-L7, lo vede `monitor.manage`);
  - **i repository restano senza progetto** (**confermata dal maintainer il
    31 ott 2026**, domanda 2 (b)):
    - passano da `state.repositories` a `state.detachedRepositories`, con
      `formerProjectId`;
    - tengono nome, URL, account git, comandi, grafo e rami protetti;
    - perdono ciò che era del progetto: file d'ambiente (gli ambienti non
      ci sono più), pagine dei Docs, PR e rilasci;
    - il webhook torna `not_configured` e il suo secret si dimentica
      (puntava al progetto eliminato; *scelta del controller*);
  - aggiunge `DeletedProject` e la voce d'istanza `project.deleted` con
    `params.detachedRepositories`;
  - le voci di progetto del registro restano e diventano illeggibili
    (progetto che non esiste).
- **Il registro:**
  - le voci di un archiviato si leggono con la regola R-M1 su
    `visible ∪ archivedProjectIdsFor(me)`;
  - `project.deleted` si legge con `changelog.view` o da full admin; il
    nome e il codice escono solo a chi era fra i `memberIds` o è full
    admin, gli altri leggono `objectLabelKey: "changelog.hiddenProject"`
    e `label` vuoto
    (*scelta del controller*, come il ruling T7 I1).
- **Le automazioni:** un evento o una pianificazione di un progetto
  archiviato non avvia niente; un'automazione generale che vorrebbe agire su
  un archiviato trova `not_found`, come su uno invisibile, e il suo
  registro lo dice in parole; l'esecuzione finisce **non riuscita** e
  compare in «Needs attention» (**confermata dal maintainer il 31 ott
  2026**, [PX 5] dello shape).
- **Amministrazione → Servers:** un server legato solo ad ambienti di
  progetti archiviati ha `inArchivedOnly: true` e nessun progetto nella
  colonna.
- **I repository senza progetto** (Amministrazione → Repositories):
  - `listDetachedRepositories` li dà a chi vede la voce Repositories del 9b
    (`repos.manage` in almeno un progetto) e al full admin; agli altri
    `forbidden`;
  - `formerProject` si risolve con `deletedProjects`: valorizzato solo se
    chi guarda era fra i `memberIds` o è full admin. Nessun altro campo
    della riga lo lascia intuire;
  - `linkRepository`, nell'ordine:
    - `not_found` se il repository non è fra quelli senza progetto
      (anche se un collegamento lo ha appena preso), o se il progetto di
      destinazione è invisibile, archiviato o inesistente;
    - `forbidden` senza `repos.manage` nel progetto di destinazione (il
      full admin ce l'ha sempre);
    - `invalid: "name_taken"` se il nome c'è già in quel progetto (è
      nell'indirizzo dei Docs);
    - niente riconferma: non tocca segreti (*scelta del controller*);
  - collegato, il repository torna in `state.repositories` col progetto
    nuovo, il webhook `not_configured` e nessun file d'ambiente. Compare in
    Progetto → Settings → Repositories e fra gli spazi dei Docs, senza
    pagine;
  - la voce `repository.linked` sta nel progetto di destinazione e non
    nomina il progetto eliminato;
  - con `linkTargets` vuoto (per esempio chi ha `repos.manage` solo in
    progetti archiviati) il bottone è spento, con la frase e il «Who?» di
    `manageRepos`;
  - `deleteDetachedRepository` (**confermata dal maintainer il 31 ott
    2026**, domanda 4 (b)), nell'ordine:
    - `not_found` se il repository non è fra quelli senza progetto (anche
      se un collegamento o un'eliminazione lo ha appena preso);
    - `forbidden` senza `instance.full_admin`;
    - `reauth_required`;
    - poi lo toglie da `state.detachedRepositories` e scrive la voce
      d'istanza `repository.deleted` (nome com'è, `formerProjectId` nei
      param, risolto a lettura come `project.deleted`: R-G5);
    - l'account git non lo conta più: `deleteGitAccount` non trova più
      `in_use` per lui.
- **L'anteprima d'archiviazione** (*ruling del controller*, 31 ott 2026,
  [AR 3]): `getArchivePreview` dà il numero delle esecuzioni aperte delle
  automazioni del progetto (quelle che `archiveProject` annullerà) e le
  ragioni di `busyReasonsOf`; `forbidden` senza `project.settings.manage`,
  `not_found` su un progetto invisibile o già archiviato.

Test:
- [ ] RF 4, busy:
  - una sessione `task_run` viva di ACQ → `busy` con il suo codice;
  - la stessa sessione in attesa per la coda in pausa → `busy` con
    `waiting: true`;
  - un rilascio `running` → `busy`;
  - una sessione finita non conta.
- [ ] Archivia ACQ: `visibleProjectIds` di Laura non ha ACQ, di nessuno;
  `archivedProjectIdsFor` di Laura sì; Sara (membro di ACQ) sì; una persona
  non membro no; Claude no.
- [ ] RF 1, livello dati, dopo l'archiviazione di ACQ:
  - `listProjects`, la ricerca di ⌘K, le notifiche di Laura, `whoCan`, la
    vista dello Stato dell'istanza e `getUsage` non nominano ACQ né il suo
    codice;
  - un `startRun` su una task di ACQ → `not_found`;
  - un trigger di un'automazione di ACQ non crea esecuzioni.
- [ ] Reopen: tutto torna, notifiche comprese; un interruttore spento prima
  dell'archiviazione resta spento.
- [ ] RF 3:
  - Sara non ha RNC in `listArchivedProjects`;
  - `getArchivedProject("RNC")` per Sara è `null`;
  - Giulia lo legge con `canReopen: true`, `canDelete: false`;
  - Roberta con `canDelete: true`.
- [ ] RF 4, delete:
  - su ACQ attivo → `not_archived`;
  - Giulia → `forbidden`;
  - `"rnc"` → `code_mismatch`;
  - senza riconferma → `reauth_required`.

  In nessuno di questi casi cambia qualcosa.
- [ ] Delete di RNC da Roberta:
  - i conteggi di `getDeletionPreview` sono quelli del seme;
  - `detachedRepositories` è `["shop-frontend"]`;
  - dopo, una scansione dello stato (escluso `changelog`,
    `deletedProjects` e `detachedRepositories[].formerProjectId`) non
    trova `prj-rnc`;
  - il server di RNC è orfano e compare in `listAllServers` per Roberta;
  - il valore di nessun file d'ambiente di RNC resta in
    `__secretValuesForTest()`, né il secret del webhook di
    `shop-frontend`.
- [ ] Repository senza progetto, dopo il Delete di RNC (in
  `detachedRepositories.test.ts`):
  - Roberta e Giulia (ex membro di RNC, Project Lead in MKX) leggono
    `formerProject: { code: "RNC", … }`;
  - Laura (con `repos.manage` in ACQ, mai membro di RNC) legge
    `formerProject: null`, e la serializzazione della sua lettura non
    contiene «RNC» né «Tenuta Ronchi» (RF 3);
  - Sara (senza `repos.manage`) → `forbidden`;
  - i `linkTargets` di Laura sono solo i suoi progetti con `repos.manage`,
    senza archiviati;
  - Laura collega `shop-frontend` ad ACQ: compare in
    `listProjectRepositories(ACQ)`, la voce `repository.linked` è in ACQ e
    non contiene «RNC», e il repository non è più fra quelli senza
    progetto;
  - un secondo collegamento dello stesso repository → `not_found`;
    verso RNC archiviato o un progetto di Sara → `not_found`; verso un
    progetto senza `repos.manage` → `forbidden`; verso un progetto che ha
    già `shop-frontend` → `name_taken`. In nessuno di questi casi cambia
    qualcosa o nasce una voce;
  - Roberta (full admin) lo collega a qualunque progetto attivo;
  - `deleteGitAccount` sull'account di `shop-frontend` mentre è senza
    progetto → `in_use`, con la riga senza codice di progetto.
- [ ] Eliminare un repository senza progetto (in
  `detachedRepositories.test.ts`; **confermata dal maintainer il 31 ott
  2026**, domanda 4 (b)):
  - Laura → `forbidden` (e `canDelete: false` nella sua lettura); senza
    riconferma → `reauth_required`; in nessuno dei due casi cambia
    qualcosa o nasce una voce;
  - Roberta con la riconferma: `shop-frontend` sparisce da
    `listDetachedRepositories`, la voce `repository.deleted` c'è, e
    `deleteGitAccount` sul suo account non trova più `in_use` per lui;
  - una seconda eliminazione, o un collegamento dopo, → `not_found`;
  - RF 3: la voce letta da una persona con `changelog.view` che non era
    membro di RNC non contiene «RNC» né «Ronchi»; Giulia e Roberta leggono
    «from RNC».
- [ ] `getArchivePreview(ACQ)` (*ruling del controller*, 31 ott 2026,
  [AR 3]): con due esecuzioni aperte delle automazioni di ACQ dà
  `openAutomationRuns: 2`, e dopo `archiveProject` sono annullate con la
  nota «Project archived»; con una sessione viva dà anche la ragione di
  `busy`; Sara → `forbidden`.
- [ ] RF 3, `project.deleted`: Roberta legge «RNC — Vetrina online Tenuta
  Ronchi»; una persona con `changelog.view` (concessione nel test) che non
  era membro legge la chiave nascosta, e la serializzazione della voce non
  contiene «RNC» né «Ronchi».
- [ ] Commit `feat(desktop): archiviare, riaprire ed eliminare un progetto nel livello dati`.

### Task 6: Gli effetti visibili nelle altre aree

**Files:**
- Modify:
  - `pages/overview/BriefCard.tsx` (brief spento);
  - `pages/overview/pulseLine.ts` (pulse spento);
  - `pages/docs/DocsHome.tsx` e la pagina delle note di rilascio dei Docs
    (Docs notturni spenti);
  - `pages/projects/PeopleActivity.tsx` (report giornaliero spento);
  - `data/api-mutations.ts` (`runIdentity(operation, projectId)`) e i suoi
    chiamanti in `data/servers/analysis.ts` e `fix.ts`;
  - `pages/task/ClaudeSection.tsx` (account del progetto, riga «Skills in
    this run»);
  - `data/model.ts`: `Conversation.skills?: { plugin: string; skill: string }[]`,
    scritto alla nascita della sessione;
  - le letture che mostrano interruttori, brief, pulse e report:
    `projectSwitchOn`;
  - `data/queries/projectSettings.ts`: `useProjectSwitches(projectId)`;
  - `pages/servers/ServerList.tsx` (la riga `inArchivedOnly`);
  - i18n.
- Test: `data/projectSettings/effects.test.ts`, `pages/overview/OverviewPage.test.tsx`, `pages/docs/*.test.tsx`, `pages/projects/PeopleActivity.test.tsx`, `pages/task/ClaudeSection.test.tsx`, `pages/admin/instance/Estate.test.tsx`.

**Interfaces:**
- Consumes: `projectSwitchOn`, `pickProvider(projectId)` (Task 2), `skillsForRun` (Task 4), `archivedProjectIdsFor` e `inArchivedOnly` (Task 5).
- Produces: `runIdentity(operation: AiOperation, projectId: string | null): Pick<Conversation, "provider" | "model" | "skills">`.

Regole (le frasi dallo shape `project-effects.md`):
- **Brief spento:** la BriefCard dice che il brief settimanale è spento per
  questo progetto, al posto di «The first one arrives on Monday». I brief
  già scritti restano leggibili.
- **Docs notturni spenti:** DocsHome e le note di rilascio non dicono più
  «written every night»: dicono che l'aggiornamento notturno è spento.
- **Pulse spento:** la riga quieta del polso nell'Overview dice che le
  proposte per ripartire sono spente; acceso, non dice niente di nuovo
  (*scelta del controller*: il prototipo non genera proposte, quindi lo si
  dice solo dove si direbbe il contrario).
- **Report giornaliero spento** (**confermata dal maintainer il 31 ott
  2026**, domanda 3 (a), che vale anche per la discovery spenta che spegne
  il pulse, Task 2): la riga del
  report del progetto dice «off for this project» invece di «not
  generated»; «Generate» a mano resta.
- **Account AI preferito:** la sessione nasce con `pickProvider(projectId)`,
  e la sezione Claude della task dice quell'account. Con `exclusive` e
  l'account al limite dice la frase del Task 2.
- **Tetto alle correzioni:** nessun codice nuovo (`capOf`); solo un test.
- **Plugin:** `skills` della sessione = `skillsForRun(projectId)` alla
  nascita. La sezione Claude ha una riga «Skills in this run», chiusa, con
  l'elenco; una sessione nata prima del cambio tiene il suo elenco. «/» le
  legge già (Task 4).
- **Progetto archiviato:** niente da fare nelle pagine, oltre ai test: le
  letture lo nascondono (Task 5). In Amministrazione → Servers, la riga
  `inArchivedOnly` dice «Only in archived projects» senza nomi.

Test:
- [ ] Brief: STW acceso → la frase di oggi; MKX spento → «off». Lo stesso
  dopo `saveProjectAutomations` su STW, senza ricaricare la pagina.
- [ ] Docs notturni spenti su STW → DocsHome non contiene «every night».
- [ ] Pulse spento su CBV → la riga quieta lo dice; ACQ no.
- [ ] Report spento → «off for this project», e «Generate» c'è.
- [ ] AUD: «Start» → la sezione Claude dice Backup Max; Backup Max al limite
  → la frase «only Backup Max».
- [ ] Tetto: STW con `correctionCap` 1 → la PR del seme con due giri si legge
  «over the cap» (8a); con 0 il ciclo automatico è spento.
- [ ] Skill: spenta `brainstorming` su STW, una sessione nuova non la elenca;
  una nata prima la elenca ancora.
- [ ] RF 1 nelle pagine: con ACQ archiviato, il binario, ⌘K, la Home e le
  notifiche di Laura non contengono «ACQ».
- [ ] Le suite delle aree 2–9b restano verdi.
- [ ] Commit `feat(desktop): le impostazioni di progetto hanno effetto`.

### Task 7: General, AI, Automations, Usage — UI

**Files:**
- Create:
  - `pages/settings/{GeneralSettings.tsx,AiSettings.tsx,AutomationSettings.tsx,UsageSettings.tsx,ViewOnly.tsx}`;
  - il test `pages/settings/GeneralAiAutomations.test.tsx`.
- Modify:
  - `pages/settings/ProjectSettingsPage.tsx` (le sezioni nuove);
  - `pages/settings/ProjectStatusesSettings.tsx` (legge `canEdit`, niente
    più `can()`);
  - `pages/admin/ai/UsagePanel.tsx`: una prop
    `scope: { projectId: string } | "instance"`, la dimensione `project`
    tolta nello scope di progetto;
  - `layout/ProjectColumn.tsx` («View only» come dice lo shape);
  - i18n.

Segue lo shape `project-settings.md`.

Test:
- [ ] Laura in ACQ:
  - rinomina con «Saved»; un nome vuoto si dice sotto il campo;
  - il codice si legge e non si modifica;
  - la voce compare in Change log.
- [ ] AI: scegli Backup Max e «Use only this account» → «Saved»; l'account
  eliminato si dice in parole.
- [ ] Automations:
  - spegne il brief;
  - pulse a 31 → errore sotto il campo;
  - con la discovery spenta l'interruttore del pulse è spento con la frase,
    senza «Who?»;
  - tetto 0 dice «automatic cycle off».
- [ ] Sara in ACQ: General, AI e Automations in sola lettura, ogni controllo
  spento con la frase e «Who?» (`manageProjectSettings`); Usage e Change log
  non sono nella colonna, e i loro indirizzi portano a General.
- [ ] `#/p/ACQ/settings` apre General (*ruling del controller*, 31 ott
  2026, [PS 2]).
- [ ] «View only» nella forma (a) dello shape (**confermata dal maintainer il
  31 ott 2026**): Sara lo legge solo sulla voce «Settings»; chi ha il solo
  `project.members.manage` lo legge sulle voci rientrate in sola lettura e
  non su «Settings»; una persona con `repos.manage` senza le impostazioni
  non lo legge su Integration.
- [ ] «View only»: la persona con il solo `project.members.manage` legge il
  segno dello shape su General e non su Members.
- [ ] Usage di ACQ per Laura: periodo e gruppo nell'indirizzo, nessuna
  colonna «project».
- [ ] Statuses: il test esistente resta verde leggendo `canEdit`.
- [ ] Commit `feat(desktop): sezioni General, AI, Automations e Usage del progetto`.

### Task 8: Repositories — creazione guidata, modifica, webhook (UI)

**Files:**
- Create `pages/settings/repositories/{RepositoryList.tsx,NewRepositoryWizard.tsx,RepositoryEditor.tsx,WebhookRow.tsx}`.
- Test: `pages/settings/repositories/Repositories.test.tsx`.
- Modify:
  - `pages/settings/RepositorySettings.tsx`: le parti dell'8a restano, sotto
    i campi nuovi e solo col modulo Releases;
  - `router.tsx`: le chiavi `?new=1` e `?repo=<id>`, *scelta del
    controller*, come `addMember` del 9a;
  - i18n.

Segue lo shape `project-repositories.md`.

Test:
- [ ] Creazione guidata da Laura:
  - account git;
  - repository da `listRemoteRepositories`;
  - ramo;
  - «Verify access» con l'esito scelto nel riquadro: con
    `invalid_credentials` la frase e niente «Next»; con `ok` i comandi;
  - «Create» → il repository nell'elenco.

  Il fuoco va al titolo di ogni passo; Esc chiude e torna al bottone.
- [ ] Modifica: account di review uguale al principale → la frase del
  livello dati sotto il campo; rami protetti uno per riga; «Saved».
- [ ] Webhook: «Configure automatically» → «Configured»; il secondo dice
  «Updated»; `failed` simulato → la frase, mai «Configured».
- [ ] Sara (con `repos.view` e senza `repos.manage`): campi come testo,
  «Add repository» spento con «Who?» (`manageRepos`).
- [ ] OLV (senza Releases): la sezione c'è, senza le parti dell'8a.
- [ ] Commit `feat(desktop): creazione e modifica dei repository del progetto`.

### Task 9: File d'ambiente e Integration — UI

**Files:**
- Create:
  - `pages/settings/repositories/{EnvFiles.tsx,ImportEnvDialog.tsx}`;
  - `pages/settings/IntegrationSettings.tsx`;
  - il test `pages/settings/EnvIntegration.test.tsx`.
- Modify:
  - `data/queries/projectSettings.ts`: le scritture con un segreto hanno
    `{ secret: true }`;
  - i18n.

Segue lo shape `project-repositories.md`. `SecretOnce` (9a) per la chiave e il
secret appena nati; nessun `SecretField` (il valore non si rilegge).

Test:
- [ ] File d'ambiente, da Laura in STW:
  - `test` dice che arriva a Claude, `production` dice che no;
  - nuovo file `.env.local` in `staging`;
  - import incollato con una riga rotta → «2 imported, 1 replaced, line 3
    skipped»;
  - sostituisci una variabile, rimuovila, elimina il file: ognuna con la
    riconferma;
  - dopo la navigazione il DOM non contiene nessun valore (RF 2).
- [ ] Senza `repos.manage` la parte dei file non c'è e la frase lo dice con
  «Who?».
- [ ] Integration:
  - Sara vede DSN e snippet mascherati, «Copy» copia il testo mascherato
    con la frase che lo dice;
  - «Regenerate» spento con «Who?»;
  - Laura rigenera con la riconferma → `SecretOnce` con chiave, DSN e
    snippet;
  - chiuso e riaperto, solo `••••<last4>` (RF 2);
  - lo stesso per il secret del webhook di un repository.
- [ ] La guida SDK: «Copy guide» copia il testo della guida, con la chiave
  mascherata; «Save as file…» dà un `.md` con lo stesso testo
  (*ruling del controller*, 31 ott 2026: parità col download del web).
- [ ] Il fuoco torna al «⋯» o al bottone che ha aperto ogni dialogo, anche
  dopo una conferma che cambia la riga.
- [ ] Commit `feat(desktop): file d'ambiente e integrazione del progetto`.

### Task 10: Plugins — UI

**Files:** Create `pages/settings/PluginSettings.tsx`, con il test `pages/settings/PluginSettings.test.tsx`. Modify i18n.

Segue lo shape `project-plugins.md`. La bozza è locale; «Save» manda la
`version` letta.

Test:
- [ ] Laura in STW:
  - spegne una skill e un gruppo di hook → «Saved»;
  - «/» nella conversazione con STW come contesto non elenca la skill.
- [ ] «Apply recommended preset» spegne le quattro skill di superpowers e
  nient'altro.
- [ ] RF 5: un salvataggio con una versione vecchia (una scrittura nel test
  fra lettura e salvataggio) → la frase del `conflict`; la bozza segue lo
  shape; le scelte dell'altro restano.
- [ ] Il plugin base si legge acceso e non si spegne, con la sua frase;
  `lint-helpers` (`failed`) dice che non entra nei run.
- [ ] Sara: sola lettura con «Who?».
- [ ] Commit `feat(desktop): plugin del progetto`.

### Task 11: Archive, la scheda «Archived», la pagina dell'archiviato, Delete — UI

**Files:**
- Create:
  - `pages/settings/ArchiveSettings.tsx`;
  - `pages/projects/{ArchivedProjects.tsx,ArchivedProjectPage.tsx,DeleteProjectDialog.tsx}`;
  - `pages/admin/instance/LinkRepositoryDialog.tsx`;
  - i test `pages/settings/Archive.test.tsx`,
    `pages/projects/Archived.test.tsx` e
    `pages/admin/instance/DetachedRepositories.test.tsx`.
- Modify:
  - `pages/admin/instance/RepositoriesAdminPage.tsx` (9b): il gruppo «Not
    in any project» dopo i gruppi per progetto, solo se non è vuoto. Ogni
    riga ha `formerProject` («from RNC») solo quando la lettura lo dà, e
    «Link to a project…»;
  - `pages/admin/integrations/GitAccountsPage.tsx` (9b): un repository senza
    progetto si legge «not in any project», senza codice;
  - `data/queries/instance.ts`: `useDetachedRepositories`,
    `useLinkRepository`, `useDeleteDetachedRepository` (**confermata dal
    maintainer il 31 ott 2026**); `data/queries/projectSettings.ts`:
    `useArchivePreview` (*ruling del controller*);
  - `pages/projects/AllProjectsPage.tsx`: la scheda «Archived», solo per chi
    ne vede almeno uno, con `?view=archived`;
  - `router.tsx`: `/archived/$code`, *scelta del controller*, fuori da
    `/p/$code` perché il progetto non è più «visibile»;
  - `palette/*`: nessuna voce per gli archiviati (solo un test);
  - i18n.

Segue lo shape `project-archive.md`.

Test:
- [ ] Laura archivia ACQ con una sessione viva → il dialogo dice «Claude is
  working on ACQ-57» e cosa aspettare; finita la sessione, archivia → torna
  ad All projects, ACQ non c'è nel binario né nella scheda dei progetti, ed
  è in «Archived».
- [ ] Giulia in «Archived»: RNC con «Reopen» acceso e «Delete» spento con
  «Who?» (`deleteProjects`).
- [ ] La pagina di RNC: sola lettura, nessun controllo di scrittura salvo
  Reopen/Delete.
- [ ] Reopen da Giulia → RNC torna nel binario.
- [ ] Sara: niente scheda «Archived»; `#/archived/RNC` è «not found» come
  un codice inesistente (RF 3).
- [ ] Delete da Roberta:
  - i conteggi, il server che resta senza progetto e «1 repository stays
    without a project: shop-frontend»;
  - «Delete» spento finché il codice scritto non è «RNC»;
  - poi la riconferma;
  - il toast;
  - il ritorno ad «Archived», senza RNC;
  - la voce `project.deleted` in Amministrazione → Change log, che dice
    anche il repository rimasto senza progetto.
- [ ] Amministrazione → Repositories dopo il Delete
  (`DetachedRepositories.test.tsx`):
  - Roberta vede «Not in any project» con `shop-frontend` «from RNC»;
  - Laura vede la riga senza «from», e il DOM non contiene «RNC» né
    «Tenuta Ronchi» (RF 3);
  - «Link to a project…» di Laura offre solo i suoi progetti con
    `repos.manage`; scelto ACQ, la riga sparisce dal gruppo, il repository
    compare in ACQ → Settings → Repositories, e il fuoco torna al «⋯» o al
    titolo del gruppo se il gruppo sparisce (lo dice lo shape);
  - un nome già usato nel progetto scelto si dice nel dialogo, che resta
    aperto;
  - senza repository senza progetto il gruppo non c'è;
  - Eliminare (**confermata dal maintainer il 31 ott 2026**, domanda 4
    (b)): Roberta apre «⋯» → «Delete…», legge la conferma in rosso e la
    frase sull'account git, riconferma; la riga sparisce e il fuoco va come
    dopo un collegamento; Laura non ha la voce nel «⋯»; in
    Amministrazione → Git accounts l'account non elenca più
    `shop-frontend`.
- [ ] Il dialogo di Archive di ACQ dice «2 automation runs still open will
  be cancelled.» da `getArchivePreview` (*ruling del controller*, 31 ott
  2026, [AR 3]); con zero esecuzioni la riga non c'è.
- [ ] Il fuoco torna al «⋯» della riga dopo ogni dialogo; dopo Delete, che
  toglie la riga, va al titolo della scheda (lo dice lo shape).
- [ ] RF 1: ⌘K digitando «RNC» o «Ronchi» non trova niente, per nessuno.
- [ ] Commit `feat(desktop): archiviare, riaprire ed eliminare un progetto`.

### Task 12: Il registro di progetto con le voci del 9c (UI)

**Files:** Modify `pages/admin/ChangeEntry.tsx` (le frasi dei tipi nuovi e il prima/dopo da `settingValues`), `pages/settings/ProjectChangeLog.tsx` (filtro «Type» con `project` e `repositories`), i18n. Test: `pages/admin/ChangeEntry.project.test.tsx`.

Test:
- [ ] Una voce per gruppo si legge in en e in it, col prima e dopo tradotto:
  - `project.switch_changed`: «Weekly brief: On → Off»;
  - `project.ai_account_changed`: «Automatic → Backup Max (only this
    account)», con l'account eliminato «(deleted)»;
  - `env_var.set`: la chiave, senza valore;
  - `repository.updated`: il campo;
  - `repository.linked`: «linked shop-frontend to ACQ», con il link alla
    sezione Repositories di ACQ, senza il progetto eliminato da cui viene;
  - `project.deleted`: con `params.detachedRepositories` 1, «… 1 repository
    is now in no project», col link ad Amministrazione → Repositories;
  - `repository.deleted` (**confermata dal maintainer il 31 ott 2026**):
    «… deleted the repository shop-frontend, which was in no project (from
    RNC)» per Roberta e Giulia, senza la parentesi per chi non era membro.
- [ ] RF 3: la voce `repository.linked` letta da Laura (Change log di ACQ)
  e da una persona con `changelog.view` non contiene «RNC» né «Tenuta
  Ronchi», nemmeno nel DOM.
- [ ] Il link di ogni voce apre la sezione giusta di Settings.
- [ ] Una voce di un archiviato la legge Giulia dal registro d'Amministrazione
  (se lo vede) e non Laura, che non era membro di RNC.
- [ ] Commit `feat(desktop): le voci del 9c nel registro`.

### Task 13: Documenti, screenshot, follow-up

- `apps/desktop/docs/area9-parity.md`:
  - il titolo diventa «Area 9a, 9b e 9c»;
  - righe per tutte le voci D di `area9-inventory.md` (voce, dove vive, test
    fra virgolette);
  - «Elimina il progetto» diventa «archivia + elimina»;
  - le voci fuori col motivo (regole della posta, «Rigenera il brief»);
  - la sezione «Voci D: rimandate al 9c» si chiude.
- `capture.mjs`, scatti `a9c-*`:
  - General e Automations;
  - AI;
  - la creazione guidata (passo della verifica);
  - la modifica di un repository;
  - i file d'ambiente;
  - Integration con `SecretOnce`;
  - Plugins;
  - Usage;
  - Archive con `busy`;
  - All projects → Archived;
  - la pagina di RNC;
  - il dialogo di Delete, col repository che resta senza progetto;
  - Amministrazione → Repositories col gruppo «Not in any project» (lo
    script elimina RNC prima dello scatto) e il dialogo «Link to a
    project…»;
  - la BriefCard col brief spento.

  Tutto a 1440 e 1024, chiaro e scuro, en e it. Vite ucciso. Rifatti dopo
  ogni correzione visiva.
- `ossatura-follow-ups.md`:
  - «Area 9c — minori aperti», con:
    - le scelte del controller di questo piano, ognuna col costo se
      sbagliata;
    - a parte, le decisioni del maintainer sulle domande del piano;
  - la voce «“View only” su Settings» di «Area 9a — minori aperti» si
    chiude;
  - §11 nuovo nelle invarianti da riscrivere prima del motore: «un progetto
    archiviato è invisibile come uno inesistente (R-G5), tranne ai suoi
    membri e ai full admin in sola lettura; l'eliminazione è del solo full
    admin e solo da archiviato; i repository di un progetto eliminato
    restano senza progetto, si collegano a un altro con `repos.manage` nel
    progetto di destinazione o da full admin, e dicono da dove vengono solo
    agli ex membri e ai full admin». Va scritto in
    `docs/invariants/permissions.md` prima del motore: «Un progetto
    invisibile risponde 404» resta, e si aggiunge l'archiviato. Sul web un
    repository ha sempre un progetto: il motore deve renderlo facoltativo.
- `area9-parity.md`, sezione E: la riga «Tutti i repository» aggiunge il
  gruppo «Not in any project», il collegamento e l'eliminazione da full
  admin (**confermata dal maintainer il 31 ott 2026**), coi loro test.
  L'invariante §11 aggiunge: «un repository senza progetto lo elimina solo
  il full admin, con la riconferma».
- `emptyInstance.test.tsx` copre le rotte nuove (`/archived/$code`, le
  sezioni di Settings).
- Suite, typecheck, lint e build verdi.
- Commit `docs(desktop): note dell'area 9c`.

Dopo il Task 13: revisione finale del branch (area 9c) e revisione visiva di
Impeccable.

---

## Decisioni del maintainer (31 ott 2026)

Le quattro domande del piano. Ognuna è segnata nel testo come
«confermata dal maintainer il 31 ott 2026».

1. **Cosa si apre di un progetto archiviato → (a)**: una pagina sua, in
   sola lettura, con sintesi, membri, conteggi, Reopen e Delete (Task 5,
   11).
2. **I repository di un progetto eliminato → (b)**:
   - restano senza progetto, nel gruppo «Not in any project» di
     Amministrazione → Repositories;
   - si collegano a un altro progetto con `repos.manage` nel progetto di
     destinazione, o da full admin;
   - il dialogo di Delete li conta, e il collegamento scrive
     `repository.linked`;
   - da dove vengono lo leggono solo gli ex membri e il full admin.

   Parti toccate: Global Constraints, Review Focus 3 e 4, Task 0, 1, 5, 11,
   12 e 13. Del 9b: `data/instance/{repositories,git}.ts`,
   `RepositoriesAdminPage.tsx`, `GitAccountsPage.tsx`.
3. **Effetti di report giornaliero e discovery backlog → (a)** (Task 2, 6):
   - report spento: la riga dice «off», e «Generate» a mano resta;
   - discovery spenta: spegne il pulse, e nient'altro.
4. **Le automazioni aperte quando si archivia → (a)**: si annullano con la
   nota «Project archived» e non rendono il progetto `busy` (Task 5).

## Decisioni del maintainer sugli shape (31 ott 2026)

Gli shape del Task 0 sono approvati. Le quattro domande degli shape:

1. **«View only» → (a)** ([PS 3]): segno su «Settings» se tutto è in sola
   lettura, sulle voci rientrate se è misto, sempre la riga in testa alla
   sezione (Task 7).
2. **Conflitto dei plugin → (a)** ([PG 5]): la bozza resta, con «Keep my
   changes on theirs» e «Use theirs» (Task 10).
3. **Automazione generale verso un progetto archiviato → (a)** ([PX 5]):
   l'esecuzione finisce non riuscita, in «Needs attention» (Task 5, 6).
4. **Un repository senza progetto si elimina → (b)** ([AR 9]): solo il full
   admin, da Amministrazione → Repositories, con conferma in rosso, +R e la
   voce `repository.deleted` senza provenienza per chi non la vede; l'account
   git smette di contarlo «in uso». Parti toccate: Global Constraints,
   Review Focus 4, Task 1, 4, 5, 11, 12, 13.

Ruling del controller dello stesso giorno: il seme di STW (ambiente `test`)
e di ACQ (`portale-utenti`), il plugin base `stubwise` per tutti i progetti
(Task 1), `access.integration.canEdit` = chiave o `repos.manage` (Task 1),
`getArchivePreview` con `openAutomationRuns` (Task 5, 11), «Save as file…»
della guida SDK (Task 9), `/p/<CODE>/settings` che apre General (Task 1, 7).
