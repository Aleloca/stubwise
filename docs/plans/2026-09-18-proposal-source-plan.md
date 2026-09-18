# Piano — Far vedere cosa ha generato una proposta (18 set 2026)

Design: `2026-09-18-proposal-source-design.md`. Cinque task. **Nessuna
migrazione, nessuna colonna, nessuna rotta nuova**: un campo derivato a lettura
più una schermata che chiama una rotta che esiste già.

Chiusura: `pnpm typecheck`, `pnpm test`, **`pnpm lint` dalla radice**.

## Task 1 — L'id del messaggio nella risposta d'inbox

`readGoogle` (`apps/server/src/services/inbox.ts`) aggiunge al blocco `google`
l'id del messaggio, risolto dalla riga `email_proposals` che possiede la
notifica. `null` per il calendario e per lo smistamento.

⚠️ **Derivato a lettura, MAI scritto nell'evento.** L'evento è persistito alla
publish: un campo scritto lì ce l'avrebbero solo le card future, e quelle già
in inbox resterebbero senza per sempre. È l'errore del 17 settembre con
`reassign_project`, scoperto solo quando il maintainer ha aperto una card
vecchia. Il commento accanto al campo lo dica, o qualcuno «ottimizzerà»
spostandolo nel jsonb.

Nello schema condiviso il campo nasce `.nullable().default(null)` — CLAUDE.md,
«solo cambi additivi» — con un test che parsa una risposta senza di esso.

## Task 2 — Il blocco «cosa ha letto Stubwise» nell'app

`GoogleProposalScreen` (`apps/mobile/src/screens/inbox/`): sopra le scelte, un
blocco con l'estratto, chiesto a `GET /api/me/mail/email/:id` **solo quando la
schermata è aperta** e solo se l'id c'è.

- caricamento: uno scheletro, non un salto della pagina;
- errore o id assente: **il blocco non compare** e le scelte restano usabili —
  non sapere cosa ha letto il modello è un peccato, non poter decidere è un
  guasto;
- sotto, «apri la conversazione» che porta a MBX sul thread.

Il testo è **NON FIDATO** (lo scrive chi manda l'email): si rende come testo,
mai come markup, e si tronca a poche righe con la possibilità di espandere.

⚠️ `render` di RNTL va `await`ato; spie azzerate in `beforeEach`.

## Task 3 — Lo stesso sul web

`inbox-item.tsx` (`apps/web/src/components/`): stesso blocco, stessa regola di
degrado. ⚠️ Sul web `lib/api.ts` fa un **cast**, non un `parse`: il
`.default(null)` dello schema NON gira, quindi il campo va difeso nel punto di
lettura (`?? null`) e la fixture del test che lo copre va lasciata **senza**
quel campo apposta — è la prova che la difesa c'è.

## Task 4 — I test

1. **L'id arriva per una proposta di posta**, ed è quello giusto (asserire il
   valore, non che sia non-nullo).
2. **È `null` per calendario e smistamento**, e la schermata non mostra il
   blocco.
3. ⚠️ **Negativo, sulla privacy**: un altro utente non ottiene quel messaggio
   dalla rotta di dettaglio **e** non vede quell'id nella propria inbox. Due
   asserzioni, non una: la seconda copre il caso in cui la derivazione a
   lettura dimenticasse il filtro per utente.
4. **Card vecchia**: una notifica il cui evento non ha campi nuovi produce
   comunque l'id, perché è derivato. È la prova che l'errore del 17 settembre
   non si ripete.
5. **Degrado**: con la rotta del dettaglio che fallisce, le scelte restano
   premibili.

## Task 5 — CLAUDE.md

Voce di deploy: rebuild **server + caddy** (il server deriva il campo, il
bundle disegna il blocco; il worker non c'entra), nessuna migrazione, nessuna
env. Più una riga fra le invarianti: **i campi che i client leggono su una card
di inbox si derivano a lettura, non si scrivono nell'evento**, col caso di
`reassign_project` come esempio di cosa succede a sbagliarlo.

---

## Fuori perimetro

- **Il calendario** (design §4): non ha classificazione AI, «cosa ha letto il
  modello» non vuol dire niente.
- **L'HTML originale**: resta in «Leggi l'originale» nella conversazione, con
  la sua sanificazione e il suo iframe.
- **`messageUrl`** non si tocca.
