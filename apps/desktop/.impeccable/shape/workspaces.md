# Shape brief — Workspace: raggruppare i progetti per visibilità

> Stato: **decisa**, 27 nov 2026. Le decisioni del maintainer stanno in
> fondo.

**Superficie**: la colonna di **All projects** (`/projects`). Oggi dice
«Groups of projects will be listed here.» (`coming.projects`). Diventa
l'elenco delle workspace, e il filtro `?workspace=<slug>` della pagina.
La shape tocca anche queste parti:
- la scheda **People** di una workspace, con il pannello del membro;
- il dialogo **New workspace** e le parti del progetto che nominano la
  workspace: Settings → General, Members, New project;
- le **fonti** dei permessi in `PermissionTable`, Members, «Who can?» e
  nella pagina della persona;
- il gruppo **WORKSPACES** di ⌘K;
- il dialogo d'invito di Amministrazione.

**Design tecnico**: `docs/plans/2026-11-27-workspace-design.md` (54). Il
modello (§ «Il modello» sotto) è allineato a quel documento.

**Shape da cui parte**:
- `admin-roles-members.md` per `PermissionTable`, Members e i rifiuti;
- `admin-people.md` per gli inviti e i reparti;
- `admin-audit.md` per «Who can?» e `WhoCanLink`;
- `project-settings.md` per Settings → General;
- `overview.md` per la pagina All projects.

**Mondo e scelte**: mondo «Catalogo numerato», modalità **Operate**. Le
scelte del brief sono segnate **[WS n]**.

## Il modello, in una pagina

- **Una workspace raggruppa PROGETTI per visibilità. Un reparto raggruppa
  PERSONE per ruolo e permessi.** Sono due assi diversi e convivono:
  - una workspace non dà permessi d'istanza;
  - un reparto non fa vedere un progetto (vale ancora: «un reparto non
    rende membri di un progetto»).
- Un progetto sta in **al più una** workspace (D2). Un progetto fuori da
  ogni workspace funziona come oggi: membri espliciti più i full admin.
- Una persona **invitata in una workspace** vede tutti i suoi progetti, con
  il **ruolo di workspace**. Il ruolo di workspace è un ruolo di
  **progetto**, gli stessi ruoli di Roles con i preset, e di base è il più
  basso (D3). Ogni persona ha un ruolo per workspace, e vale in ogni
  progetto della workspace, anche in quelli aggiunti dopo.
- **Il ruolo per progetto** è un membro di progetto normale, con ruolo e
  permessi dati a mano come oggi. È la fonte «progetto».
- **Il permesso effettivo è l'UNIONE** delle tre fonti: workspace, membro
  di progetto e reparto, più i full admin che possono tutto. È il «vince il
  più alto» del maintainer, calcolato per ogni singolo permesso: i preset
  non sono in ordine fra loro, e Contributor e Viewer non si confrontano.
  Ne segue che **un ruolo per progetto può solo aggiungere** (D1).
- Un membro della workspace conta come membro del progetto anche per il
  reparto: i permessi in più del suo reparto valgono lì.
- **Claude non ha workspace**, come non ha ruoli né reparti.

## 1. Lavoro e pubblico

- **Chi**:
  - **Chi organizza** (Roberta, full admin, o chi ha il permesso delle
    workspace, D4). Crea «Clienti farmaceutici» e ci mette FAR, MEE e AUD.
    Ci invita Paola, l'account manager, che deve vederli tutti senza essere
    aggiunta a mano a ognuno. Lo fa poche volte al mese, e prima di salvare
    vuole sapere chi vedrà cosa.
  - **Chi guida un progetto** (Laura, Project Lead di MEE). Vede in
    Members che Paola c'è «dalla workspace» e le dà Developer solo su MEE.
  - **Chi si chiede perché** (Marco, o Roberta in Who can?). «Perché Paola
    vede MEE? Perché può approvare un piano lì?» Vuole la risposta in una
    riga, con le fonti.
  - **Chi lavora e basta**. Nella colonna di All projects trova i progetti
    divisi per cliente o per area, invece di un elenco unico di 30.
