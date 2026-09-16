# Righe di ricerca per tipologia (16 set 2026)

## §0 — Da dove nasce

Test manuale del maintainer, 16 settembre:

> «ora tutte le righe hanno la stessa estetica anche se riguardano cose
> completamente diverse, possiamo usare anche UX e UI diverse sulle varie
> righe in base alla tipologia perché per ogni tipologia è importante mostrare
> subito le cose importanti, ad esempio ora su email non c'è né data né orario
> di arrivo, chi è in copia non si vede bene ecc ecc»

È l'ultimo pezzo della ricerca globale dell'app, aperta il 15 settembre
(`2026-09-15-calendar-and-search-design.md`, §3): schede per tipo fatte,
conteggi a zero nascosti fatti, righe no.

## §1 — Il problema, misurato

`GlobalSearchSheet` (`apps/mobile/src/components/GlobalSearchSheet.tsx`) ha
**un** componente `Row`, usato da tutti e quattro i gruppi:

```tsx
function Row({ title, subtitle, onPress, testID }) { … }
```

`title` e `subtitle`, entrambi `numberOfLines={1}`. Una conversazione di posta,
un ticket, una pagina Docs e un progetto arrivano tutti lì dentro, e ognuno
perde per strada esattamente ciò che lo rende riconoscibile: la posta perde la
data, il ticket perde numero e stato, la pagina Docs perde il repository.

Non è che i dati manchino. Il server ne manda già la maggior parte e la riga
li scarta per mancanza di posto.

## §2 — Cosa il server manda già, e cosa no

Verificato leggendo `packages/shared/src/schemas/search.ts` e la query in
`apps/server/src/routes/search.ts`, non assunto:

| gruppo | campi che arrivano oggi |
|---|---|
| posta | `threadId`, `accountId`, `accountEmail`, `subject`, `from`, `snippet`, `matchedMessageId`, **`receivedAt`** |
| ticket | `id`, `number`, `title`, `status`, `snippet`, `projectId`, `projectName` |
| docs | `slug`, `title`, `kind`, `snippet`, `repositoryId`, `repositorySlug`, `repositoryName` |
| progetti | `id`, `name`, `slug`, `snippet` |

Dei due esempi del maintainer, quindi:

- **data e ora ci sono già** (`receivedAt`): il server le manda dal primo
  giorno, la riga non le mostra. Costo: zero;
- **chi è in copia no.** E qui c'è una scoperta che cambia lo scope.

### §2.1 — Il `cc` viene già letto da Gmail, e buttato via

`DEFAULT_METADATA_HEADERS` (`packages/google/src/gmail.ts`) chiede a Gmail
anche `Cc`, nella **stessa** risposta `format=metadata` degli altri header —
non è una chiamata in più. Serve all'ammissione della fase 6c, che guarda
proprio i domini in copia per decidere se una mail è lavoro
(`admit()`, `packages/notifications/src/email-routing.ts`: `ccAddresses`).

Ma `buildEmailMessageInsert` (`apps/worker/src/google/sync.ts`) scrive
`toAddresses` e **non** il `cc`: non esiste una colonna dove metterlo. Il dato
attraversa il worker, decide se un'email entra nel sistema, e sparisce.

`to_addresses`, invece, **è già in colonna** (`email_messages`): la query di
ricerca semplicemente non lo seleziona.

## §3 — Le quattro righe

Forma decisa dal maintainer il 16 settembre, sulle anteprime. Tutte e quattro
mostrano lo **snippet** (`ts_headline`, con `<mark>`): è il pezzo che ha
combaciato, cioè il motivo per cui la riga è lì.

**Posta** — mittente e quando in cima, sulla stessa riga; poi l'oggetto; poi
chi altro c'è; poi l'estratto.

```
┌──────────────────────────────────────┐
│ lavinia.corsi@hays.com    10/09 17:45│
│ Hays | PHP Developer                 │
│ a: a.locatelli  cc: m.misseri +2     │
│ «Candidato con 7 anni di esperienza…»│
└──────────────────────────────────────┘
```

**Ticket** — numero e stato in cima, il titolo sotto.

```
┌──────────────────────────────────────┐
│ #27              ● in review · Wilco │
│ Error: write EPIPE                   │
│ «…durante l'export del CSV corriere» │
└──────────────────────────────────────┘
```

**Docs** — titolo, poi da dove viene.

```
┌──────────────────────────────────────┐
│ Autenticazione SSO                   │
│ stubwise · tecnica                   │
│ «…il token viene rinnovato ogni…»    │
└──────────────────────────────────────┘
```

**Progetti** — restano com'erano: nome e descrizione sono tutto ciò che un
progetto ha, e la riga generica già li mostrava bene. Cambia solo il fatto che
smettono di condividere il componente con gli altri tre.

### §3.1 — Tre regole di resa, e il perché

1. **Dagli elenchi `a:`/`cc:` si toglie l'indirizzo della casella che ha
   ricevuto** (`accountEmail`, che il server già manda). «a: a.locatelli»
   quando a.locatelli è chi sta cercando non è informazione: la domanda a cui
   la riga risponde è *chi altro vede questa mail*. Se dopo il filtro non
   resta nessuno, la riga non compare affatto — meglio assente che vuota.
