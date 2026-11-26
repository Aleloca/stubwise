# Integrazione area 9, F1 — accessi: piano del renderer

*16 nov 2026, 94. Accanto al piano del server
(`2026-11-16-integrazione-area9-f1-plan.md`, 72) e al design
(`2026-11-16-integrazione-area9-design.md`, § F1, E-1, E-4). Il renderer è
`apps/desktop/src/renderer/` (i percorsi qui sotto sono relativi a lì). La
specifica è il prototipo: dove il design lo cambia, **il prototipo cambia
PRIMA**, con i suoi test, e solo dopo si collega. Due consegne sullo stesso
backend: **F1a** (Preferenze e ingresso) e **F1b** (People, Roles, Members,
«Chi può farlo?», Inbox).*

## Regole di lavoro

- **TDD**: il test prima, visto ROSSO; una mutazione per ogni regola
  principale, verificata (si applica, il codice gira, il test diventa rosso).
- **I1**: niente si accende nella build app senza il suo dato vero. Ogni
  sezione resta «in arrivo» finché il suo adattatore non c'è.
- **I2**: nessun segreto in cache (`useWrite(…, { secret: true })`): link
  d'invito e di reset, token, comando di Claude Code, codici di backup.
- **I3**: `INTEGRATED_CALLS` (`pages/ComingSoon.test.tsx`) cresce nello
  stesso commit dell'accensione, insieme all'elenco di `integration.test.ts`.
- **I campi nuovi** si leggono con un default (`?? null`, `?? []`): un server
  più vecchio non li manda.
- **Giri di test**: i file toccati interi; il pacchetto desktop intero alla
  fine di ogni consegna. Prima del commit: tsc, eslint sui file cambiati,
  prettier sui file nuovi o già puliti.
- **Il client vero** è quello del Task 11 di 72 (`packages/api-client`): ogni
  adattatore sta in `data/backend/real/*` e si combina con
  `partialNamespace`, come nelle aree prima.

---

## F1a — Preferenze e ingresso

### R1 — Il prototipo cambia: la foto (design 1.6)

- `pages/preferences/AccountSection.tsx` e `data/me/account.ts`:
  - si accettano solo **PNG, JPEG e WebP** (oggi anche GIF e ogni
    `image/*`), al più **512 KB**;
  - un SVG, un GIF o un file troppo grande dà l'errore in parole, sotto la
    foto, e niente cambia;
  - `accept` del selettore allineato.
- *Test*: i tre tipi entrano; NEGATIVI: SVG (anche con nome `.png`), GIF,
  oltre 512 KB.

### R2 — Il prototipo cambia: il cambio dell'email (design 1.6, E-1)

- **Persona** (Preferenze → Account):
  - «Cambia email» chiede la **riconferma** (`me.requestEmailChange` in
    `REAUTH_REQUIRED`), poi lo stato «in attesa di conferma su <nuova>»;
  - fino alla conferma il login vale con la VECCHIA (`data/auth/login.ts`
    lo rispetta);
  - «Annulla» toglie la richiesta; una seconda richiesta sostituisce la
    prima;
  - il link è simulato nel riquadro «Prototype only» («Apri il link di
    conferma»), monouso, 24 ore dall'orologio del prototipo;
  - al clic l'email cambia; sessioni, token e secondo fattore restano; una
    voce nel registro di sicurezza e l'avviso di sicurezza;
  - `email_taken` (anche un invito pendente) sotto il campo.
- **Senza trasporto** (E-1, `email_transport_unavailable`): la sezione dice
  «non disponibile su questa istanza: chiedi a un amministratore». Nel
  prototipo si simula dal riquadro «Prototype only».
- **Admin** (People → persona, `users.manage`): «Cambia email…» con la
  riconferma (`admin.changeEmail` in `REAUTH_REQUIRED`), mai su sé stessi,
  `email_taken`; cambia SUBITO, annulla la richiesta personale pendente,
  l'avviso nomina l'admin.