- **Stato d'animo**: ordine per chi lavora, precisione per chi organizza.
  Mettere un progetto in una workspace **apre l'accesso a delle persone**:
  la pagina lo dice prima, in numeri e nomi, mai dopo.

## 2. Esito e prova

- **Azioni primarie**:
  - creare, rinominare ed eliminare una workspace;
  - aggiungere un progetto a una workspace, spostarlo in un'altra o
    toglierlo;
  - invitare una persona in una workspace, cambiarle il ruolo, toglierla;
  - dare a una persona un ruolo in un solo progetto della workspace;
  - capire da dove viene un permesso.
- **Successo**, a 1440×900:
  - nella colonna di All projects leggo:
    - WORKSPACES, con «Clienti farmaceutici 3», «Interni 9» e «No
      workspace 4»;
    - un clic filtra la pagina, e l'h1 diventa il nome della workspace;
  - in una workspace, la scheda **People** elenca 12 persone con il loro
    ruolo di workspace. Sotto Paola leggo «+ Developer in MEE»;
  - aggiungendo AUD a «Clienti farmaceutici», prima di salvare leggo
    «5 people will start seeing AUD: Paola Neri, Luca Sarti and 3 more.»;
  - in Members di MEE, Paola ha una riga sola: «Developer · Viewer from
    Clienti farmaceutici». Il pannello dice quale permesso viene da dove;
  - in Who can?, «Who can approve a plan in MEE?» elenca Laura con
    «Project Lead role». Con un Viewer, Paola non compare: il ruolo di
    workspace non dà `plans.approve`;
  - in «What can Paola do in MEE» ogni permesso ha una fonte: «From the
    Developer role in MEE», «From Clienti farmaceutici (Viewer)» oppure
    «From the Development department»;
  - in cima a «What can Paola do in MEE» c'è la riga sulla visibilità:
    «Paola sees MEE because she's in Clienti farmaceutici and a member of
    MEE.»
- **Verità del prodotto**:
  - **la visibilità ha tre porte, e si dicono sempre per nome**: la
    workspace, l'essere membro del progetto, e il full admin. Il reparto
    non è una porta;
  - **i permessi si sommano, non si sostituiscono**. Un ruolo per progetto
    più basso di quello della workspace non toglie niente, e la pagina lo
    dice nel punto in cui lo si sceglie;
  - **un cambio di workspace è un cambio d'accesso**. Aggiungere un
    progetto, toglierlo, spostarlo o eliminare la workspace dice prima
    quante persone cominciano o smettono di vederlo, con la riconferma
    come per i membri;
  - **nessuno dà ciò che non ha**. L'escalation vale per ogni progetto
    della workspace: chi invita come Developer deve avere i permessi di
    Developer in tutti, oppure la scelta è spenta col motivo;
  - **R-G5**: conteggi ed elenchi mostrano solo i progetti e le persone che
    chi guarda vede. Una workspace con progetti invisibili dice «3
    projects», non «3 of 7»;
  - **Claude e i full admin non sono membri di una workspace**: i full
    admin sono detti una volta, come in Members.

## 3. Direzione scelta

- **Tesi**: **la workspace è una cartella nella colonna, e un'etichetta
  accanto a ogni permesso**. Si vede dove si lavora, cioè la colonna di All
  projects, e si spiega dove ci si chiede perché: Members, Who can? e la
  pagina della persona. Non nasce una sezione di Amministrazione a parte
  **[WS 1]**.

### La colonna di All projects

```
┌ Projects ────────────────┐
│ All projects          16 │
│                          │
│ WORKSPACES             + │
│ Clienti farmaceutici   3 │
│ Interni                9 │
│ No workspace           4 │
└──────────────────────────┘
```

- **All projects** in testa, con il conteggio di ciò che chi guarda vede.
  È la voce corrente quando non c'è `?workspace=`.
- **WORKSPACES** (`heading-group`), con **+** a destra solo per chi ha il
  permesso (D4). Il + apre **New workspace**.