2. **Si mostra la parte locale, non l'indirizzo intero**, più `+N` per il
   resto. Su una riga stretta `m.misseri +2` dice quanto basta; l'indirizzo
   completo è nella conversazione aperta, a un tap.
3. **La data è relativa vicino e assoluta lontano**: `17:45` per oggi,
   `10/09 17:45` oltre. È la stessa regola che la lista MBX usa già — non se
   ne inventa una seconda.

## §4 — La colonna, e i 163 messaggi che non ce l'hanno

Serve `email_messages.cc_addresses`. Migrazione additiva, nessun `ALTER TYPE`,
nessun enum, un solo batch: la famiglia di migrazione più innocua che questo
repo conosca.

**Nasce `nullable`, non `not null default '{}'`, e non è una svista di
coerenza con `to_addresses`.** I due valori dicono cose diverse:

- `null` = *non lo sappiamo* (riga scritta prima di questa modifica);
- `{}` = *lo sappiamo, non c'era nessuno in copia*.

Senza quella distinzione il recupero del §4.1 non saprebbe dove fermarsi:
«salta le righe che hanno già un `cc`» ri-scaricherebbe da Gmail, a ogni
lancio, tutte le email che legittimamente non avevano nessuno in copia. Con
`null` il recupero è davvero idempotente, e una seconda esecuzione non chiama
Google nemmeno una volta.

Per chi legge la riga i due valori si rendono uguali (niente `cc:`), quindi la
distinzione non arriva mai all'utente: esiste per il recupero.

### §4.1 — Il recupero delle 163 righe storiche

In produzione, al 16 settembre: **163 messaggi, dal 4 agosto**, circa 4 al
giorno. Nessuno di loro ha il `cc`, e non è ricostruibile dal database — sta
solo su Gmail. Senza recupero, il campo che il maintainer ha appena chiesto
sarebbe quasi invisibile per settimane, proprio durante i test.

Script operativo una tantum, `apps/server/scripts/backfill-email-cc.ts`,
sulla stessa forma di `apps/server/scripts/backfill-ticket-done-events.ts` (fase 5): emesso in
`dist/scripts/` dal build del server, lanciato **dentro il container**
(`docker compose exec server node dist/scripts/backfill-email-cc.js`), con
`--dry-run` prima. Non è una migrazione di proposito: parla con una API
esterna e va lanciato quando si vuole.

**Tre paletti, e vanno tutti e tre:**

1. **Tocca SOLO `cc_addresses`.** Mai `text_excerpt` (è ciò che la
   classificazione ha letto — vedi l'invariante sull'HTML in CLAUDE.md), mai
   `status`, mai `outcome`, mai una riga di `email_proposals`. Una proposta
   aperta non deve accorgersi che questo script è passato.
2. **Legge `format=metadata`**, la stessa chiamata del poller, con gli stessi
   token OAuth per casella. Un messaggio cancellato da Gmail (404) lascia la
   riga a `null` e prosegue: non è un errore da fermare tutto.
3. **Non fa partire niente.** Nessun job, nessuna classificazione, nessuna
   notifica. È la stessa dottrina del percorso `auto` del calendario
   (`calendar-auto.ts`): uno script che tocca la posta non avvia lavoro.

## §5 — Cosa questo giro NON fa

- **La palette web resta com'è.** `global-search-palette.tsx` ha lo stesso
  difetto (`title` + `subtitle`, riga 428-429) ma è una spotlight Cmd/K
  compatta, un contesto diverso dalla schermata a schermo pieno dell'app.
  I campi nuovi arrivano anche a lei nella risposta e lei li ignora, che è
  esattamente ciò che deve fare un client che non li usa.
- **I repository continuano a non comparire** nell'app: non esiste una
  schermata dove portarli, e una riga che non porta da nessuna parte è peggio
  di una riga assente. C'è già un test che lo fissa.
- **Non si aggiunge la posta a `search_entity`** (i «recenti»): il motivo sta
  scritto per esteso nel docblock di `searchEntityTypeSchema` e non cambia.

## §6 — Compatibilità verso l'app già installata

`to` e `cc` sono campi NUOVI in una risposta che l'app legge, quindi —
CLAUDE.md, «solo cambi additivi» — nascono `.default()`, mai obbligatori, e
arrivano con un test che parsa una risposta **senza** di loro. Un'app
aggiornata contro un server più vecchio (un rollback, un'istanza self-hosted)
li riceve assenti e mostra le righe senza quella parte, come oggi.

Il rollback è simmetrico e innocuo: nessun kind di notifica nuovo, nessun
valore aggiunto a un enum esistente, quindi niente della famiglia del 500 su
`/api/inbox` delle fasi 2/5/6. Scendere di immagine sul server perde i due
campi; scendere sul worker smette di scrivere il `cc` sulle righe nuove e la
colonna resta `null`, che è esattamente il valore che significa «non lo
sappiamo». La colonna sopravvive a tutto.
