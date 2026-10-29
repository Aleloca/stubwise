# Shape brief — Amministrazione: intelaiatura, People, inviti, Departments

Superficie: l'intelaiatura di **Amministrazione** (`/admin/$section`, oggi
`AdminPage` segnaposto) con la colonna delle voci filtrate per permesso;
**People** (`/admin/people`), la pagina di una persona
(`/admin/people/$personId`), il dialogo **Invite someone**, la pagina di un
invito, il dialogo **Deactivate**; **Departments** (`/admin/departments`) con
il pannello del reparto. Voce del menu del profilo e gruppo «People» di ⌘K
(«Invite someone», le persone). Piano 9a: Task 8 e, per i reparti, Task 9
(dati: Task 4). Spec area 9: «Amministrazione: com'è fatta», «People»,
«Inviti», «Departments», anti-obiettivi. Inventario: sezione B. Web di
riferimento (cosa si porta, non come appare): `apps/web/src/routes/team.tsx`,
chiavi `settings.team.*`. Ruoli e Members: `admin-roles-members.md`; registro
e «Who can?»: `admin-audit.md`. Mondo: «Catalogo numerato», modalità
**Operate**. Scelte del brief **[PE n]**.

## 1. Lavoro e pubblico

- **Chi**:
  - **Chi amministra** (Roberta, full admin): invita, cambia ruoli
    d'istanza, resetta password e secondo fattore, disattiva chi se ne va,
    tiene in ordine i reparti. Lo fa di rado, ma sbagliare costa: un
    accesso dato per errore, un ex collega ancora dentro.
  - **Chi invita senza amministrare** (un Project Lead con `users.invite`
    e `project.members.manage` su alcuni progetti): porta dentro un
    collaboratore nei suoi progetti, e basta.
  - **Chi cerca qualcuno** (chiunque, Sara compresa): «chi è in ACQ?», «chi
    sta in Sviluppo?», «che email ha Matteo?». Solo lettura.
- **Stato d'animo**: compito amministrativo, attento. Le azioni rare e
  irreversibili (disattivare, resettare) devono **dire le conseguenze
  prima**, in righe; quelle frequenti (cercare, filtrare) devono essere
  immediate.

## 2. Esito e prova

- **Azioni primarie**: trovare una persona e vedere dove sta e cosa può
  fare; invitare; cambiare ruolo d'istanza; resettare password o secondo
  fattore; collegare identità git; disattivare con riassegnazione e
  riattivare; creare e gestire reparti, le loro persone, la loro Home e i
  loro permessi.
- **Successo**, a 1440×900:
  - in People filtro «Development · Active» e leggo in righe nome, email,
    ruolo, reparti e progetti, senza aprire nessuno;
  - apro Marco e vedo **in una pagina** ruolo d'istanza, progetti con
    ruolo e permessi in più (con la loro fonte), reparti, identità; le
    azioni rare stanno in un «⋯», non in fila di bottoni;
  - disattivando Simone il dialogo mi elenca le sue 2 task aperte, ognuna
    con «Reassign to», e mi dice cosa succede a quelle che lascio;
  - invito Federico in ACQ come Developer, copio il link e il dialogo mi
    dice «Send it yourself: Stubwise doesn't send emails.»;
  - in un reparto vedo chi c'è, chi ne gestisce la Home, e quali permessi
    porta, con la frase «only in projects where each person is already a
    member».
- **Verità del prodotto**:
  - **nessuno dà ciò che non ha, nessuno tocca chi sta sopra**: le scelte
    che superano chi agisce sono spente col motivo in parole, non
    nascoste; se passano lo stesso (stato cambiato), il rifiuto torna in
    parole;
  - **resta sempre un full admin**; **non si agisce su sé stessi** (ruolo,
    reset, disattivazione);
  - **i link di reset e d'invito si vedono una volta**;
  - **un reparto non rende membri di un progetto**;
  - **Claude non compare** in People, negli inviti, nei reparti;
  - i progetti mostrati per ogni persona sono **solo quelli che chi guarda
    vede** (R-G5).

## 3. Direzione scelta

### Intelaiatura di Amministrazione