- **Una voce per workspace** (32px): nome · conteggio dei progetti
  **visibili** e non archiviati, in cifre tabellari. In ordine
  alfabetico, come i progetti. Al passaggio compare «⋯» con:
  - **Rename** (in posto);
  - **Add projects…**;
  - **Delete…**.

  Senza permesso il «⋯» non c'è.
- **No workspace**: i progetti fuori da ogni workspace, sempre in fondo e
  solo se ce n'è almeno uno. Nessun «⋯».
- **Clic** su una voce: la pagina si filtra (`?workspace=clienti-farmaceutici`,
  `?workspace=none`) e la voce diventa corrente (`aria-current`). Il
  filtro si somma a quelli che ci sono già: testo, tipo, reparto, fissati.
- **Vuoto**: la workspace non c'è ancora in nessun posto.
  - Con il permesso, al posto delle voci: «Group projects by client or
    area. People you invite to a workspace see all of its projects.» + **New
    workspace**.
  - Senza permesso, la colonna dice solo «All projects» e nessun titolo.
- **Chi vede una workspace**: chi ne vede almeno un progetto, oppure ne è
  membro. Una workspace che chi guarda non vede non compare, nemmeno nel
  numero (D5).

### La pagina filtrata da una workspace

- **Testata**: h1 = nome della workspace · riga 13px `ink-muted`
  «3 projects · 12 people». «12 people» porta alla scheda People. A destra:
  - **Add projects** (con il permesso, D4);
  - «⋯» con Rename e Delete….
- **Schede**: Projects · Stalled · Activity · Archived, come oggi, più
  **People** (solo dentro una workspace). Projects, Stalled, Activity e
  Archived mostrano i soli progetti della workspace.
- Con `?workspace=none` l'h1 è «No workspace», con la riga «Projects that
  aren't in a workspace. Only their members and full admins see them.»
  Niente scheda People.

### La scheda People di una workspace

- Riga in prosa: «People in Clienti farmaceutici see all of its projects
  with their workspace role. A role in a single project can only add to
  it.» · a destra **Invite to Clienti farmaceutici**, con il permesso.
- **Riga di una persona** (52px, due righe): avatar 28px · **nome** · ruolo
  di workspace in parola. La seconda riga, 13px `ink-muted`, ha l'email e
  poi i ruoli per progetto in più, in prosa: «+ Developer in MEE» · «+
  Project Lead in FAR». Oltre due: «+2 more». Le persone disattivate stanno
  in fondo, «(deactivated)».
- Sotto l'elenco, 13px: «Full admins see every project, so they aren't
  listed here.»
- **Clic** sulla riga apre il **pannello del membro della workspace**
  (docked 360px, `?member=`), in lettura per chi non gestisce:
  - **Role in Clienti farmaceutici**: menu dei ruoli di progetto con il
    numero di permessi. Un ruolo che chi agisce non può dare in **tutti**
    i progetti della workspace è spento con «You don't have all of these
    permissions in every project of the workspace.» Il link **Where?**
    elenca i progetti dove mancano;
  - **In each project**: una riga per progetto della workspace, codice ·
    nome · ruolo effettivo in parola, con la fonte breve:
    - «Viewer — from the workspace»;
    - «Developer — member of MEE».

    Ogni riga apre il pannello di quel membro in Members del progetto
    (`/p/MEE/settings/members?member=…`): il ruolo per progetto si
    cambia lì, in un posto solo **[WS 2]**;
  - **Remove from Clienti farmaceutici…** in fondo, con un foglio che
    dice cosa resta: «Paola will stop seeing FAR and AUD. She stays a
    member of MEE.» Se ha ruoli per progetto nella workspace, c'è una
    casella «Also remove Paola from MEE», spenta di base (D12 del design):
    un ruolo per progetto può essere stato dato prima della workspace, per
    un motivo suo.
  - barra di salvataggio come in Members: «1 change · Discard · Save» →
    riconferma.
