# Shape brief — I suggerimenti discreti «Claude can help you…»

> Shape scritto dal controller senza intervista (2 nov 2026): le domande di
> discovery non sono state fatte al maintainer (nessuno strumento di domanda
> in questa sessione). Dove design e piano non bastavano la scelta è
> marcata **scelta del controller** e numerata **[SG n]** in fondo. Valgono
> come scritte le decisioni del maintainer: Claude non agisce mai di sua
> iniziativa, la riga scrive una richiesta e non fa niente; le proposte che
> esistono già restano dove sono, e la riga non compare su un oggetto che
> ha una proposta, una domanda o un piano aperti.

Superficie:
- `tasks-ui/ClaudeSuggestionRow.tsx` — la riga;
- le cinque pagine di partenza: `pages/support/ConversationDetail.tsx`,
  `pages/releases/PrPanel.tsx`, `pages/automations/ProjectAutomations.tsx`,
  `pages/overview/OverviewPage.tsx`, `pages/admin/ai/UsagePanel.tsx`;
- `layout/claudePanel/panelEvents.ts` (`fresh`) per l'apertura del
  riquadro con una conversazione nuova.

Piano 10b: Task 12. Spec area 10: parte 8 tutta, S6 (l'ingresso dalla
riga). Mondo: «Catalogo numerato», modalità **Operate**.

## 1. Lavoro e pubblico

- **Chi**: chi lavora sulle cinque pagine e **può** fare ciò che la riga
  propone: Davide su una conversazione che aspetta il team; Laura su una
  PR senza note o sulla sezione Automations vuota di ACQ; Giulia
  sull'Overview di un suo progetto con task ferme; Roberta su Consumi.
- **Quando**: arriva sulla pagina per fare il suo lavoro, non per Claude.
  La riga deve farsi notare **solo da chi la cerca**.
- **Stato d'animo**: sospetto verso un assistente che interrompe. La riga
  deve essere più quieta di qualunque altra cosa sulla pagina, e sparire
  con un clic per sempre.

## 2. Esito e prova

- **Successo**:
  - Davide apre `ACQ-S2` (aspetta il team): sotto la testata, una riga
    «◌ Claude can help you write the reply · Not now». Clic: si apre il
    riquadro con una conversazione **nuova**, nella casella «Write the
    reply to ACQ-S2», non inviata, col fuoco in fondo al testo. Invio: la
    bozza arriva nel campo col segno (S6);
  - Sara apre `ACQ-S2`: nessuna riga (non ha `support.reply`);
  - Laura su una PR con un piano in attesa sulla task: nessuna riga;
  - «Not now»: la riga sparisce, e non torna ricaricando la pagina.
- **Verità del prodotto**:
  - **la riga scrive, non agisce**: niente parte senza l'Invio della
    persona;
  - **solo ciò che si può fare**: nessun «Who?» in una riga, mai una riga
    che porta a un rifiuto;
  - **la riga non nomina niente di invisibile**: solo l'oggetto della
    pagina, che chi guarda sta già vedendo.

## 3. Direzione scelta

- **Tesi**: **una nota a margine, non un invito**. Una riga di testo
  13px, senza fondo, senza bordo, senza icona colorata: l'anello di Claude
  fermo 12px in `ink-faint` e una frase in `ink-muted`. È la cosa meno
  forte della pagina sotto il titolo; chi non la cerca la legge come una
  riga meta **[SG 1]**.

### 3.1 La riga (`ClaudeSuggestionRow`)

- **Forma**: altezza 28px, 13px. A sinistra l'anello fermo 12px
  `ink-faint` (`aria-hidden`). Poi un **bottone testo**: «Claude can help
  you » in `ink-muted` + il compito in `ink` («write the reply»); al
  passaggio e al fuoco tutto il bottone passa a `ink` con sottolineatura.
  A destra, separato da 12px, «Not now» / «Non ora» bottone testo 12px
  `ink-faint`.
- **Nome accessibile** del bottone: la frase intera, più
  `aria-describedby` «Opens Claude with the request written, not sent.» /
  «Apre Claude con la richiesta scritta, non inviata.» (il `title` dice lo
  stesso).
- **Le cinque righe**:

| Luogo | Quando | Riga (en / it) | Richiesta scritta (en / it) |
|---|---|---|---|
| conversazione di supporto | `waiting_us`, con `support.reply` | Claude can help you write the reply / Claude può aiutarti a scrivere la risposta | Write the reply to ACQ-S2 / Scrivi la risposta ad ACQ-S2 |
| PR nella coda di rilascio | senza note, con `canEditReleaseNotes`; mai con un piano in attesa o una domanda aperta sulla task della PR | Claude can help you write the release notes / Claude può aiutarti a scrivere le note di rilascio | Write the release notes / Scrivi le note di rilascio |
| Automations del progetto | nessuna automazione nel progetto, con `automations.manage` | Claude can help you build an automation for ACQ / Claude può aiutarti a costruire un'automazione per ACQ | Build an automation in ACQ: when ␣ / Costruisci un'automazione in ACQ: quando ␣ |
| Overview del progetto | task ferme; mai con una proposta del polso aperta sul progetto | Claude can help you understand why ACQ is stalled / Claude può aiutarti a capire perché ACQ è fermo | Which tasks are stalled in ACQ, and why? / Quali task sono ferme in ACQ, e perché? |
| Consumi (`usage.view`) | sempre | Claude can help you summarize this month's spend / Claude può aiutarti a riassumere la spesa del mese | How much have we spent on AI this month? / Quanto abbiamo speso in AI questo mese? |