- Destinazione personale, come le Preferenze: colonna da 240px senza
  titolo (l'h1 della pagina è il titolo), voci 32px raggruppate con
  `heading-group`:
  - **ACCESS**: People · Departments · Roles
  - **RECORDS**: Change log · Who can?
  - 9b aggiunge i suoi gruppi sotto (AI · Integrations · Instance), senza
    toccare questi.
- Ogni voce compare solo con il suo permesso (tabella dello spec); un
  gruppo senza voci non compare. `/admin` apre la prima voce visibile.
- **Voce del menu del profilo** **[PE 1]**: si chiama **Administration**
  per chi vede almeno una voce di gestione (Departments, Roles, Change log,
  o People con `users.manage`/`users.invite`); per gli altri, che vedono
  solo People in lettura e Who can?, si chiama **People** e porta alla
  stessa intelaiatura con le due voci. Il titolo della colonna non esiste,
  quindi nessuna pagina dice «Administration» a chi non amministra nulla.
- Una voce aperta per indirizzo senza permesso: la pagina «not found»
  dell'app (R-G5), non un «forbidden».

```
┌──────────────┬───────────────────────────────────────────────────────────────┐
│ ACCESS       │ People                                       [Invite someone] │
│ People   42  │ Everyone on this instance: where they work and what they can  │
│ Departments  │ do.                                                           │
│ Roles        │ [Find a person…]  Department ▾  Role ▾  Status: Active ▾      │
│ RECORDS      │ ───────────────────────────────────────────────────────────── │
│ Change log   │ (MB) Marco Bellini        Developer · User   ACQ AUD STW +2   │
│ Who can?     │      marco.bellini@…      Development                         │
│              │ (LC) Laura Costa          User               ACQ AUD          │
│              │      laura.costa@…        Development                         │
│              │ (FR) federico.r@…         Invited · expires Nov 5             │
│              │                           ACQ as Developer                    │
└──────────────┴───────────────────────────────────────────────────────────────┘
```

### People (`/admin/people`)

- h1 «People» · riga in prosa «Everyone on this instance: where they work
  and what they can do.» · a destra **Invite someone** (solo
  `users.invite`).
- **Barra**: campo «Find a person» (nome o email; filtra mentre si
  scrive) · **Department** (menu a scelta multipla) · **Role** (ruoli
  d'istanza) · **Status** (Active · Invited · Deactivated; di base Active
  e Invited; «Invited» c'è solo con `users.invite`). I filtri attivi si
  leggono nel bottone («Department: Development, Sales») e stanno
  nell'indirizzo.
- **Riga di una persona** (52px, due righe, intera riga cliccabile verso
  la sua pagina **[PE 2]**):
  - avatar 28px (foto o iniziali);
  - prima riga: **nome** (600) · ruolo d'istanza in parola · a destra i
    **progetti** come codici in cifre tabellari, al massimo 4 e «+2» (il
    `title` li elenca tutti con il ruolo);
  - seconda riga, 13px `ink-muted`: email · reparti per nome, separati da
    «·» (nessuna striscia: non è una riga di task);
  - stato, solo se non è «attiva»: «Deactivated Oct 19» in `ink-muted` con
    glifo ○, la riga intera a `ink-muted`.
- **Riga di un invito** (nello stesso elenco, **[PE 3]**): avatar vuoto
  tratteggiato · l'email al posto del nome · «Invited · expires Nov 5» (▲
  `warning` «Expired Oct 25» se scaduto) · seconda riga: i progetti offerti
  con il ruolo («ACQ as Developer») e chi ha invitato («by Laura Costa»).
  Apre la pagina dell'invito.
- **Ordine**: per nome; gli inviti dopo le persone attive, i disattivati in
  fondo.
- Tastiera: ↑/↓ fra le righe, Invio apre.

### La pagina di una persona (`/admin/people/$personId`)

- **Testata**: «← People» · avatar 56px · h1 = nome · riga 13px
  `ink-muted`: email · «Member since Mar 2025» · stato se non attiva. A
  destra «⋯» con le azioni rare, ognuna presente solo per chi la può fare
  (`users.manage`): **Reset password…** · **Reset two-step verification…**
  · **Deactivate…** / **Reactivate**. Su sé stessi il «⋯» non c'è (le
  proprie cose sono nelle Preferenze: una riga 12px lo dice, «This is you.
  Your own settings are in Preferences.»).