- *Test*: il cambio solo dopo il clic; login con la vecchia prima e con la
  nuova dopo; annulla; link scaduto, annullato o già usato; senza
  riconferma `reauth_required`; il ramo admin; NEGATIVI: sé stessi,
  `email_taken`.

### R3 — Il prototipo si allinea: sessioni e tentativi

- **Sessioni** (`SecuritySection.tsx`, `data/me/securityLog.ts`): le righe
  hanno `kind` (browser, desktop, mobile), `userAgent`, `createdAt`,
  `lastSeenAt`, `current`; «Sign out» su tutte tranne la corrente
  (`current_session`). Il seme ne ha una per tipo.
- **Tentativi rimasti** (`SecondFactorStep.tsx`, `layout/ReauthDialog.tsx`):
  il contatore viene da `attemptsLeft`; senza il campo, niente contatore e
  il solo «codice sbagliato».
- *Test*: l'elenco, la chiusura di un'altra, NEGATIVO la corrente; il
  contatore con e senza il campo.

### R4 — Collegare le Preferenze

- Adattatori in `data/backend/real/`:
  - **Account**: nome e lingua, foto (`PUT`/`DELETE /api/me/avatar`
    binario dal file scelto; `avatarUrl` al posto di `photo`), cambio
    d'email (`me.emailChange` start/cancel; `409
    email_transport_unavailable` → lo stato «non disponibile»);
  - **Security**: TOTP, codici di backup, sessioni (`me.sessions`,
    `endSession`), registro di sicurezza. Le **passkey**: nel desktop una
    riga che rimanda al browser (non ci sono passkey dal desktop, D1); nella
    web «app» sì;
  - **Tokens** e **Claude Code**: ci sono già sul server (inventario 4),
    con la riconferma;
  - **Look**: lingua e tema; si può accendere anche prima del resto.
- La riconferma passa dal dialogo di sempre (`useReauth`); nel desktop dal
  codice (`/api/auth/desktop-reauth`), nel web dalla sessione.
- **Accensione**: le sezioni `account`, `security`, `tokens`,
  `claude-code`, `look` di `/preferences` nella build app (oggi ricadono
  sulla destinazione `preferences`, «in arrivo»: l'instradamento in
  `data/integration.ts` va per sezione, come già per `notifications`).
- *Test*: un test d'adattatore per ogni rotta (forma, errori nelle parole
  del prototipo, `reauth_required` → la riconferma, campi assenti); un test
  della pagina nella build app per sezione.

### R5 — L'ingresso nella web «app» (design 1.9, E-4)

- Solo nella build **web «app»** (`build:web`); il desktop resta col login
  dal browser (`DesktopLoginPage.tsx`, PKCE) e non cambia.
- `pages/entry/` sulle rotte vere:
  - `/app/#/login`: password, secondo fattore (codice, passkey, backup),
    iscrizione al volo (`EnrollAtLoginStep.tsx`), blocco col contatore;
  - `/app/#/register/<token>`, `/app/#/reset-password/<token>`,
    `/app/#/setup` (primo avvio);
  - la sessione è il cookie del web; un 401 riporta al login.
- **I link creati dall'app** (invito in F1b, reset in F1b) si costruiscono
  dal `token`: `${origin}/app/#/register/<token>` e
  `${origin}/app/#/reset-password/<token>` (Task 10b del server). Quelli del
  web vecchio restano suoi.
- **Da verificare con 72**: passkey su `/app` (stessa origine, `rpID`).
- *Test*: login con codice, passkey, backup e blocco; invito valido,
  scaduto, già usato; reset; setup una volta sola; un 401 a metà sessione.

---

## F1b — People, Roles, Members, «Chi può farlo?», Inbox

### R6 — Il prototipo si allinea: la disattivazione

