# Shape brief — Pannello del thread e @Claude

Superficie: `pages/chat/ThreadPanel.tsx`, aperto da `?thread=<messageId>`
sopra qualunque canale (Chat globale o sezione Chat del progetto) e dalle
viste Threads, Mentions, ricerca, notifiche e «Da decidere». Piano: Task 3,
5. Spec: area 4 «Messaggi» (thread), «@Claude». Mondo: «Catalogo
numerato», modalità **Operate**. Le schede (proposta, domanda) e le righe
d'azione sono quelle di `conversation.md`, invariate. **[ASSUNZIONE]** =
da confermare.

## 1. Lavoro e pubblico

- Chi risponde a un messaggio senza riempire il canale; chi segue una
  discussione nata da un messaggio; chi chiama **@Claude** per spiegare,
  riassumere o preparare un cambiamento sul progetto.
- Stato d'animo: concentrato su **una** cosa, con il canale ancora sotto
  gli occhi a sinistra. Chi chiama Claude è responsabile di ciò che Claude
  pubblica: deve sapere che agisce come lui.

## 2. Esito e prova

- Azione primaria: rispondere nel thread; per chi ha chiamato Claude,
  confermare (o no) la sua proposta.
- Successo: si capisce a colpo d'occhio chi ha chiamato ogni risposta di
  Claude; il bottone «Confirm» lo vede solo chi l'ha chiesta; la risposta
  di Claude cresce dal vivo senza che il pannello salti.
- Verità del prodotto: ogni «@Claude» è una chiamata nuova con i permessi
  di chi la scrive; Claude legge il thread come contesto; senza «@Claude»
  non risponde; gli scambi sono messaggi della Chat, non conversazioni
  della destinazione Claude.

## 3. Direzione scelta

- **Tesi**: lo stesso slot del dettaglio della task (pannello a destra con
  filetto sinistro, nessuna ombra quando agganciato), ma con il flusso
  della chat dentro: radice in testa, risposte sotto, casella in fondo. Le
  risposte di Claude usano la resa della conversazione nel suo formato da
  pannello (nome in riga, gruppi d'azione chiusi, bottoni a capo).
- **Larghezza**: 400px agganciato da 1200px; sotto, sovrapposto 400px con
  velo come il dettaglio della task **[ASSUNZIONE: 400 e non 360, perché
  le schede proposta e i blocchi di codice a 360 vanno a capo troppo]**.
- **Testata** 48px: «Thread» 16px 600 + «in AUD · general» 13px muted
  (link al canale, utile quando il pannello è aperto da Mentions), a
  destra «⋯» (Copy link, Follow/Unfollow thread **[ASSUNZIONE]**, Mark
  unread) e ×. Filetto.
- **Radice**: il messaggio intero, con reazioni e citazioni; poi un
  filetto con etichetta a sinistra «4 replies».
- **Risposte**: stesso raggruppamento autore/5 minuti del canale, avatar
  24px, testo 14px.
- **Risposta di Claude**: avatar CL con l'anello tratteggiato (pulsa mentre
  scrive), riga «Claude · called by Giulia Ferri · 10:42» (il chiamante
  sempre in parole, mai solo un avatar); testo che cresce con il cursore
  sottile; righe d'azione in un gruppo chiuso «▸ 3 actions · Read AUD-91,
  searched AUD docs»; citazioni e «Used: …» come nella conversazione;
  schede proposta/domanda sotto il testo.
- **Momento focale**: per il chiamante, la scheda «Claude proposes» con
  **Confirm**; per gli altri, la stessa scheda in sola lettura «Proposal
  for Giulia Ferri».

```
┌─ AUD · general (flow) ─────────────┬ Thread  in AUD · general    ⋯  × ┐
│ …                                   │ (EM) Elena Moretti · 09:14       │
│ (EM) Elena Moretti · 09:14          │ Can we move AUD-91 Price list    │
│  Can we move AUD-91 Price list      │ sync to next week?               │
│  sync to next week?                 │ ── 2 replies ─────────────────── │
│  (GF)(CL) 2 replies · last by Claude│ (GF) Giulia Ferri · 09:20        │
│                                     │ @Claude plan it for W45 with     │
│                                     │ Marco                            │
│                                     │ (CL) Claude · called by Giulia   │
│                                     │ ▸ 2 actions · Read AUD-91        │
│                                     │ Marco has room in W45. I can:    │
│                                     │ ┌ ● Claude proposes · 1 change ─┐│
│                                     │ │ Plan AUD-91 · Marco Bellini · ││
│                                     │ │ W45 · M                       ││
│                                     │ │        [Edit] [Cancel][Confirm]││
│                                     │ └───────────────────────────────┘│
│                                     │ ┌───────────────────────────────┐│
│                                     │ │ Reply…                        ││
│                                     │ │ ☐ Also send to AUD · general  ││
│                                     │ │ [📎]                    [Send]││
└─────────────────────────────────────┴─┴───────────────────────────────┴┘
```

## 4. Ambito e confini

- Dentro: pannello agganciato/sovrapposto, radice, risposte, casella con
  «Also send to …», risposte di @Claude in diretta con righe d'azione,
  proposte, domande, eliminazione da parte del chiamante, segna letto,
  stati del messaggio (gli stessi del canale).
- Fuori: il flusso del canale (`chat.md`); la destinazione Claude e la sua
  pubblicazione (un thread non si «rende pubblico»: è già del canale).
- Anti-obiettivi: un «Confirm» visto da chi non ha chiamato; una risposta
  di Claude senza il nome del chiamante; Claude che risponde a un
  messaggio senza «@Claude»; le risposte di Claude nel flusso del canale.

