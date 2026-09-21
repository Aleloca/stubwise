# Piano — Far vedere ciò che è fermo (21 set 2026)

Design: `2026-09-21-stalled-work-design.md`. Cinque task. Nessuna migrazione:
tutto si deriva da dati che ci sono già.

Chiusura: `pnpm typecheck`, `pnpm test`, **`pnpm lint` dalla radice**.

## Task 1 — La definizione, in un posto solo

Il criterio del §3 — non chiuso, senza job vivo, senza PR aperta, senza
domanda in sospeso — va scritto **una volta**, in
`packages/notifications/src/project-pulse-summary.ts`, che è dove vivono i tre
secchi. ⚠️ Una prima stesura diceva `project-signals.ts`: package giusto, file
sbagliato — lì stanno i segnali del **pulse proattivo** (`isProjectIdle`,
`listCandidates`), un'altra cosa.

⚠️ **Non ricopiarlo in SQL da qualche altra parte.** Il repo ha già due casi
in cui la stessa regola vive in due lingue e vanno tenute d'accordo a mano
(`isReadyForProposal` + la query del propose phase): funziona solo perché è
documentato con insistenza. Qui non serve: si aggiunge al calcolo esistente.

La funzione dice anche **perché** è ferma (design §3): `to_prepare`,
`plan_ready_never_started`, `interrupted`, `review_without_pr`. Sono quattro
casi distinti, non un'etichetta generica: `interrupted` è il peggiore ed è
quello che oggi non compare da nessuna parte.

## Task 2 — Il quarto secchio nella risposta

`projectPulseSchema` guadagna `stalled`, con: numero e titolo del ticket,
`stalledSince` (data dell'ultimo movimento), il motivo del Task 1.

`.default([])` — CLAUDE.md, «solo cambi additivi»: l'app si aggiorna dagli
store, e un'app nuova contro un server più vecchio deve reggere l'assenza. Col
test che parsa una risposta **senza** il campo.

⚠️ **I giorni li calcola il CLIENT dalla data, non il server.** Un numero
calcolato a monte invecchia dentro una risposta in cache e mostra «da 3
giorni» su una pagina aperta da una settimana.

## Task 3 — Le PR aperte, in un campo A SÉ (RISCRITTO)

I ticket `in_review` **con** PR aperta (4 su 10 oggi) non vanno in `stalled`.
⚠️ E **non** in `waitingForYou`, come diceva la prima stesura: quel campo
esige un `notificationId`, e una PR in attesa di merge non ha una notifica —
vedi il §3 del design per le tre uscite e perché due sono chiuse.

`projectPulseSummarySchema` guadagna un campo **nuovo**, additivo,
`.default([])`: ticket, numero, titolo, URL della PR e `canMerge` — **calcolato
lato server** col controllo di ruolo, mai dedotto dal client. Il client lo
rende sotto «aspetta te» quando `canMerge`, sotto «aspetta altri» quando no.

Il test resta quello: stesso progetto, stessi dati, due ruoli → la stessa PR
compare in due posti diversi. È la verifica che il divieto dell'operatore vale
anche **in lettura** e non solo sulle rotte.

Test: stesso progetto, stessi dati, due ruoli → la stessa PR compare in due
secchi diversi. È la verifica che il divieto è rispettato **in lettura** e non
solo sulla rotta.

## Task 4 — La vista nell'app e sul web

Sotto i tre secchi esistenti, «FERMO · N», ordinato dal più vecchio, ogni voce
con giorni e motivo, che apre il ticket. Nessuna soglia che nasconde (§4).

Se `stalled` è vuoto il blocco **non compare**: un «FERMO · 0» è rumore su una
schermata che deve dire cosa fare.

⚠️ Sul web `lib/api.ts` fa un cast e non un parse: il `.default([])` non gira,
difesa nel punto di lettura e fixture del test lasciata senza il campo.
⚠️ Nell'app `render` di RNTL va `await`ato.

## Task 5 — CLAUDE.md

Voce di deploy: **server + caddy** (il calcolo sta nel server, il bundle lo
disegna), nessuna migrazione, nessuna env. Più una riga sull'invariante dei
due divieti dell'operatore: ora è rispettata anche **in lettura**, non solo
sulle rotte di scrittura, e il Task 3 è il test che lo prova.

---

## Fuori perimetro

- Notifiche nuove, elenchi filtrabili, soglie configurabili (design §5).
- `/release` non si tocca.