- **Parti** in una pagina che scorre, ognuna con titolo `headline` e
  filetto sopra:
  1. **Instance role** — il ruolo in parola con la frase del ruolo («User —
     works in the projects they're a member of.») e **Change…**
     (`users.manage`). Il cambio apre un menu dei ruoli d'istanza con il
     numero di permessi; un ruolo che contiene permessi che chi agisce non
     ha è spento con «Includes permissions you don't have.» Scelto →
     riconferma → toast «Marco is now Auditor.» Su sé stessi: **Change…**
     spento con «You can't change your own instance role.»
  2. **Projects** — righe: codice + nome · ruolo di progetto · **permessi
     in più** in prosa sotto il ruolo, ognuno con la fonte («+ approve
     plans — given by Laura Costa on Oct 29», «+ reply to customers — from
     the Development department»). Con `project.members.manage` nel
     progetto la riga ha **Edit**, che apre lo stesso pannello del membro
     di `admin-roles-members.md`; altrimenti nessuna azione. **Add to a
     project** (menu dei progetti dove chi agisce gestisce i membri). Solo
     progetti visibili a chi guarda; se la persona è in progetti che chi
     guarda non vede, una riga 12px «Also in projects you can't see.»
     **[PE 4]**.
  3. **Departments** — i reparti per nome, con lo swatch del reparto (la
     barra 3px da legenda: qui il colore è il contenuto) e «manages the
     department Home» dove vale. **Edit** porta al pannello del reparto
     (`departments.manage`).
  4. **Linked identities** — **Git emails**: una riga per email collegata,
     con **Unlink** (riconferma, conferma a due tempi); **Link a git
     email** apre un campo di ricerca sugli autori osservati non risolti
     (lo stesso dell'Activity dell'area 3: «12 commits in ACQ, last Oct
     27») o accetta un'email nuova. **Bitbucket username**: valore o «Not
     linked» · **Link** / **Unlink**. Tutto con `users.manage`.
  5. **Security log** (`users.manage`) — come quello personale delle
     Preferenze, con «by Roberta Fontana» negli eventi fatti da altri.
- **Senza `users.manage`**: le parti 1–4 in sola lettura, la 5 assente, nessun
  «⋯».
- **Persona sopra chi guarda** (`target_above`): le azioni restano visibili
  ma spente, e in testa alla pagina una riga 13px con ○: «Roberta has
  permissions you don't have, so you can't change her role, projects or
  access.» Una volta, non su ogni controllo **[PE 5]**.

### Reset password e secondo fattore

- **Reset password…** → dialogo 440px «Create a password reset link for
  Marco?» · «Any earlier link for Marco stops working.» · **Create link**
  → riconferma → nel dialogo `SecretOnce` con il link e sotto «Expires Nov
  1 at 10:12 · works once · signs Marco out everywhere when used. Send it
  yourself.» · **Done**.
- **Reset two-step verification…** → dialogo 440px «Reset Marco's two-step
  verification?» · le conseguenze in righe: «Marco is signed out
  everywhere.» · «Marco sets it up again at the next sign-in.» · «Marco's
  access tokens keep working.» · «Marco gets a security alert.» → **Reset**
  (`critical`) → riconferma → toast «Two-step verification reset for
  Marco.» Tra pari grado (un admin su un altro admin) una riga in più:
  «This is recorded in the change log and Marco is told who did it.»
- Persona senza secondo fattore: la voce è spenta con «Sara hasn't set up
  two-step verification.»

### Disattiva e riattiva

- **Deactivate…** → dialogo 560px «Deactivate Simone Greco?»:
  - le conseguenze, una per riga: «Simone can't sign in.» · «Simone
    disappears from the people you can assign or invite to a project.» ·
    «Tasks still assigned to Simone show “(deactivated)”.» · «You can
    reactivate Simone later: projects and roles come back as they were.»;
  - **Open tasks (2)**: una riga per task — codice + titolo (testo, non
    link: il dialogo non si lascia a metà) · menu **Reassign to** con «Leave with Simone» di base e le persone
    attive membri del progetto di quella task (Claude incluso solo se la
    task è assegnabile a Claude come nell'area 2) **[PE 6]**; sopra
    l'elenco, «Reassign all to…» che imposta tutte le righe insieme;
  - nessuna task aperta: «Simone has no open tasks.»;
  - **Deactivate** (`critical`) → riconferma → toast «Simone was
    deactivated. 1 task reassigned to Marco.»
- **Rifiuti in posto** (bottone spento con il motivo sopra):
  - sé stessi: «You can't deactivate yourself.»;
  - ultimo full admin: «Roberta is the only full admin. Make someone else
    full admin first.»
- **Reactivate**: conferma a due tempi nel «⋯», toast «Simone is active
  again.» (nessuna riconferma).

### Inviti

- **Invite someone** → dialogo 560px «Invite someone»:
  - **Email**; **Instance role** (di base «User»; ruoli oltre chi invita
    spenti con «Includes permissions you don't have.»);
  - **Projects**: righe progetto + ruolo, **Add a project**; il menu dei
    progetti offre solo quelli dove chi invita ha
    `project.members.manage`, e se non ce n'è nessuno la parte dice «You
    can invite people to the instance, but not to a project: you don't
    manage members anywhere.»; i ruoli oltre chi invita spenti come sopra;
  - **Create invite** → riconferma → nel dialogo `SecretOnce` con il link,
    «Send it yourself: Stubwise doesn't send emails.» e «Expires in 7 days
    (Nov 5).» · **Done**.
  - Errori in parole sotto il campo: «Someone with this email already has
    an account.» · «There's already an invite for this email. Revoke it
    first.» · «Enter a full email address.»
- **Pagina di un invito** (`/admin/people/invites/$id`): h1 = email · «Sent
  by Laura Costa on Oct 29 · expires Nov 5» (o «Expired Oct 25») · i
  progetti offerti con il ruolo · il ruolo d'istanza · **Revoke invite**
  (conferma a due tempi). Una riga 12px: «The link was shown once, when the
  invite was made. To send a new one, revoke this invite and make another.»
  Revocato: torna a People con il toast «Invite revoked.»

### Departments (`/admin/departments`)

- h1 «Departments» · riga in prosa «Departments group people across
  projects. A department can also give its people extra permissions — only
  in projects they're already members of.» · **New department**.
- **Riga di un reparto** (48px): swatch (barra 3px, 16px d'altezza) +
  **nome** · «8 people» · «Home: Giulia Ferri» (o «No one manages the
  Home») · seconda riga 13px `ink-muted`: i permessi che porta in prosa
  («Gives: reply to customers») o «Gives no extra permissions». Clic →
  **pannello del reparto** (docked 360px, `?department=`).
- **Pannello del reparto**:
  - **Name** (campo) e **Color**: le 8 tinte di `DESIGN.md` come gruppo di
    scelta, ognuna con il suo nome accessibile («Color 4, red-orange») e,
    sotto la tinta, «used by Sales» se già in uso (permesso, ma detto);
    salva subito (`updateDepartment`, nessuna riconferma);
  - **People**: elenco con **Remove** e **Add people** (ricerca fra le
    persone attive); accanto a ogni persona la casella «Manages the Home»;
  - **Extra permissions in projects**: la `PermissionTable` compatta (solo
    i gruppi di progetto e «Prototype»), ognuno con la sua frase; sopra,
    13px: «People in this department get these in every project they're
    already a member of. It doesn't add them to any project.»; un permesso
    che chi agisce non ha è spento con «You don't have this permission, so
    you can't give it.»;
  - People, Home e permessi si **salvano insieme** con la barra in fondo al
    pannello «3 changes · **Save** · Discard» → riconferma → «Saved»;
  - **Delete department…** in fondo, separato da un filetto.
- **Elimina**: dialogo 440px. Senza task: «Delete Sales? People stay; they
  just aren't in Sales any more.» · **Delete**. Con task: «34 tasks have
  Sales as their department. Move them to:» + menu (gli altri reparti o
  «No department») · **Move and delete**.
- **New department**: dialogo 440px con nome e colore (la prima tinta
  libera già scelta) · **Create** → apre il suo pannello.

## 4. Ambito e confini

- **Dentro**: intelaiatura con voci filtrate e voce del profilo; People
  con filtri; pagina della persona con le cinque parti e le azioni rare;
  inviti (dialogo, righe, pagina, revoca); disattiva/riattiva con
  riassegnazione; Departments con pannello ed eliminazione con
  spostamento; ⌘K «Invite someone» (solo `users.invite`) e le persone (che
  aprono la loro pagina).
- **Fuori**: identità Slack e «Invite from Slack» (sostituiti); la pagina
  pubblica del link di reset; l'invio di email; i ruoli (vedi
  `admin-roles-members.md`).
- **Anti-obiettivi**: un'azione su sé stessi che parte; un menu di ruoli
  che offre un ruolo oltre chi agisce come se niente fosse; un link
  d'invito o di reset che si rivede; Claude in un elenco; un progetto
  invisibile nominato nella riga di una persona.

## 5. Stati e intervalli

| Pagina | Caricamento | Vuoto | Errore |
|---|---|---|---|
| People | 8 righe scheletro sotto la barra | nessun risultato: «No one matches these filters.» · **Clear filters**; istanza vuota: «Only you so far.» + **Invite someone** | «Couldn't load people.» · **Retry** |
| Persona | testata + scheletro delle parti | progetti: «Not in any project you can see.»; identità: «No git email linked.» | «Couldn't load Marco's details.» · **Retry**; persona inesistente o Claude: «not found» |
| Departments | 5 righe scheletro | «No departments yet. Departments group people and can give them extra permissions.» + **New department** | «Couldn't load departments.» · **Retry** |
| Pannello reparto | scheletro | reparto senza persone: «No one in this department yet.» | in posto, **Retry** |

- **Rifiuti** (tutti in parole, nel punto dell'azione, stato invariato):
  - `escalation`: «You can't give “Auditor”: it includes view usage, which
    you don't have.» (elenca fino a 3 permessi mancanti, poi «and 2
    more»);
  - `target_above`: «Roberta has permissions you don't have, so you can't
    change her.»;
  - ultimo full admin: «Roberta is the only full admin. Make someone else
    full admin first.»;
  - ultimo gestore dei membri (dal pannello del membro): vedi
    `admin-roles-members.md`;
  - `reauth_required`: dialogo di `entry.md`; annullato, «Nothing was
    changed.»
  - Aggiungere a un reparto che porta permessi oltre chi agisce: «Sales
    gives reply to customers, which you don't have, so you can't add
    people to it.»
- **Intervalli**: 6–200 persone (oltre 50 la lista è virtualizzata); 0–12
  reparti; 0–40 progetti per persona (la riga ne mostra 4); 0–10 inviti in
  sospeso. Nomi ed email lunghi: ellissi, intero nel `title`.

## 6. Interazione e layout

- Contenuto delle pagine fino a 960px; la pagina della persona fino a
  760px (sono parti di testo).
- Il pannello del reparto è il pannello di dettaglio esistente (docked da
  1200px in su, sovrapposto sotto); con modifiche non salvate, chiuderlo
  chiede «Discard 3 changes?».
- Dopo un'azione dal «⋯» il fuoco torna al «⋯»; dopo **Done** di un
  `SecretOnce` torna al controllo che l'aveva aperto.
- **1024×680** (720px utili): in People i progetti scendono sulla seconda
  riga accanto ai reparti, la prima riga tiene nome e ruolo; la barra dei
  filtri va a capo su due righe; la pagina della persona resta a una
  colonna; il pannello del reparto si sovrappone (400px) e la lista resta
  leggibile sotto lo scrim; i dialoghi restano 560/440px.

## 7. Vincoli

- Solo via `data/queries.ts` (`listPeople`, `getPerson`, `setInstanceRole`,
  `createPasswordResetLink`, `resetSecondFactor`, `listSecurityEvents`,
  `linkGitIdentity`, `unlinkGitIdentity`, `setBitbucketUsername`,
  `deactivatePerson`, `reactivatePerson`, `listInvites`, `createInvite`,
  `revokeInvite`, `createDepartment`, `updateDepartment`,
  `setDepartmentMembers`, `setHomeManagers`, `setDepartmentPermissions`,
  `deleteDepartment`).
- Le scelte spente col motivo leggono la risposta di `checkEscalation` /
  `checkTarget` esposta dalla query (nessuna seconda copia della regola
  nella UI).
- Riuso: `SecretOnce` (`preferences-account.md`), `PermissionTable`
  (`admin-roles-members.md`), pannello di dettaglio, dialoghi, conferma a
  due tempi, ricerca degli autori dell'Activity.
- Testi en/it con parità.

## Scelte del brief

1. **[PE 1]** La voce del profilo si chiama «Administration» solo per chi
   gestisce qualcosa; per gli altri «People», con le stesse due voci in
   lettura.
2. **[PE 2]** Una persona si apre in una pagina intera, non nel pannello
   laterale.
3. **[PE 3]** Gli inviti in sospeso sono righe dell'elenco People (stato
   «Invited»), non una voce separata della colonna.
4. **[PE 4]** «Also in projects you can't see.» quando la persona è in
   progetti invisibili a chi guarda, senza numero.
5. **[PE 5]** Il motivo `target_above` scritto una volta in testa alla
   pagina della persona, con i controlli spenti.
6. **[PE 6]** La riassegnazione nel dialogo di disattivazione è per task,
   con «Reassign all to…» sopra e «Leave with Simone» di base.
7. **[PE 7]** Le modifiche di un reparto (persone, Home, permessi) si
   salvano insieme, con una sola riconferma.

## Scelte confermate dal maintainer (29 ott 2026)

1. **Nome della voce nel profilo** per chi non amministra **[PE 1]**.
2. **Persona in pagina intera** **[PE 2]**.
3. **Inviti dentro People** **[PE 3]**.
