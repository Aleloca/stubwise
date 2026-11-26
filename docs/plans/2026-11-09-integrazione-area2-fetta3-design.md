# Integrazione area 2, fetta 3 — Home a blocchi e filtri salvati — design

Data: 9 nov 2026. Segue i design delle fette 1 e 2
(`docs/plans/2026-11-09-integrazione-area2-{task,fetta2}-design.md`), che
restano validi. Specifica: il prototipo — `docs/plans/2026-10-23-desktop-area2-task-design.md`
§2 (Home) e §4 (Filtri salvati), `apps/desktop/.impeccable/shape/home.md`, e il
codice in `apps/desktop/src/renderer/{pages/home,pages/filters,domain/{home,filters}.ts,data/seed/{homes,filters}.ts}`.
Scelte *(maintainer)* e *(orchestratrice)* come nelle fette precedenti.

## Cosa entra

- **Home a blocchi** su `/home`, con la Home predefinita di ogni reparto,
  l'unione per chi sta in più reparti, la Home personale (personalizza,
  nascondi, aggiungi, riordina con mouse e tastiera, ripristina), la riga «La
  Home del reparto è cambiata · Vedi le novità», i blocchi fissi «Da decidere» e
  «La mia settimana».
- **Catalogo dei blocchi** dell'area 2: Le mie task, Lavoro di Claude per me
  (stato letto dalla vista, nessuna azione dell'area 3), Ferme nei miei
  progetti, Richieste nuove, Traguardi in arrivo, Un filtro salvato. I blocchi
  di aree non integrate (eventi e posta: area 6; automazioni: area 7; rilasci e
  assistenza: area 8) non compaiono nel catalogo né nelle Home nella build app.
- **«Da decidere»** con le richieste di decisione rivolte a me (fetta 1) e le
  **richieste da trasformare** nei progetti dove posso creare task; le voci di
  Claude, chat, posta e automazioni restano fuori finché la loro area non è
  integrata.
- **Ruoli di reparto** con il permesso `department.home.manage`, assegnabili
  dalla pagina Reparti dell'amministrazione.
- **Filtri salvati**: criteri del prototipo, vista e raggruppamento, privati o
  pubblici, pagina del filtro, «Tutti i filtri», «Salva come filtro» dalla
  barra di Tasks, fissati nella colonna, filtro come blocco della Home, ⌘K.
- Con la Home integrata, dopo il login si torna ad atterrare su **Home** (non
  più su La mia settimana, scelta temporanea della fetta 2).

## Decisioni

- **Filtri in una tabella nuova** *(maintainer, 9 nov)*: `task_filters` e
  `pinned_task_filters`; le «viste salvate» del web vecchio (`saved_views`)
  restano intatte e non si convertono; si toglieranno col web vecchio. I filtri
  pubblici di esempio del prototipo (Aperte, Chiuse questo mese, Ferme da più
  di 7 giorni, Senza stima, Senza assegnatario) si creano una volta sola nella
  migrazione (chi li elimina non li ritrova al riavvio), di proprietà di nessuno
  (`owner_id` null), modificabili solo da un full admin.
- **Ruoli di reparto senza riconferma** *(maintainer, 9 nov)*: il permesso
  decide solo la disposizione di una Home, non dà accesso a dati; si assegna da
  desktop e da web senza riconferma, e resta nel registro delle modifiche
  dell'istanza.
- **Permessi di reparto come livello nuovo** *(orchestratrice)*: registro in
  `@stubwise/shared` (accanto a istanza e progetto) con `department.home.manage`
  (gruppo e frasi en/it); tabella `department_roles(department_id, user_id,
  permissions text[])`; `departmentPermissions` in `/api/auth/me`. Claude mai,
  full admin sempre (come `canInDepartment` del prototipo).
- **Regole in UN posto** *(orchestratrice)*: `domain/home.ts` (`FIXED_BLOCKS`,
  `sameBlock`, `withFixed`, `resolveHome`) e da `domain/filters.ts`
  `periodRange`, `canUseStatusIds` e i criteri come **schema Zod condiviso**
  (`filterCriteriaSchema`, la fonte; `parseCriteria` ne è la versione
  tollerante) passano in `@stubwise/shared`. `matches` resta del finto; un test
  di parità controlla che la query del server dia gli stessi risultati di
  `matches` sui casi del prototipo.
- **Il server valida i blocchi** in scrittura (forma, fissi sempre presenti, un
  filtro deve essere visibile a chi scrive, nella Home di reparto solo filtri
  pubblici) e risponde con la Home già risolta per chi guarda. Un filtro poi
  eliminato o reso privato resta come blocco «non disponibile», come nel
  prototipo.
- **Visibilità**: un filtro pubblico mostra a ciascuno solo le task che vede
  già (stessa query di `/api/tasks`); eliminare un filtro lo toglie dai fissati
  di tutti. Modifica ed eliminazione: l'autore o un full admin.
- **Home iniziali** *(orchestratrice)*: la migrazione dà a ogni reparto
  esistente la Home d'apertura del prototipo (i blocchi dell'area 2), così
  nessuno vede una Home vuota.
- **Richieste da trasformare** lette dal server (voci di backlog nuove, in
  rifinitura o pronte, non fuse, di progetti visibili dove chi guarda ha
  `tickets.create`): servono a «Da decidere» e al blocco «Richieste nuove»;
  aprirle porta alla sezione Requests, che resta «in arrivo» fino alla fetta 4
  — la voce mostra titolo e codice e «Apri nel web» verso la voce del web
  vecchio.

## Verifica

Come le fette precedenti; tabella di parità `apps/desktop/docs/integration-slice3.md`.