## 5. Stati e intervalli

- Volumi: 1–~300 risposte (finestra di 50, «Load earlier» in alto, apre in
  fondo o sulla riga «New replies»); più risposte di Claude nello stesso
  thread, chiamate da persone diverse.
- **Claude al lavoro**: dopo l'invio di un messaggio con «@Claude» compare
  subito la risposta vuota con anello e «Claude · called by Giulia Ferri ·
  thinking…»; poi testo in diretta. Nel canale la riga del thread dice
  «Claude is replying…» con l'anello.
- **Ferma**: solo il chiamante vede «Stop» (testo 13px) nella riga della
  risposta mentre Claude lavora; l'esito diventa «Stopped by Giulia
  Ferri» **[ASSUNZIONE: lo spec non lo dice; «Ferma e scrivi» non serve,
  basta scrivere un'altra chiamata]**.
- **Fallita**: «Claude couldn't finish: <motivo>» in critico + «Try again»
  solo per il chiamante (rifà la stessa chiamata come messaggio nuovo)
  **[ASSUNZIONE]**. Quota esaurita: «Claude isn't available right now:
  the account's limit was reached» per tutti.
- **Proposta**: come `conversation.md` (righe catalogo, una/più azioni,
  Confirm / Confirm all / Edit / Cancel), visibile a tutti; i bottoni solo
  al chiamante. Esiti in luogo dei bottoni, visibili a tutti: «Done ·
  AUD-96 created», «Cancelled by Giulia Ferri», «Not carried out ·
  expired» (dopo 20 messaggi del thread o 24 ore), «Couldn't do it: you
  can no longer edit tasks in AUD. Nothing was changed.».
- **Domanda di Claude** al chiamante durante un lavoro avviato dalla chat:
  scheda «Claude asks Giulia Ferri» nel thread; risponde solo lei, gli
  altri leggono «Waiting for Giulia Ferri»; la stessa domanda è in «Da
  decidere» e rispondere in un posto chiude l'altro.
- **Visibilità per chi legge**: il testo di Claude è uguale per tutti
  (il chiamante se ne assume la responsabilità), ma le citazioni seguono
  R-E9 per ciascun lettore: codice ink-faint senza nome se non lo vede.
- **Eliminazione**: un messaggio proprio come nel canale; una risposta di
  Claude solo dal chiamante («Delete Claude's reply»), che diventa
  «Message deleted»; una proposta ancora aperta in quella risposta decade
  con lei, senza esito mostrato **[ASSUNZIONE]**.
- **Radice eliminata**: «Message deleted» in testa, risposte intatte; la
  casella resta. **Canale archiviato**: thread in sola lettura con la
  stessa fascia del canale. **Non membro di un aperto**: fascia «Join
  channel to reply».
- Thread inesistente o non leggibile (link vecchio, cambio persona): il
  pannello non si apre e compare un toast «This thread doesn't exist or
  you can't see it»; il parametro si toglie dall'URL.
- Caricamento: radice + 3 righe scheletro. Errore: «Couldn't load this
  thread» + «Retry».

## 6. Interazione e layout

- Si apre da «N replies», da «Reply in thread» (fuoco nella casella), dal
  menu e da ogni rimando esterno; il messaggio radice nel canale prende la
  tinta di selezione (ink 10%) finché il pannello è aperto. Esc chiude e
  ridà il fuoco al messaggio radice.
- **Casella**: lo stesso `Composer`, segnaposto «Reply…», più la casella
  «Also send to AUD · general», spenta di default e rispenta dopo ogni
  invio **[ASSUNZIONE]**.
- **Scrivere «@Claude»**: appena il gettone entra nella casella, sotto
  compare una riga 12px muted «Claude will act as you and reply here,
  visible to everyone in AUD · general.» — la responsabilità detta prima
  dell'invio, senza dialogo **[ASSUNZIONE]**.
- **@Claude nel canale**: un messaggio radice con «@Claude» resta nel
  canale; la risposta nasce nel suo thread e, **per il chiamante**, il
  pannello si apre da solo su quel thread **[ASSUNZIONE]**.
- **Letto**: il thread si segna letto quando il fondo è visibile per
  almeno un istante (nessun bottone necessario); «Mark unread» nel «⋯».
  Riga «New replies» con la stessa resa della riga «New» del canale.
- **Seguire**: chi scrive o è menzionato nel thread lo segue; i thread
  seguiti con risposte nuove finiscono in «Threads» **[ASSUNZIONE]**.
- Scorrimento: segue il fondo mentre Claude scrive solo se eri in fondo;
  altrimenti pillola «New replies ↓».
- Sovrapposto (< 1200px): velo `scrim`, × e Esc chiudono, fuoco
  intrappolato nel pannello.
- Movimento: ingresso del pannello 200ms da destra; schede che si
  riducono a esito 200ms; anello fermo con movimento ridotto.

## 7. Vincoli e decisioni aperte

- Chi ha chiamato, chi può confermare, chi può fermare ed eliminare
  arriva dal livello dati (`calledById`, richiedente della proposta),
  mai dedotto dal testo.
- `aria-live="polite"` per la risposta di Claude finita (non per i
  frammenti); «assertive» per una scheda che chiede al lettore.
- Cambio di persona: il pannello si chiude e la bozza della risposta si
  perde.
- Claude legge solo il thread (radice + risposte) leggibile dal
  chiamante; non legge il resto del canale **[ASSUNZIONE]**.
