# Shape brief — Roles e Members del progetto, con i rifiuti

Superficie: **Roles** in Amministrazione (`/admin/roles`) con la pagina di
un ruolo (`/admin/roles/$roleId`) e la tabella dei permessi condivisa
**`PermissionTable`**; **Members** in Progetto → Settings
(`/p/<CODE>/settings/members`) con il pannello del membro e il dialogo **Add
member**; le **frasi dei rifiuti** (`escalation`, `target_above`, ultimo
gestore, ultimo full admin, `reauth_required`), valide anche per
`admin-people.md`. Piano 9a: Task 9 (ruoli) e Task 10 (Members); dati: Task
1, 2 e 4. Spec area 9: «Roles», «Members del progetto», «Cosa diventa un
permesso», Review Focus 1 e 3. Web di riferimento (cosa si porta, non come
appare): `apps/web/src/routes/settings/roles.tsx`,
`apps/web/src/components/project-members-section.tsx`,
`apps/web/src/lib/permission-groups.ts`, chiavi `settings.roles.*`,
`projects.members.*`, `permissions.label.*`. Mondo: «Catalogo numerato»,
modalità **Operate**. Scelte del brief **[RM n]**.

## 1. Lavoro e pubblico

- **Chi**:
  - **Chi disegna i ruoli** (Roberta, `roles.manage`): crea «Release
    manager», toglie un permesso da Developer, controlla quante persone
    toccherà. Lo fa poche volte l'anno e vuole vedere l'effetto **prima**
    di salvare.
  - **Chi guida un progetto** (Laura, Project Lead di ACQ con
    `project.members.manage`): aggiunge Federico, gli dà `servers.operate`
    per una settimana, lo toglie. Lo fa spesso, in fretta.
  - **Chi è membro e basta** (Marco): guarda chi c'è nel progetto e chi
    può approvare, per sapere a chi chiedere.
- **Stato d'animo**: precisione. Ogni casella è un accesso. La pagina deve
  rendere leggibile **da dove** viene ogni permesso, e dire in parole
  perché una scelta non si può fare.

## 2. Esito e prova

- **Azioni primarie**: creare, duplicare, modificare ed eliminare ruoli;
  aggiungere, togliere, cambiare ruolo a un membro; dare e togliere
  permessi in più.
- **Successo**, a 1440×900:
  - nella pagina di un ruolo leggo i permessi in 11 gruppi più «Prototype»,
    **ognuno con una frase**, e prima di salvare «This changes what 6
    people can do»;
  - in Members di ACQ, accanto a Marco leggo «Developer» e sotto «+ operate
    servers — given by Roberta Fontana on Oct 29»; accanto a Giulia «+
    reply to customers — from the Development department»;
  - Laura prova a dare `release.merge` a Marco: la casella è spenta con
    «You don't have this permission in ACQ, so you can't give it.»;
  - sotto l'elenco una riga dice che i full admin non sono elencati perché
    possono tutto.
- **Verità del prodotto**:
  - **una regola, un calcolo**: la UI non decide cosa è spento, lo legge
    dalla risposta del livello dati (`checkEscalation`/`checkTarget`);
  - **i preset si modificano, non si eliminano**; **un ruolo in uso non si
    elimina**;
  - **un ruolo non arriva mai a Claude**: Claude non ha ruoli, e la pagina
    lo dice una volta;
  - **una modifica vale subito, anche per chi la fa**: togliersi
    `roles.manage` dal proprio ruolo ha effetto al salvataggio, e lo si
    dice prima;
  - **Claude e i full admin non sono righe di Members**.

## 3. Direzione scelta

- **Tesi**: **i permessi sono un elenco di frasi, non una griglia di
  sigle**. Ogni permesso è una riga: casella · nome in parole · frase che
  dice cosa permette di fare · (quando serve) la fonte o il motivo per cui
  è spento. Le chiavi tecniche (`plans.approve`) non compaiono mai a chi
  guarda, tranne nel `title` della riga per chi le cerca **[RM 1]**.

### `PermissionTable` (condivisa da Roles, Members, Departments)