- La richiesta delle automazioni **finisce aperta** («when » con lo spazio)
  e il cursore sta lì: la persona scrive l'evento **[SG 2]**.
- La richiesta dell'Overview deve essere riconosciuta dal motore di S2
  ristretto al progetto (il Task 6 la copre, *(ruling del controller (pre-flight), P16)*); se il Task 6 non la copre, la richiesta diventa
  «Which projects are stalled and why?» / «Quali progetti sono fermi e
  perché?» e la riga resta uguale **[SG 3]**.
- Tutti i testi in seconda persona, con il solo codice dell'oggetto della
  pagina.

### 3.2 Dove sta: «sotto la testata»

| Pagina | Testata | La riga sta | Altre righe sotto la testata |
|---|---|---|---|
| conversazione di supporto | codice + nome, riga meta (canale, stato, «Customer preview») | subito sotto la riga meta, sopra il riquadro della richiesta | nessuna oggi |
| pannello della PR (360) | `repo#n` · «Open on GitHub», titolo, autore, task collegata | sotto la task collegata, sopra «Claude's analysis» | — |
| Automations del progetto | h1 «Automations» + «New automation» | sotto la riga dell'h1, sopra «Runs in progress» o lo stato vuoto | — |
| Overview | h1 «Overview» + riga di polso in prosa | sotto la riga di polso, sopra «Stalled» | la riga di polso |
| Consumi | h1 «AI» + schede | sotto le schede, sopra la scelta del periodo | — |

- **Convivenza**: la riga viene **dopo** ogni riga che la pagina ha già
  sotto la testata (polso, avvisi, fasce di sola lettura, «Prototype
  only», coda in pausa) e **prima** del contenuto. Una fascia d'avviso
  resta più forte: la riga non ha fondo e non sale mai sopra un avviso
  **[SG 4]**.
- **Budget mensile esaurito** (9b): **nessuna riga**, su nessuna pagina: il
  riquadro non potrebbe rispondere **[SG 5]**. Coda in pausa: la riga c'è
  (il riquadro funziona).
- **Al massimo una** per pagina: ogni luogo ha una sola riga possibile, e
  le pagine non si sovrappongono (il pannello della PR sta sulla sezione
  Releases, che non ha righe sue).

### 3.3 Il clic

- Apre il riquadro di Claude (10a) con una **conversazione nuova**
  (`fresh`): la conversazione di prima resta in Claude → Mine. Il chip
  dice la pagina («ACQ-S2 · support conversation»).
- La richiesta va nella casella, **non inviata**, col cursore in fondo; il
  fuoco va nella casella. Se il riquadro era aperto con testo non inviato,
  quel testo resta nella conversazione di prima (la sua casella) **[SG 6]**.
- La riga **resta** sulla pagina dopo il clic (non è un «Not now»); con il
  riquadro aperto è ancora cliccabile e apre un'altra conversazione nuova.
- Niente parte: Invio è della persona.

### 3.4 «Not now»

- Nasconde la riga subito (altezza a zero in 150ms; nulla con movimento
  ridotto). Il fuoco va all'elemento successivo della pagina, o all'h1 se
  non c'è.
- Si ricorda in `localStorage` con la chiave
  `stubwise.claudeSuggestion.<personId>.<luogo>`, dentro try/catch. Il
  luogo è **l'oggetto**: `support:<conversationId>`, `pr:<prId>`,
  `automations:<projectId>`, `overview:<projectId>`, `usage` **[SG 7]**.
- Senza archivio (lancia, modalità privata): la riga sparisce lo stesso e
  torna al prossimo ingresso nella pagina. Nessun errore a schermo.
- Nessun modo, nel prototipo, di far tornare le righe nascoste oltre a
  svuotare l'archivio del browser (o il reset del prototipo, che lo
  svuota) **[SG 8]**.

```
1440 ── Overview di ACQ (Giulia) ────────────────────────────────────────
│ Overview                                                              │
│ Waiting on you · Claude working · 3 stalled · next: Launch · Nov 14   │
│ ◌ Claude can help you understand why ACQ is stalled        Not now    │
│ Stalled  3                                                            │
│ ACQ-14 Fix bill download · waiting for an answer to Claude · 12 days  │
```

