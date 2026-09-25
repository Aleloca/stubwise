# Le mail tenute fuori: quante, perché, da chi — design

25 set 2026. Decisioni del maintainer: **motivo + dominio** (non ogni mail,
non solo i numeri) e **nell'app, in fondo alla tab Posta** (non nelle
Impostazioni, non sul web).

## §1 — Cosa succede oggi (verificato sul codice, non assunto)

- Il cancello è `admit()` (`packages/notifications/src/email-routing.ts:510`)
  e restituisce già il motivo di uno scarto:
  `{ admitted: false; reason: "denied_label" | "automated" | "no_match" }`
  (`AdmissionResult`, riga 381).
- L'unico chiamante è `syncGmail` (`apps/worker/src/google/poller.ts:860`), e
  il motivo lo butta: `if (!admission.admitted) continue;`. Di una mail
  scartata non resta **niente** — né riga, né log, né conteggio nel tick.
- Una mail scartata non scrive una riga in `email_messages`, quindi
  `filterAlreadyIngested` (riga 715) non la riconosce: a ogni rilettura della
  casella (resync `newer_than:7d`, lotto troncato, tick interrotto) viene
  riletta e rivalutata. **Un contatore che incrementa conterebbe due volte.**
- Le mail in USCITA (`isFromMailbox`, riga 858) non passano dal cancello: non
  sono uno scarto e non vanno contate.

Conseguenza pratica: la verifica del fix del 17 set (una keyword non scavalca
il cancello, memoria «Verifica ammissione posta») oggi si può fare solo
indirettamente, contando le proposte aperte. Con questo lavoro diventa
diretta: `github.com` deve comparire fra le «Automatiche».

## §2 — Il dato: una riga per mail scartata, senza contenuto

Tabella NUOVA `email_rejections`:

| colonna | tipo | note |
|---|---|---|
| `id` | uuid pk | |
| `account_id` | uuid FK `google_accounts` ON DELETE CASCADE | |
| `gmail_message_id` | text not null | |
| `sender_domain` | text **nullable** | minuscolo; `null` = mittente non leggibile |
| `reason` | text not null, CHECK `automated\|denied_label\|no_match` | |
| `rejected_at` | timestamptz not null default now() | |

Unique `(account_id, gmail_message_id)`; indice `(account_id, rejected_at)`.
Migrazione **0080**, additiva, un solo batch, **nessun `ALTER TYPE`**: il
motivo è un CHECK e non un pgEnum per lo stesso motivo di
`calendar_series.action` (7b).

Perché una riga per mail e non un contatore per giorno: l'unique è
l'idempotenza — la stessa mail riletta dopo un resync non conta due volte.

Cosa **non** si conserva, apposta: l'oggetto e l'indirizzo completo. Il
dominio basta a rispondere alla domanda («il cancello sta tagliando un
cliente?»), l'indirizzo sarebbe un dato personale di un terzo in una tabella
in più, l'oggetto sarebbe contenuto di posta fuori da `pruneOldEmails` — la
stessa ragione per cui la posta non entra nella cronologia della ricerca.

**Una mail che poi ENTRA smette di essere uno scarto.** Se le regole cambiano
e una rilettura la ammette, l'inserimento in `email_messages` cancella la sua
riga in `email_rejections` (stessa casella, stesso id Gmail). Senza, la stessa
mail comparirebbe sia in Posta sia fra le tenute fuori.

**Conservazione: 30 giorni**, costante nel codice (niente env). La potatura
gira dove gira `pruneOldEmails`. È indipendente da `GMAIL_RETENTION_DAYS`:
quello riguarda messaggi con proposte, questo solo numeri.

## §3 — Il worker

Nel ramo `!admission.admitted` di `syncGmail`: insert in `email_rejections`
con `onConflictDoNothing`, poi `continue` come oggi.