- Gruppi con `heading-group`, nell'ordine di `permission-groups.ts`:
  istanza → ADMINISTRATION · PEOPLE · PROJECTS · INTEGRATIONS · MONITORING
  AND USAGE; progetto → PROJECT · TASKS · AI RUNS AND RELEASES · BACKLOG
  AND DECISIONS · DOCS · CODE AND ENVIRONMENTS; più **PROTOTYPE** con i
  permessi locali (planning delle task altrui, canali e chat generale,
  Drive, automazioni, risposta ai clienti, server, SSH, Home del reparto,
  attività delle persone, reparti, Stato dell'istanza, registro).
- Riga (36px, due righe se la frase va a capo): casella · **nome** 14px
  («Approve plans») · frase 13px `ink-muted` («Lets someone approve or
  reject the plan Claude writes before it changes code.») · a destra,
  12px, il contesto:
  - **spento per escalation**: casella spenta, a destra «You don't have
    this» con `aria-describedby` alla frase lunga «You don't have this
    permission, so you can't give it.»;
  - **incluso** (full admin): spunta piena spenta, «Included in full
    administration»;
  - **dal ruolo / dal reparto** (in Members): spunta spenta, «From the
    Developer role» / «From the Development department».
- In testa a ogni gruppo, a destra, «3 of 5» (cifre tabellari).
- **Filtro** sopra la tabella: «Find a permission» (sul nome e sulla
  frase) e l'interruttore «Only what's on». Gruppi senza risultati
  spariscono.
- Tastiera: Tab fra le caselle, Spazio spunta; i gruppi sono `fieldset`
  con `legend`.

### Roles (`/admin/roles`)

- h1 «Roles» · riga in prosa: «Roles decide what people can do. An
  instance role applies everywhere; a project role applies in the
  projects where someone is a member.»
- Due gruppi: **INSTANCE ROLES** (con a destra **New instance role**) e
  **PROJECT ROLES** (**New project role**), solo con `roles.manage`.
- **Riga di un ruolo** (44px): **nome** · «Preset» in 12px `ink-muted` per
  i preset · «14 permissions» · «6 people» (instance: link a People
  filtrato per quel ruolo; project: «9 memberships», link che apre un
  piccolo elenco sotto la riga — persona · progetto — con le sole persone
  e i soli progetti visibili) · «⋯» con **Duplicate** e **Delete…** (solo
  dove ha senso). Clic sulla riga → pagina del ruolo.
- Senza `roles.manage` la voce non c'è nella colonna (tabella dello
  spec): la pagina non ha uno stato «in lettura».

### La pagina di un ruolo (`/admin/roles/$roleId`)

- **Testata**: «← Roles» · h1 = nome del ruolo · riga 13px `ink-muted`:
  «Project role · preset · 6 people» · a destra «⋯» (Duplicate · Delete…).
- **Name**: campo (anche per i preset: si rinominano). Sotto, per i preset,
  12px: «A preset can be renamed and changed, not deleted.»
- Una riga 13px con ○, sempre: «Roles never apply to Claude. Claude can
  work but doesn't decide, whatever is ticked here.» **[RM 2]**