```
1024 ── pannello della PR sovrapposto (400) ───────
│ acq/site#42 · Open on GitHub ↗                  │
│ Export bookings to CSV                          │
│ by Marco Rossi · opened Oct 25 · feat → main    │
│ Task ACQ-12 Export bookings                     │
│ ◌ Claude can help you write the       Not now   │
│   release notes                                 │
│ CLAUDE'S ANALYSIS …                             │
```

## 4. Ambito e confini

- **Dentro**: la riga nelle cinque pagine, i suoi criteri, il clic, «Not
  now», la convivenza con le righe sotto la testata.
- **Fuori**: altre pagine (le aggiunge una scelta successiva con i suoi
  criteri); ciò che succede dopo l'Invio (gli scenari).
- **Anti-obiettivi**:
  - una riga che manda qualcosa da sola, o che apre il riquadro senza un
    clic;
  - un «Who?», o una riga per chi non può farlo;
  - una riga accanto a una proposta, una domanda o un piano aperti;
  - una riga con fondo, bordo, colore o movimento che la renda più forte
    di un avviso;
  - due righe sulla stessa pagina;
  - un codice o un nome che chi guarda non vede.

## 5. Stati e intervalli

- **Lunghezza**: la riga più lunga in it («Claude può aiutarti a
  riassumere la spesa del mese») sta su una linea a 1440; nel pannello
  della PR va a capo su due, con «Not now» sulla prima linea a destra.
- **Caricamento**: la riga arriva con i dati della pagina
  (`useClaudeSuggestion` nella stessa ondata delle query della pagina) e
  si disegna insieme al contenuto, senza scheletro. Se arriva dopo, compare
  senza animazione e sposta il contenuto di 28px una volta sola: meglio di
  uno spazio vuoto riservato a una riga che spesso non c'è **[SG 9]**.
- **Errore** della lettura: nessuna riga, nessun messaggio.
- **Cambi di stato sulla pagina**: la conversazione riceve una risposta
  (non aspetta più il team) → la riga sparisce al prossimo aggiornamento;
  la PR riceve le note → sparisce; nasce una proposta del polso →
  sparisce.
- **Vedi come**: la riga si ricalcola per la persona nuova; «Not now» è
  per persona.
- **Istanza vuota**: nessuna riga.

## 6. Interazione e layout

- **1440**: una linea, «Not now» allineato al bordo destro della colonna di
  contenuto (non della finestra).
- **1024**: come a 1440 nelle pagine larghe; nel pannello della PR
  (sovrapposto, 400) la frase va a capo.
- **Tastiera**: la riga è nell'ordine di Tab dopo i comandi della testata;
  Invio sul bottone apre il riquadro; «Not now» è un secondo punto di Tab.
  Nessuna scorciatoia propria.
- **Annunci**: nessuno all'arrivo (non deve interrompere chi usa uno
  screen reader); dopo «Not now», `polite` «Suggestion hidden.» /
  «Suggerimento nascosto.».

## 7. Vincoli

- **Dove compare «Who?»**: mai.
- **Dove compare +R**: mai.
- **Voci del registro**: nessuna. Né la riga, né il clic, né «Not now»
  scrivono dati; la conversazione nuova nasce solo all'invio, come ogni
  conversazione del riquadro.
- La pagina non decide: `suggestionFor(me, place)` dice se c'è la riga e
  quale; nessun `can()` nelle cinque pagine per questo.
- `localStorage` solo per «Not now», sempre in try/catch, mai per altro.
- Testi en/it con parità; il codice dell'oggetto in cifre tabellari.

## Scelte del brief (scelte del controller, da confermare)

1. **[SG 1]** La riga è testo senza fondo, con l'anello fermo in
   `ink-faint`.
2. **[SG 2]** La richiesta delle automazioni finisce con «when » e il
   cursore lì.
3. **[SG 3]** La richiesta dell'Overview è ristretta al progetto, se il
   motore la riconosce.
4. **[SG 4]** La riga sta dopo ogni altra riga sotto la testata.
5. **[SG 5]** Nessuna riga col budget mensile esaurito.
6. **[SG 6]** Il testo non inviato della conversazione di prima resta lì.
7. **[SG 7]** «Not now» vale per l'oggetto (questa conversazione, questa
   PR, questo progetto), non per tutte le pagine dello stesso tipo.
8. **[SG 8]** Nessun «mostra di nuovo i suggerimenti» nelle Preferenze.
9. **[SG 9]** Niente scheletro e niente spazio riservato: se la riga
   arriva in ritardo, sposta il contenuto una volta.

## Scelte confermate (2 nov 2026)

1. **[SG 7]** *(confermata dal maintainer il 2 nov 2026)*: «Not now» /
   «Non ora» vale solo per quell'oggetto (questa conversazione, questa PR,
   questo progetto, o Consumi), con la chiave
   `stubwise.claudeSuggestion.<personId>.<luogo>` e il luogo come nel §3.4.
2. Le altre scelte di questo brief sono approvate col brief.