⚠️ **Fail-open, sempre**: un errore nello scrivere lo scarto si logga e non
sale. Il contatore è osservabilità: non deve mai fermare la sincronizzazione
di una casella (un'eccezione qui verrebbe letta come guasto della casella →
backoff → `sync_failed`). Questo rende anche innocuo l'ordine di deploy (un
worker nuovo davanti a uno schema senza la tabella logga e prosegue).

Il dominio si ricava dal `From` già letto per `messageToRouting` (la parte
dopo l'ultima `@`, minuscola); senza `@` → `null`.

## §4 — Il server

`GET /api/me/mail/rejections?days=7` (`days` 1..30, default 7), nel file
delle rotte posta, registrata **prima** delle rotte parametriche
(convenzione del file).

Filtro **`google_accounts.user_id = utente corrente`**, nessun ruolo
scavalca — è l'invariante `mailbox_owner`: i domini da cui scrive la gente a
un collega non sono affare di un admin. Test **negativo**: le righe di un
altro utente non compaiono, e il proprietario le vede (così un vuoto non può
essere una query rotta).

Risposta (schema in `packages/shared/src/schemas/google.ts`):

```ts
{
  days: number,
  total: number,
  accounts: Array<{
    accountId: string, email: string, total: number,
    reasons: Array<{
      reason: "automated" | "denied_label" | "no_match",   // enum aperto da readerSchema
      count: number,
      domains: Array<{ domain: string | null, count: number }>, // i primi 10
      otherDomains: number,                                     // mail oltre i primi 10
    }>,
  }>,
}
```

Ordinamenti: motivi e domini per conteggio decrescente. Una casella senza
scarti nel periodo non compare.

## §5 — L'app

**La riga**, in fondo alla lista delle conversazioni della tab Posta:
«335 emails kept out in the last 7 days ›». Compare anche quando la lista è
**vuota** — è proprio lì che serve («non vedo posta: è stata tenuta fuori?»).
È una lettura ACCESSORIA, fuori dai gate `isPending`/`isError` della lista:
se fallisce (server vecchio → 404) o il totale è zero, la riga **non
compare**, e la lista resta intera.

**La schermata** `MailRejections` nello stack della posta: per casella
(l'intestazione con l'indirizzo solo se le caselle sono più d'una), per
motivo un titolo col conteggio e UNA riga che spiega il motivo:

- *Automated* — «Notifications, newsletters and auto-replies.»
- *Excluded label* — «Promotions, social and spam, as set in Settings → Google.»
- *No matching rule* — «Not from your Workspace and no project rule names the sender.»

Sotto, i domini coi conteggi, più «+N others». Un motivo sconosciuto
(`UNKNOWN` da `readerSchema`) si mostra col titolo generico «Other». Le righe
dei domini **non sono premibili**: non c'è un dettaglio da aprire (regola
dell'app). Pull-to-refresh come le altre schermate.

## §6 — Fuori da questo lavoro, e perché

- **Il web**: scelta del maintainer. La rotta c'è, un domani è un componente.
- **«Aggiungi una regola per questo dominio»** dalla schermata: utile, ma è
  una scrittura sulle regole di progetto (quale progetto?) — un'altra
  decisione.
- **Saltare le mail già scartate in `filterAlreadyIngested`** (risparmierebbe
  una chiamata `metadata` a rilettura): cambierebbe il comportamento — oggi
  una mail rivalutata dopo un cambio di regole può entrare. Non è un contatore.

## §7 — Deploy e rollback

Rebuild **server + worker**. Caddy no: il web non cambia. Migrazione 0080
all'avvio del server. Nessuna env, nessun kind di notifica, nessun valore
aggiunto a un enum esistente, nessuna risposta esistente toccata: per l'app è
una rotta NUOVA.

Rollback innocuo in ogni direzione: server vecchio → 404 → la riga non
compare; worker vecchio → nessuno scrive né pota più, le righe già scritte
restano ferme finché non torna il worker nuovo. La tabella sopravvive.