- La `PermissionTable` dello scope del ruolo.
- **Barra di salvataggio** agganciata in fondo alla pagina, solo con
  modifiche: «4 changes · this changes what 6 people can do» (link
  «Who?» che apre l'elenco in posto) · **Discard** · **Save role** →
  riconferma → «Saved» e la barra sparisce. Se chi salva ha questo ruolo e
  si toglie qualcosa: riga ▲ `warning` nella barra «You have this role:
  you'll lose manage roles when you save.» **[RM 3]**
- Lasciare la pagina con modifiche: «Discard 4 changes?»
- **New … role**: dialogo 440px — **Name** · **Start from** (vuoto o un
  ruolo dello stesso scope; i ruoli oltre chi agisce spenti con «Includes
  permissions you don't have.») · **Create** → riconferma → apre la pagina
  del ruolo nuovo.
- **Duplicate**: crea «Copy of Developer» e apre la sua pagina (stessa
  regola di escalation: spento col motivo se il ruolo d'origine supera chi
  agisce).
- **Delete…**:
  - preset: la voce non c'è; al suo posto nel «⋯», spenta, «Presets can't
    be deleted»;
  - in uso: dialogo «Release manager is still used» · l'elenco (persona ·
    progetto, link alle persone) · «Give them another role first.» ·
    **Close**;
  - libero: conferma a due tempi nel dialogo «Delete Auditor? No one has
    it.» → riconferma → torna a Roles, toast «Role deleted.»

### Members (`/p/<CODE>/settings/members`)

- **Dove sta** **[RM 4]**: in Progetto → Settings. Quando Settings è
  aperto, la voce «Settings» della colonna del progetto mostra sotto di sé
  le sue sezioni come voci rientrate da 32px — Statuses · Members ·
  Repositories (se il modulo c'è) · Change log — e ogni sezione è una
  pagina. 9c aggiungerà le sue voci allo stesso elenco. La pagina
  `/p/<CODE>/settings` apre Statuses.
- h1 «Members» · riga in prosa «Who works on ACQ, with which role, and what
  each person can do beyond it.» · a destra **Add member** (solo
  `project.members.manage`).
- **Riga di un membro** (52px, due righe): avatar 28px · **nome** · ruolo
  di progetto in parola · seconda riga 13px `ink-muted`: email, poi i
  **permessi in più** in prosa, ognuno con la fonte breve: «+ operate
  servers (given by Roberta, Oct 29)» · «+ reply to customers (Development
  department)» · «+ automations (sample data)»; se sono più di due, «+3
  more» e il resto nel pannello. Una persona disattivata non è membro
  attivo: compare in fondo, `ink-muted`, «(deactivated)».
- Clic sulla riga → **pannello del membro** (docked 360px, `?member=`);
  anche per chi non gestisce, in lettura **[RM 5]**.
- Sotto l'elenco, 13px `ink-muted`: «Full admins can do everything in
  every project, so they aren't listed here.» Niente su Claude.
- **Pannello del membro**:
  - testata: avatar, nome, email, link «Open in People» (se chi guarda
    vede Amministrazione);
  - **Role**: menu dei ruoli di progetto con il numero di permessi; i
    ruoli oltre chi agisce spenti con «Includes permissions you don't
    have.»;
  - **What they can do here**: la `PermissionTable` del progetto con, per
    ogni permesso, la sua fonte (dal ruolo, dal reparto, data a mano); si
    spuntano e tolgono **solo** i permessi dati a mano. La fonte per esteso
    sotto il nome: «Given by Roberta Fontana on Oct 29» · «From the
    Development department — change it in Departments» (link se chi guarda
    ha `departments.manage`) · «From the sample data»;
  - **Remove from ACQ…** in fondo (conferma a due tempi);
  - barra di salvataggio in fondo al pannello come quella dei ruoli
    («2 changes · Discard · Save») → riconferma.
  - Senza `project.members.manage`: stessa vista, nessuna casella attiva,
    nessuna barra, nessun «Remove».
- **Add member**: dialogo 440px — **Person** (ricerca fra le persone
  attive non ancora membri: niente Claude, niente disattivati) · **Role**
  (come sopra) · **Add** → riconferma → la riga compare in cima per 2
  secondi con lo sfondo `ink/6` e toast «Federico joined ACQ as Developer.»
  Nessuno da aggiungere: «Everyone active is already in ACQ.»

## 4. Ambito e confini

- **Dentro**: Roles completo (due scope, preset e a mano, crea, duplica,
  modifica, elimina, chi lo ha), `PermissionTable` con le frasi per ogni
  permesso del web e del prototipo, Members con pannello e aggiunta, la
  sottonavigazione di Settings, le frasi dei rifiuti.
- **Fuori**: le altre sezioni di Settings (9c); i permessi di Claude
  (fissi, non modificabili da nessuna pagina); l'assegnazione del ruolo
  d'istanza (è nella pagina della persona).
- **Anti-obiettivi**: una griglia di sigle senza frasi; un permesso spento
  senza motivo; un rifiuto mostrato come «Error 403»; Claude o i full
  admin fra i membri; il conteggio «6 people» che include persone che chi
  guarda non vede.

## 5. Stati e intervalli

| Pagina | Caricamento | Vuoto | Errore |
|---|---|---|---|
| Roles | 6 righe scheletro per gruppo | un gruppo senza ruoli a mano mostra solo i preset (mai vuoto) | «Couldn't load roles.» · **Retry** |
| Ruolo | testata + scheletro della tabella | — | «Couldn't load this role.» · **Retry**; ruolo eliminato: «not found» con «← Roles» |
| Members | 6 righe scheletro | «No members yet. Add the people who work on ACQ.» + **Add member** (solo chi gestisce; agli altri «No members yet.») | «Couldn't load ACQ's members.» · **Retry** |
| Pannello | scheletro | — | in posto, **Retry** |

- **Senza permessi**: Roles non c'è per chi non ha `roles.manage`;
  Members è in lettura per i membri; un progetto invisibile è «not found».

### I rifiuti, in parole **[RM 6]**

Dove si vedono: **prima**, come scelta spenta col motivo (il caso
normale); **dopo**, se la scrittura torna rifiutata comunque (stato
cambiato nel frattempo, «vedi come» cambiato), come riga ✕ `critical`
sopra la barra di salvataggio o nel dialogo, con lo stato invariato.

- **`escalation`**: «You can't give approve plans in ACQ: you don't have it
  yourself.» Con più permessi: «You can't give these because you don't
  have them: approve plans, merge pull requests.» (fino a 3, poi «and 2
  more»). Per un ruolo: «You can't save this role: it would include
  manage users, which you don't have.»
- **`target_above`**: «Laura has permissions in ACQ that you don't, so you
  can't change her role or permissions.» Nel pannello è la riga in testa
  (○, 13px) e tutto il pannello è in lettura.
- **Ultimo gestore dei membri**: «You're the only one who can manage ACQ's
  members. Give someone else that permission before removing it from
  yourself.» (e «…before leaving ACQ» per «Remove»).
- **Ultimo full admin** (dalla pagina del ruolo, togliendo full
  administration ad Admin): «Saving would leave the instance without a full
  admin.»
- **Ruolo in uso / preset**: vedi «Delete…» sopra.
- **`reauth_required`**: dialogo di `entry.md`; annullato, la barra di
  salvataggio resta con le modifiche e il toast «Nothing was changed.»
- **Errore del livello dati**: «Couldn't save. Try again.» · **Retry**
  nella barra, modifiche conservate.

- **Intervalli**: 4–12 ruoli per scope; 30–55 permessi per scope (con
  «Prototype»); 1–40 membri per progetto (oltre 20, campo «Find a member»
  sopra l'elenco); 0–6 permessi in più per membro.

## 6. Interazione e layout

- Pagina del ruolo fino a 760px; Members fino a 880px (come le altre
  sezioni di Settings).
- Barre di salvataggio agganciate in fondo, fondo `surface`, filetto
  `rule` sopra; entrano in 150ms.
- Il pannello del membro è il pannello di dettaglio esistente; chiudendolo
  con modifiche: «Discard 2 changes?».
- **1024×680** (720px utili): la frase dei permessi va a capo sotto il
  nome (riga a due righe sempre); il contesto a destra («You don't have
  this») scende sotto la frase; in Members i permessi in più restano sulla
  seconda riga, al massimo uno più «+N more»; il pannello del membro si
  sovrappone (400px).

## 7. Vincoli

- Solo via `data/queries.ts` (`listRoles`, `createRole`, `updateRole`,
  `duplicateRole`, `deleteRole`, `listProjectMembers`, `addMember`,
  `removeMember`, `setMemberRole`, `grantMemberPermission`,
  `revokeMemberPermission`); le scelte spente vengono dalla query, non da
  un controllo nella pagina.
- Frasi dei permessi in `permissions.<key>.label|hint`, quelle del web
  dove esistono; un test fallisce se un permesso non ha frase.
- Il conteggio «6 people» e gli elenchi «chi lo ha» rispettano R-G5.
- Testi en/it con parità.

## Scelte del brief

1. **[RM 1]** Ogni permesso è una riga con nome e frase in parole; le
   chiavi tecniche solo nel `title`.
2. **[RM 2]** «Roles never apply to Claude» scritto una volta in ogni
   pagina di ruolo.
3. **[RM 3]** Prima di salvare, la barra dice quante persone cambiano e
   avvisa se chi salva perde qualcosa.
4. **[RM 4]** Le sezioni di Settings diventano voci rientrate sotto
   «Settings» nella colonna del progetto, una pagina ciascuna.
5. **[RM 5]** Un membro si apre nel pannello laterale, anche in sola
   lettura.
6. **[RM 6]** Ogni rifiuto si previene con la scelta spenta e il motivo;
   se arriva comunque, una riga in parole e lo stato invariato.

## Scelte confermate dal maintainer (29 ott 2026)

1. **Settings del progetto con le sezioni nella colonna** **[RM 4]**.
2. **Membro nel pannello laterale** **[RM 5]**.