- `deactivatePerson(id, reassignTo)` ha già la riassegnazione PER TASK;
  si allinea all'errore del server: una riga non valida fa fallire tutto
  (`invalid_reassignment` con l'id della task), niente a metà. Il dialogo
  (`DeactivateDialog.tsx`) segna la riga.
- *Test*: una riga non valida → niente riassegnato, la riga indicata.

### R7 — Collegare People e Roles

- **People** (`PeoplePage.tsx`, `PersonDetail.tsx`, `InviteDialog.tsx`,
  `InvitePage.tsx`, `ResetDialogs.tsx`, `DeactivateDialog.tsx`):
  - elenco con `status` e gli inviti; ruolo d'istanza, reset della password
    (il link dal `token`, R5), reset del secondo fattore, registro di
    sicurezza del membro, identità git;
  - disattiva/riattiva (`users.deactivate { reassign }`, `reactivate`);
  - «Cambia email…» (R2, `PATCH /api/users/:id/email`);
  - `target_above` non arriva più: il codice che lo traduceva si toglie.
- **Roles** (`RolesPage.tsx`, `RoleEditor.tsx`): elenco, crea, modifica,
  duplica, elimina (inventario 6, c'è).
- **Accensione**: `admin:people`, `admin:roles`.
- *Test*: d'adattatore per ogni rotta; la pagina nella build app; il link
  d'invito e di reset puntano a `/app`.

### R8 — Collegare Members

- `pages/settings/MembersSettings.tsx`, `AddMemberDialog.tsx`: ruolo e
  permessi personali (`permissions` nel `PUT`, l'insieme completo);
  provenienza `role` e `grant`; `department` resta spenta fino a F8
  (`department-permissions` spenta nell'app); `escalation` e `last_manager`
  nelle parole del prototipo.
- **Accensione**: `projectSettings:members`.
- *Test*: provenienze; un permesso dato e tolto; NEGATIVI: escalation,
  ultimo gestore, un permesso d'istanza.

### R9 — «Chi può farlo?»

- `pages/admin/WhoCanPage.tsx`, `data/access/whoCan.ts`: nell'app legge
  `access.whoCan` (con `projectId` facoltativo per un permesso d'istanza) e
  `access.whatCan`; la mappa AZIONE → permesso e scope resta nel client (è
  catalogo e testo); nessun calcolo duplicato.
- Claude ha la sua riga fissa dal server (`agent: true`); le persone
  disattivate no.
- **Accensione**: `admin:who-can`.
- *Test*: un'azione di progetto e una d'istanza; un progetto invisibile;
  una persona da «what can».

### R10 — Inbox: «Restore», «Move to New», «Mark unread»

- `notifications/NotificationItem.tsx`: le tre azioni sulle rotte nuove;
  `409 invalid_state` → la card si ricarica; `404` → sparisce.
- **Accensione**: nella funzione `notifications`, già accesa: le tre azioni
  escono dal loro ramo «in arrivo».
- *Test*: i tre passaggi; il conteggio dei non letti; `invalid_state`.

### R11 — Parità e chiusura

- `apps/desktop/docs/area9-parity.md`: la colonna «app» per ogni voce di F1.
- Il registro dei rimandi: ciò che resta (registro delle modifiche → F2,
  reparti → F8, cassaforte → design a sé).
- Il pacchetto desktop intero; il report a 46 con i commit.

## Dipendenze

- R1, R2, R3, R6 (il prototipo) partono subito, senza il server.
- R4 dipende dal Task 11 di 72 (client) e dai task 5–8 del server.
- R5 dipende da E-4 e dal Task 10b; R7 da 4, 9, 10b; R8 da 3; R9 da 9;
  R10 da 10.

## Cosa F1 renderer non fa

- Il registro delle modifiche (F2): People e Members non scrivono voci nuove
  finché F2 non c'è; il prototipo le scrive già, e nell'app la pagina resta
  «in arrivo».
- I permessi dei reparti (F8), la cassaforte dal desktop.
- La riconferma sulle rotte con segreti dell'istanza (F3).