- **Invite to …**: dialogo 440px.
  - **Person**: ricerca fra le persone attive non ancora membri. Niente
    Claude, niente disattivati, niente full admin. Questi ultimi, se
    cercati, si leggono spenti con «Full admin: already sees everything.»
  - **Role**: di base il più basso (D3), con la regola dell'escalation
    detta sopra.
  - Una riga 13px prima del bottone: «Paola will see 3 projects: FAR, MEE,
    AUD.»
  - **Invite** → riconferma → la riga compare in cima per 2 secondi, e il
    toast dice «Paola joined Clienti farmaceutici as Viewer.»
  - Chi non ha un account: il link «Invite someone new to the instance»
    apre il dialogo d'invito di Amministrazione con la workspace già nella
    sua parte **Workspaces** (sotto).

  «Invitare» qui vuol dire aggiungere chi ha già un account, come «Add
  member». Il link d'invito vero resta quello di Amministrazione (D9).

### Creare una workspace e metterci i progetti

- **New workspace** (dal + della colonna e da ⌘K): dialogo 480px.
  - **Name**: lo slug dell'indirizzo nasce dal nome e non si mostra.
  - **Projects**: scelta multipla fra i progetti visibili e non
    archiviati. Un progetto già in un'altra workspace si legge «in
    Interni — moves here». Un progetto in cui chi agisce non gestisce i
    membri (D4) è spento con «You don't manage ACQ's members, so you
    can't change who sees it.»
  - Si può creare vuota: «You can add projects later.»
  - **Create** → riconferma (se ci sono progetti) → apre la pagina filtrata
    sulla workspace nuova, scheda People, con la riga «No one is in
    Clienti farmaceutici yet.» + **Invite**.
