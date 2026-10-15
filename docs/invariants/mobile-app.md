# Invarianti e trappole — App mobile (UI e test)

> Estratto da `CLAUDE.md` (14 ott 2026) per tenerlo sotto il limite di
> dimensione: il contenuto è invariato. I rimandi «sopra»/«sotto», «qui sopra»
> e «vedi la voce …» si riferiscono alla struttura originale: le voci di
> deploy stanno in `docs/operations/deploy-log.md`, le invarianti trasversali
> in `CLAUDE.md` (sezione «Invarianti e trappole»), quelle per area in
> `docs/invariants/*.md`.

- **Nell'app la ricerca è un'AZIONE, non una destinazione — e i repository
  non ci sono (15 set 2026, design §3).** Vive in `ScreenHeader`, quindi è
  raggiungibile da ogni schermata che lo usa, e **non** aggiunge una sesta
  scheda: le cinque sono INB/PRJ/WISEY/BLG/AGT. Erano INB/PRJ/BLG/DOC/MBX,
  «decise per tutte le fasi»
  (`docs/plans/2026-09-11-app-navigation-architecture-design.md`), finché il
  25 set 2026 il maintainer ha deciso altrimenti: DOC è uscita per far posto
  a Wisey al centro, e la documentazione si raggiunge dall'hub del progetto e
  dalla ricerca («Wisey, anteprima nell'app» §3). Poi, il 9 ott 2026, MBX ha
  lasciato il posto ad AGT, le sessioni degli agenti
  (`docs/plans/2026-10-08-agent-sessions-design.md` §8.1): posta e
  calendario si aprono dal profilo (le Impostazioni), e il loro stack sta sul
  ROOT stack (`RootStackParamList.Mail`), sopra le schede. I deep link
  `mail/…` e `calendar/…` non cambiano, cambia dove atterrano; la config di
  linking ha `initialRouteName: "Main"`, così un link a freddo mette le schede
  SOTTO la posta e l'indietro ci torna. Il foglio
  è montato SOLO quando è aperto, e non per performance: usa
  `useNavigation`, e tenerlo montato significherebbe un `Modal` e un hook di
  navigazione su ogni schermata dell'app, sempre.
  **I repository sono l'unico gruppo del web che l'app non mostra**, ed è
  deliberato: non esiste una schermata dei repository, quindi un risultato lì
  sarebbe una riga che non porta da nessuna parte — e «premibile solo se c'è
  davvero un dettaglio da aprire» è già la regola di questa app (vedi
  `EventRow` in `CalendarPanel`). Chi aggiungesse quella schermata aggiunga
  anche il gruppo; chi aggiunge il gruppo prima della schermata sta
  offrendo un tap che non fa niente.
  La ricerca dentro DOC **non c'è più**, ed è una perdita da conoscere: era
  un'altra cosa dalla globale, filtrava QUELLA documentazione (passava
  `repositoryId`), ed è uscita col tab il 25 set 2026. La documentazione di
  un progetto si SFOGLIA dalla sua pagina Docs nell'hub
  (`ProjectDocsScreen`, che non ha una ricerca sua) e si CERCA dalla ricerca
  globale, il cui gruppo `docs` apre la pagina dentro la scheda Progetti.
  Chi volesse riavere la ricerca per spazio la metta in `ProjectDocsScreen`,
  non in un tab.
- **La pagina del ticket nell'app è a quattro tab** (2 ott 2026,
  `docs/plans/2026-10-02-app-ticket-tabs*.md`): Stato, Contenuto, Attività,
  Dettagli. Ogni tab è una ScrollView **sempre montata** e nascosta con
  `display: none`, così conserva lo scorrimento: non va resa con
  `{tab === "x" && …}`. Tutte gestiscono la tastiera; il pull-to-refresh sta
  solo su quella attiva. Il pallino di Stato lo decide `statusNeedsViewer`
  (`apps/mobile/src/lib/ticket-tabs.ts`), che legge le azioni offerte da
  `actionsOf` — la STESSA regola dei bottoni, mai una copia. La card della PR
  spezza la frase del web con `prCycleCardFor`: la parità sui pezzi
  (`CARD_PIECES` in `pr-cycle.test.ts`) legge i cataloghi del web e l'output
  vero della funzione. L'effetto che sceglie la tab dipende dall'IDENTITÀ di
  `route.params`, non dal valore di `tab`: un secondo navigate con gli stessi
  valori deve riportare sulla tab chiesta. Nei test, le query di default di
  RNTL non trovano le tab nascoste: si preme la tab, e
  `includeHiddenElements` serve solo a verificare cosa NON c'è nei pannelli
  nascosti.
  **«Open» di una card d'inbox di un ticket apre il ticket NELL'APP**
  (`openActionFor`, `lib/open-ticket.ts`, sulla tab di `ticketTabForKind`;
  senza `ticketId` resta il link), e lo apre **dentro lo stack dell'Inbox**
  (5 ott 2026): `Ticket` sta in `TicketParamList`, incluso in
  `InboxCardParamList`, quindi esiste in ogni stack che ha la card. Prima
  apriva lo stack Projects sopra l'ultima pagina rimasta aperta lì, e
  «indietro» finiva su un altro progetto invece che sull'inbox.
- **Un foglio nativo che porta a un'altra schermata: chiudere, smontare,
  POI navigare (5 ott 2026, verificato sul telefono).** Con
  `@lodev09/react-native-true-sheet` (`SheetModal`) due errori danno lo
  stesso sintomo — il foglio resta a schermo, immobile, e non si scorre più:
  (1) smontare il componente mentre il pannello è ancora PRESENTATO (iOS
  resta con un `UISheetPresentationController` senza contenuto React), e (2)
  navigare verso un'altra SCHEDA nello stesso istante in cui lo si smonta (la
  scheda di partenza viene congelata col foglio ancora disegnato). La forma
  giusta è quella della ricerca globale: il risultato chiude solo il pannello
  (`open` falso), il genitore lo smonta in `onDidDismiss` e la navigazione
  parte in un `useEffect` del genitore, dopo il commit che l'ha tolto
  (`GlobalSearchSheet` + `ScreenHeader`). ⚠️ Il mock Jest di true-sheet
  (`jest.setup.ts`) chiude in modo SINCRONO e non riproduce nessuno dei due
  casi: un test verde qui non prova niente, la verifica è sul telefono.
- **⚠️ Nei test dell'app `render` di `@testing-library/react-native` si
  ASPETTA** (`await render(...)`), come fa ogni test di questo repo. Non è
  cosmetica: con React 19 un `render` non atteso torna un oggetto SENZA
  query, e i sintomi sono fuorvianti — `screen` dice «render function has not
  been called» e la view non ha `getByText`, come se il componente non fosse
  mai stato montato, senza nessun errore in console. Costato mezz'ora il 15
  set 2026.
  Nella stessa famiglia: un `jest.mock` di `@react-navigation/native` **deve**
  fare lo spread di `requireActual`. Sostituirlo per intero lascia
  `undefined` al posto delle export che `app/providers` usa da quel modulo, e
  il sintomo è lo stesso — un albero che non monta, senza un errore che lo
  dica.
