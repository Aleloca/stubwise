# Una card chiusa deve dire PERCHÉ (21 set 2026)

## §1 — Il problema

Sulla pagina Posta e nell'app, una proposta chiusa si legge **«ignorata»** —
qualunque sia il motivo per cui è finita lì. Ma `ignored` copre casi che non
hanno niente in comune:

| `outcome.type` | cosa è successo davvero |
|---|---|
| `null` | il classificatore non ha trovato niente da proporre |
| `reassigned_to` | **l'hai spostata tu** su un altro progetto |
| `reassign_failed` | la rigenerazione è fallita (guasto tecnico) |
| `reassign_no_signal` | spostata, ma su quel progetto non c'era nulla da proporre |
| `superseded_in_thread` | superata da un messaggio successivo dello stesso scambio |
| `declined` (calendario) | hai rifiutato l'invito su Google |
| `triage_dismissed` | hai detto «nessuno di questi» allo smistamento |

Le prime due righe sono la distanza del problema: *«non c'era niente»* e
*«l'hai spostata tu»* si leggono **identiche**. E `reassign_failed` — un
guasto — si legge come una scelta.

**Perché conta ora**: da novembre chi userà questa pagina non ha scritto il
codice né la mail. «Ignorata» su una card che invece è fallita è
un'informazione sbagliata, non una mancante: porta a non riprovare.

## §2 — La decisione: si cambia la LETTURA, non lo stato

`email_proposals.status` resta `ignored` per tutti questi casi, e va bene:
**lo stato dice cosa si può ancora fare con la riga** — qui sempre la stessa
cosa, riproporre — **e l'esito dice perché ci è arrivata**. È la forma già
scelta due volte (`declined`, `superseded_in_thread`), ed evita di pagare un
valore nuovo in `mailItemStatusSchema`, che l'app già installata legge.

**Il dato è già esposto**: `outcome` è nella risposta di `/api/me/mail`
(`mailItemSchema.outcome`, `.nullable().default(null)`). Nessuna rotta nuova,
nessun campo nuovo, nessuna migrazione: **solo client**.

## §3 — Regole di resa

1. **Si mappa `outcome.type` a un'etichetta i18n**, accanto allo stato, non al
   posto suo: «Ignorata · spostata su Carelli» dice due cose vere, «Spostata»
   da sola perderebbe che la riga è chiusa.
2. ⚠️ **Un tipo sconosciuto NON deve rompere né sparire**: si mostra lo stato
   nudo, come oggi. Non è teorico — in produzione ci sono 29 righe con
   `bulk_closed_automated`/`bulk_closed_stale_routing`, esiti che **nessun
   codice produce**: li ho scritti io a mano chiudendo l'arretrato del 17
   settembre. Un `Record` esaustivo qui andrebbe in crash sul dato vero.
3. **`reassign_failed` si distingue a vista** dagli altri: è l'unico che
   segnala un guasto, ed è l'unico su cui «Riproponi» è la risposta giusta.
4. **Nessuna prosa generata**: tutte le etichette da template i18n, come il
   registro decisioni. Il nome del progetto in `reassigned_to` si risolve
   dall'elenco progetti, e se non si risolve si scrive l'etichetta senza nome
   invece di mostrare un UUID.

## §4 — Cosa NON si fa

- **Non si aggiungono stati**: vedi §2.
- **Non si tocca il server**: il dato c'è già.
- **Non si mappano gli esiti delle card ANDATE A BUON FINE** (`backlog_item`,
  `milestone_created`, `commented`…): lì «Eseguita» è già corretto e dice ciò
  che serve. Questo design è sulle card CHIUSE SENZA azione, che sono quelle
  che confondono.