- **Add projects…**: lo stesso elenco dei progetti in un dialogo, con
  sotto, prima di salvare, la riga dell'effetto:
  - «5 people will start seeing AUD: Paola Neri, Luca Sarti and 3 more.»
    (**Who?** apre l'elenco in posto);
  - per uno spostamento, anche il rovescio: «2 people will stop seeing FAR:
    they were only in Interni.»

  **Add** → riconferma → toast «AUD is now in Clienti farmaceutici.»
- **Dal progetto**: in Settings → General, una riga **Workspace** con un
  menu «Clienti farmaceutici ▾». Il menu ha le workspace più «No
  workspace», e la stessa riga dell'effetto sotto prima di salvare. In
  lettura per chi non ha il permesso: «In Clienti farmaceutici».
- **New project**: un campo **Workspace**. È già scelta se si crea dalla
  pagina filtrata su una workspace, altrimenti vale «No workspace». Sotto
  c'è la riga «12 people in Clienti farmaceutici will see it.»
- **Togliere un progetto** (dal menu del progetto in Settings → General,
  o nel dialogo «Add projects…» togliendo la spunta): «4 people will stop
  seeing AUD. They aren't members of it.» Il **Who?** fa vedere chi
  sono.
- **Rename**: in posto, nella colonna o con il «⋯» della testata, senza
  riconferma: non cambia nessun accesso.
- **Delete…**: dialogo 440px, «Delete Clienti farmaceutici? Its 3 projects
  stay, in No workspace. 9 people will stop seeing them: they aren't
  members of any.» · **Delete** → riconferma → torna ad All projects, e il
  toast dice «Workspace deleted.»

### Da dove viene un permesso **[WS 3]**

Tre fonti, sempre dette per nome, con le stesse parole dappertutto:

| Fonte | Breve (righe, Who can?) | Per esteso (pannelli, `PermissionTable`) |
|---|---|---|
| workspace | «Viewer from Clienti farmaceutici» | «From the Viewer role in Clienti farmaceutici — every project of the workspace» |
| progetto | «Developer role» | «From the Developer role in MEE» |
| dato a mano | «given by Laura, Oct 29» | «Given by Laura Costa on Oct 29» (come oggi) |
| reparto | «Development department» | «From the Development department — in every project Paola can see» |
| full admin | «full admin» | «Included in full administration» (come oggi) |

- **Members del progetto**: la persona ha **una riga sola**, anche se
  viene da due fonti.
  - Dopo il nome ci sono i ruoli: «Developer · Viewer from Clienti
    farmaceutici».
  - Chi c'è solo dalla workspace ha «Viewer from Clienti farmaceutici» e,
    per chi gestisce, l'azione **Give a role in MEE**. L'azione apre il
    pannello con il menu Role: chi la usa crea un membro di progetto.
  - Un riquadro di filtro sopra l'elenco: «All · Members · From the
    workspace».
  - Sotto l'elenco: «People in Clienti farmaceutici see MEE with their
    workspace role.» con il link alla scheda People.
- **Pannello del membro** (Members):
  - una riga **Sees MEE because**: «member of MEE · in Clienti
    farmaceutici»;
  - il menu **Role in MEE** ha in più la voce «No role here — only the
    workspace's».
  - Scegliendo un ruolo più basso di quello di workspace (cioè con
    permessi già tutti inclusi), sotto il menu si legge ○ «Clienti
    farmaceutici already gives Viewer: this role adds nothing.» Il ruolo
    si può salvare, ma la frase dice che non toglie niente (D1);
  - nella `PermissionTable` le spunte della workspace sono spente, con la
    fonte a destra «From Clienti farmaceutici». Si cambiano dalla scheda
    People della workspace, con il link **Change it there**.
- **Who can?** ha due cambi:
  - il perché guadagna «Viewer from Clienti farmaceutici». L'ordine è:
    ruolo nel progetto, poi workspace, poi dato a mano, poi reparto, poi
    full admin;
  - «What can Paola do in MEE» apre con la riga sulla visibilità («Paola
    sees MEE because she's in Clienti farmaceutici and a member of MEE»).
    Per un progetto che la persona non vede, dice: «Paola doesn't see AUD:
    she isn't a member and it isn't in one of her workspaces.»
- **Pagina della persona** (Amministrazione → People):
  - nella parte **Projects** ogni progetto porta la sua porta: «MEE ·
    Developer · also Viewer from Clienti farmaceutici», «FAR · Viewer from
    Clienti farmaceutici»;
  - c'è una parte nuova **Workspaces**: righe workspace · ruolo, con link
    alla scheda People.
- **Dialogo d'invito** (Amministrazione): oltre a **Projects** c'è
  **Workspaces**, con righe workspace + ruolo e **Add a workspace**. Il
  menu offre solo le workspace dove chi invita può invitare (D4).
- **Reparti**: la frase del pannello del reparto passa da «only in projects
  they're already members of» a «only in projects they can see — as
  members or through a workspace.» (D10)

### ⌘K

- Gruppo **WORKSPACES**: il nome della workspace e «3 projects». Invio
  apre All projects filtrato.
- I progetti nel gruppo PROJECTS portano la workspace come meta, 12px
  `ink-muted`: «MEE Meeting Hub · Clienti farmaceutici».
- Il comando **New workspace…** c'è solo con il permesso.
- «who can» resta com'è: la risposta legge le fonti nuove.

## 4. Ambito e confini

- **Dentro**:
  - la colonna di All projects con le workspace e il filtro;
  - la scheda People e il pannello del membro di workspace;
  - New workspace, Add projects, Rename, Delete;
  - la riga Workspace di Settings → General e di New project;
  - le fonti nuove in Members, `PermissionTable`, Who can? e nella pagina
    della persona;
  - Workspaces nel dialogo d'invito;
  - ⌘K.
- **Fuori** (nel registro dei rimandi, D8):
  - le workspace come filtro nelle altre pagine: Tasks, Planning, Posta,
    Drive, Releases, e i selettori di progetto;
  - una Home o una panoramica per workspace;
  - i colori delle workspace;
  - le workspace annidate.
- **Anti-obiettivi**:
  - una workspace che toglie un permesso;
  - un progetto aggiunto o tolto senza dire chi comincia o smette di
    vederlo;
  - una fonte senza nome («inherited»);
  - un conteggio che rivela progetti invisibili;
  - una sezione «Workspaces» in Amministrazione che duplica la colonna;
  - Claude in una workspace.

## 5. Stati e intervalli

| Parte | Caricamento | Vuoto | Errore |
|---|---|---|---|
| Colonna | 3 voci scheletro sotto WORKSPACES | vedi «Vuoto» nella colonna | «Couldn't load workspaces.» · **Retry**, in posto; All projects resta |
| Pagina filtrata | come oggi | «No projects in Clienti farmaceutici yet.» + **Add projects** (con il permesso) | come oggi; workspace eliminata o invisibile: «This workspace doesn't exist or you can't see it.» · «← All projects» |
| People | 6 righe scheletro | «No one is in Clienti farmaceutici yet.» + **Invite** (con il permesso) | «Couldn't load the people of Clienti farmaceutici.» · **Retry** |
| Pannello | scheletro | — | in posto, **Retry** |

- **I rifiuti, in parole** (stesso schema di `admin-roles-members.md`
  [RM 6]: prima come scelta spenta, dopo come riga ✕ con lo stato
  invariato):
  - **`escalation`** su un ruolo di workspace: «You can't give Developer in
    Clienti farmaceutici: you don't have merge pull requests in AUD.»;
  - **progetto non gestito** (D4): «You don't manage AUD's members, so you
    can't add it to a workspace.»;
  - **ultimo gestore** (`last_manager`, D18 del design): togliere un
    progetto, togliere una persona o eliminare la workspace lascerebbe un
    progetto senza nessuno che ne gestisca i membri. Lo dice già la riga
    dell'effetto, prima di salvare: «No one could manage AUD's members any
    more. Give someone that role in AUD first.» La scelta è spenta;
  - **nome già usato**: «There's already a workspace called Interni.»;
  - **`reauth_required`**: il dialogo di `entry.md`; se lo si annulla, «Nothing
    was changed.»;
  - **errore del livello dati**: «Couldn't save. Try again.» · **Retry**.
- **Intervalli**:
  - 0–12 workspace per istanza (oltre 12, la colonna scorre);
  - 1–30 progetti per workspace;
  - 1–60 persone per workspace (oltre 20, «Find a person» sopra
    l'elenco);
  - 0–5 ruoli per progetto in più per persona.

## 6. Interazione e layout

- Le voci della colonna hanno l'altezza e i ritmi delle voci di Settings
  del progetto. Il «⋯» compare al passaggio e al fuoco.
- La scheda People si apre fino a 880px, come Members.
- Pannelli e barre di salvataggio sono quelli di Members: le modifiche
  restano fino a Save, e chiudere chiede «Discard 1 change?».
- La riga dell'effetto («5 people will start seeing AUD») si aggiorna
  mentre si spuntano i progetti, ed è `aria-live="polite"`.
- **1024×680**:
  - la colonna resta da 240px e i nomi lunghi vanno a capo su due righe,
    non si troncano;
  - in People i ruoli per progetto restano sulla seconda riga (al più uno,
    più «+N more»);
  - il pannello si sovrappone (400px).

## 7. Vincoli

- **Fuori da questa pagina, ma da dire** (se il maintainer accetta D16
  del design): condividere una credenziale della cassaforte con un ruolo
  raggiunge anche chi ha quel ruolo da una workspace. Il dialogo di
  condivisione lo dice nella riga di chi la riceve: «Developers in ACQ,
  including 3 from Clienti farmaceutici».
- Solo via `data/queries.ts`: `listWorkspaces`, `createWorkspace`,
  `renameWorkspace`, `deleteWorkspace`, `setProjectWorkspace`,
  `listWorkspaceMembers`, `addWorkspaceMember`, `setWorkspaceMemberRole`,
  `removeWorkspaceMember` e `workspaceAccessEffect`.
  - `workspaceAccessEffect` dà chi comincia e chi smette di vedere, per la
    riga dell'effetto. Sul server vero è `POST /api/workspaces/effect`
    (design §2.2), che risponde con:
    - `startSeeing` e `stopSeeing` per progetto;
    - `lastManager`;
    - `escalation`.
  - La UI non calcola né l'effetto né le scelte spente: li legge dalla
    query, come `checkEscalation`.
- Le fonti dei permessi vengono dallo stesso calcolo che risponde a
  `can()`: `effectivePermissions` (`data/access/effective.ts`) guadagna la
  fonte workspace in `PermissionSource`, e `sourceView`
  (`data/admin/common.ts`) le sue parole. Who can? (`whoCan`), Members e
  il pannello leggono quella, non una copia.
- Seme: almeno due workspace con progetti, una persona con un ruolo per
  progetto in più, una persona vista SOLO dalla workspace, e un progetto in
  «No workspace». Il «vedi come» deve far provare tutte e tre le porte.
- La voce «coming.projects» sparisce. Va aggiornato ComingSoon.test.tsx, e
  `Column.test.tsx` passa a verificare le voci.
- Testi en/it con parità. Linguaggio neutro nelle frasi italiane (le frasi
  su Paola usano il nome, mai «lei»/«lui» dove si può evitare).

## Scelte del brief

1. **[WS 1]** Le workspace vivono nella colonna di All projects e nelle
   pagine che spiegano un accesso: nessuna sezione nuova in
   Amministrazione.
2. **[WS 2]** Il ruolo per progetto si cambia in un posto solo, cioè
   Members del progetto. Il pannello della workspace ci porta.
3. **[WS 3]** Ogni permesso e ogni visibilità dicono la loro fonte per
   nome, con le stesse parole in Members, Who can? e People.
4. **[WS 4]** Ogni cambio di workspace che apre o chiude un accesso dice
   prima chi tocca, e chiede la riconferma.

## Decisioni (27 nov 2026)

Il maintainer ha accettato tutte le raccomandazioni: le D1–D10 di questa
shape e le D11–D19 del design (`docs/plans/2026-11-27-workspace-design.md`).

1. **D1**: il ruolo per progetto **aggiunge** soltanto. Il permesso
   effettivo è l'unione delle fonti, e non esiste un «nega».
2. **D2**: un progetto sta in **al più una** workspace.
3. **D3**: il ruolo di base di un invito in workspace è **Viewer**.
4. **D4**: il permesso d'istanza nuovo è **`workspaces.manage`**. Lo ha
   già il full admin, implicito, e nessun altro preset. Per mettere,
   togliere o spostare un progetto serve anche `project.members.manage` in
   quel progetto; per uno spostamento, in tutti e due. Per invitare,
   cambiare ruolo e togliere persone servono `workspaces.manage` E
   `project.members.manage` in OGNI progetto della workspace, con
   l'escalation su tutti (una workspace vuota: il solo `workspaces.manage`).
5. **D5**: chi vede almeno un progetto della workspace vede anche la
   workspace, con il conteggio dei soli progetti visibili.
6. **D6**: un progetto archiviato resta nella sua workspace.
7. **D7**: «No workspace» è un posto legittimo. Un'istanza senza
   workspace è identica a oggi.
8. **D8**: le workspace come filtro fuori da All projects vanno nel
   registro dei rimandi.
9. **D9**: chi non ha un account si invita dal dialogo di Amministrazione,
   nella parte Workspaces.
10. **D10**: i permessi in più di un reparto valgono anche nei progetti
    visti dalla workspace.
11. **D11**: mettere un progetto in una workspace chiede la riconferma. Lo
    stesso vale per creare una workspace con dei progetti.
12. **D12**: togliendo una persona dalla workspace, i suoi ruoli per
    progetto restano. La casella «Also remove … from …» è spenta di base.
13. **D13**: un progetto aggiunto non manda card. La card arriva solo a
    chi entra in una workspace.
14. **D14**: «Annulla» di Claude vale anche per le azioni di workspace.
15. **D15**: non si crea nessuna workspace iniziale.
16. **D16**: la condivisione della cassaforte con un ruolo conta anche il
    ruolo di workspace, e il dialogo lo dice.
17. **D17**: posta e calendario contano le persone di workspace, ma non
    gli admin impliciti.
18. **D18**: chi ha `project.members.manage` dalla workspace conta come
    gestore per `last_manager`.
19. **D19**: un progetto eliminato ricorda anche chi lo vedeva dalla
    workspace.
