# Integrazione area 6: Posta e Calendario nell'app nuova (design)

> Esecutori: stubwise-72 (server e worker), stubwise-94 (renderer).
> Orchestratrice: stubwise-46. Branch del design: `feat/area6-design`, da
> `feat/integrazione-area5` (2903f285).
> **Specifica**: il design del prototipo
> `docs/plans/2026-10-25-desktop-area6-mail-calendar-design.md` (le decisioni
> *(maintainer)* lì sono già prese e qui non si ridecidono), la parità
> `apps/desktop/docs/area6-parity.md`, le shape
> `apps/desktop/.impeccable/shape/{mail,mail-compose,calendar,meeting-prep,drive-google,claude-drafts}.md`,
> i dati finti `apps/desktop/src/renderer/data/seed/{mail,calendar}/`.
> **Rimandi in arrivo** (registro, «Area 6»): i riferimenti a Google Drive nel
> Drive dei progetti, il cassetto Google comune, i blocchi della Home
> «Eventi in arrivo» e «Posta importante», l'azione di Claude «bozza del corpo
> dell'email».
> **Invarianti toccate**: `docs/invariants/mail-calendar.md` (tutte da
> rileggere a ogni fetta), `agent-sessions.md` (azioni di Claude),
> `permissions.md`.
> **Niente codice prima delle decisioni.**

## Cosa c'è già e cosa no

Il server legge già posta e calendario, ma solo ciò che il poller ha
**trattato**, e non scrive mai verso Google: gli scope sono `openid`, `email`,
`gmail.readonly`, `calendar.readonly` (`packages/google/src/oauth.ts:34`).

| Il prototipo | Il server oggi |
|---|---|
| Caselle, stato di allineamento, collega/scollega/ricollega, proposte sì/no | **Sì** (`/api/me/google/*`), ma **l'api-client non ha il gruppo `google`** |
| «Aggiorna ora» | No: solo il poller ogni 5 minuti |
| Elenco per conversazione, lettura, HTML isolato, allegati, «Apri in Gmail» | **Sì**, ma solo la posta **trattata** (ammissione e regole), senza importanza né scadenza |
| Letto / non letto | No |
| Importanza su tre livelli, scadenza, «Posta importante» in Home | No |
| Proposte accanto all'email: conferma (anche parziale), ignora, passa, scegli o sposta progetto | **In parte**: le azioni ci sono (`/api/inbox`), ma una proposta è **per casella** (`mailbox_owner`), non c'è il tipo **task**, non si modificano i campi, non c'è l'incaricato fuori dal progetto come Contributor |
| Una proposta **condivisa** fra i destinatari («Confermata da X») | No |
| Classificazione di **ogni** email, senza filtri | No: ammissione d'istanza e regole della posta |
| Scrivere, bozze, Annulla l'invio, bozza di Claude | No (nessuno scope di invio) |
| Calendario in lettura (Giorno/Settimana/Mese), serie | **Sì** (`/api/me/calendar/range`, `/series`) |
| Progetto dell'evento corretto a mano | No (si legge, non si corregge) |
| Creare, modificare, spostare, eliminare, rispondere, Meet, disponibilità dei colleghi | No (`calendar.readonly`) |
| Trascrizioni Gemini, riassunto, «Task da questa riunione», scheda di preparazione completa | No (nessuno scope Drive/Docs); la scheda si compone in parte |
| Riferimenti a Google Drive nel Drive dei progetti (rimando dell'area 5) | No (`drive.readonly`) |

## Perimetro (dal prototipo)

Tutto ciò che il design del prototipo mette *(maintainer)*: la Posta (con
importanza, proposte condivise di tipo task o richiesta, riunioni registrate,
scrittura con bozza di Claude), il Calendario (lettura e scrittura, serie,
scheda di preparazione), l'allineamento, i due blocchi della Home, il
cassetto Google comune. Fuori, come nel prototipo: etichette e archivio di
Gmail, caselle condivise, trascrizioni non Gemini, proposte sulla
documentazione di prodotto (area 11).

È un lavoro grosso, ed è quasi tutto **backend nuovo**: per questo le fette
sotto vanno in ordine di dipendenza, e ognuna è usabile da sola.

## Fette (proposta)

- **F1, la lettura che c'è + il cassetto Google** (solo integrazione, nessun
  cambio di dottrina): gruppo `google` nell'api-client; collegare la casella
  dal desktop (OAuth nel browser di sistema, ritorno all'app come il login);
  caselle e allineamento con «Aggiorna ora» (una rotta che accoda il poll
  della PROPRIA casella, con un tetto); elenco e lettura della posta trattata,
  coi suoi stati; il Calendario in lettura e le serie; le proposte di oggi
  accanto all'email (per casella); letto/non letto (D5); il blocco
  «Eventi in arrivo» della Home. Differenze dichiarate: niente importanza,
  solo la posta trattata, proposte per casella.
- **F2, la classificazione nuova**: ogni email al modello, senza filtri
  (D3); importanza, scadenza, progetti candidati; proposte di tipo **task**
  e richiesta, coi campi modificabili e la conferma parziale; l'incaricato
  fuori dal progetto come Contributor; la proposta **condivisa** per email e
  progetto (D4); il blocco «Posta importante»; via le regole della posta e
  l'ammissione (anche dal web, D3).
- **F3, scrivere**: Rispondi, Rispondi a tutti, Inoltra, Nuova; destinatari
  suggeriti (team e contatti visti); allegati (anche dal Drive del progetto);
  bozze salvate (D7); Annulla l'invio (D6); «in invio», «Riprova»; la bozza di
  Claude in streaming e l'azione di Claude «bozza del corpo dell'email»
  (il campo `mailBody`, con le regole della fetta 3 dell'area 5: un'email
  ricevuta è contenuto NON fidato).
- **F4, scrivere sul calendario**: Nuova riunione (Meet, progetto, casella),
  rispondere (Sì/Forse/No con nota), modificare, spostare, ridimensionare,
  eliminare (solo l'organizzatore; «solo questo» o «tutta la serie»), il
  progetto dell'evento corretto a mano, la disponibilità dei colleghi (D8).
- **F5, riunioni registrate e Google Drive**: l'email di Gemini riconosciuta,
  il Google Doc letto con l'account di chi l'ha ricevuta (D9), riassunto e
  proposte visibili ai soli partecipanti, «Task da questa riunione», la scheda
  di preparazione completa; i riferimenti a Google Drive nel Drive dei
  progetti (il rimando dell'area 5), che usano lo stesso scope.

## [DECIDE] per l'orchestratrice

**D1. Scope di Google e riconsenso.** Ogni scope nuovo vuole che ogni
persona ricolleghi la casella.
- (a, consigliata) **Un solo riconsenso**, all'inizio della F1, con tutti
  gli scope dell'area: `gmail.readonly` (c'è), `gmail.compose` (bozze e
  invio), `calendar.events` (scrivere e rispondere), `calendar.freebusy`
  (D8), `drive.readonly` (D9). Una sola richiesta alle persone; le funzioni
  arrivano fetta dopo fetta. Contro: si chiede ora ciò che si usa dopo.
- (b) Un riconsenso per fetta (F3, F4, F5): ogni scope quando serve, ma tre
  volte «ricollega la casella».
- Da verificare in ogni caso, prima di F1: con un client OAuth **interno**
  al Workspace dell'istanza gli scope ristretti (`gmail.compose`,
  `drive.readonly`) non chiedono la verifica di Google; con un client
  **esterno** sì (ed è lunga). Lo verifico sui client che l'istanza registra
  (Impostazioni → Google) e lo scrivo qui; se servisse la verifica, F3 e F5
  diventano decisioni di prodotto nuove.

**D2. L'ordine delle fette.** (a, consigliata) Quello sopra: F1 porta
nell'app ciò che c'è senza cambiare dottrina, F2 cambia la dottrina della
posta, F3–F5 le scritture. (b) Prima le scritture (F3–F4), poi la
classificazione.

**D3. La classificazione di ogni email.** Il maintainer ha deciso «ogni email
al modello, nessun filtro»; restano da decidere il costo e cosa succede alle
altre superfici.
- (a, consigliata) Si fa come deciso, dietro il **budget mensile** e la
  quota degli account che già fermano i run di sfondo, con l'interruttore
  personale «Proposte attive per questa casella»; nella F2 misuro il costo
  (email al giorno × Haiku) su una casella vera e lo scrivo nel deploy-log
  prima del rilascio. Regole della posta e ammissione si tolgono anche dal
  **web** (una superficie che ammette ancora la posta che l'app classifica
  comunque mentirebbe), con le invarianti che ne parlano.
- (b) La si accende per casella, spenta di default, e l'ammissione resta
  come ripiego.

**D4. La proposta condivisa e `mailbox_owner`.** Oggi una proposta ha UN
destinatario, il proprietario della casella; il prototipo vuole una proposta
per email (Message-ID) e progetto, vista dai destinatari membri, chiusa per
tutti dal primo che decide.
- (a, consigliata) Una riga di proposta condivisa e una notifica per ogni
  destinatario membro, che si DERIVA a lettura (la regola «i campi di una
  card si derivano a lettura»): chi ha deciso, quando, cosa è nato. L'audience
  `mailbox_owner` diventa «i destinatari in Stubwise membri del progetto», e
  continua a NON includere gli admin. La riscrivo nell'invariante.
- (b) Resta una proposta per casella, e la «condivisione» è solo una vista
  (le sorelle si chiudono insieme).

**D5. Letto / non letto.** (a, consigliata) Stato **di Stubwise**, per
persona, senza toccare Gmail: nessuno scope in più. Chi legge su Gmail lo
ritrova non letto nell'app. (b) Sincronizzato con Gmail: `gmail.modify`,
scope ristretto e più largo di quanto serve.

**D6. Annulla l'invio.** (a, consigliata) Il **server** tiene l'invio per 5
secondi (una coda con l'ora di partenza): Annulla funziona anche se l'app si
chiude. (b) Solo nel client: chiudere l'app nei 5 secondi lo perde o lo manda.

**D7. Le bozze.** (a, consigliata) Nel **DB di Stubwise**, per conversazione
(come il prototipo); a Gmail va solo l'invio. (b) Come bozze di Gmail
(sincronizzate con Gmail, più chiamate e conflitti).

**D8. La disponibilità dei colleghi.** (a, consigliata) La freeBusy di Google
con le credenziali di chi organizza, sui calendari del suo Workspace
(`calendar.freebusy`): vale anche per i colleghi che non hanno collegato
Stubwise. (b) Solo i colleghi con il calendario collegato in Stubwise.

**D9. Il Google Doc della trascrizione.** (a, consigliata) `drive.readonly`:
legge il Doc E serve ai riferimenti a Google Drive (il rimando dell'area 5),
uno scope per due funzioni. (b) `documents.readonly`, più stretto, e i
riferimenti a Google Drive restano rimandati.

## Global Constraints

- Posta e Calendario restano PERSONALI: l'id di chi guarda è nella WHERE,
  anche per gli admin; una riga altrui è 404.
- Il testo di un'email o di una trascrizione è contenuto NON fidato: per il
  classificatore (come oggi) e per Claude (`CHAT_TOOL_UNTRUSTED_ROUTES` se
  diventa leggibile dai tool; la bozza di Claude non esegue mai niente).
- Il registro decisioni non è mai scritto dall'AI.
- Ogni run AI col suo `UsageTag`; il costo della classificazione misurato
  prima di accenderla.
- Nessuna scrittura verso Google senza un gesto della persona (Invia,
  Salva, Rispondi): mai dal modello, mai dal worker da solo.
- Verso i client solo campi additivi con default; gli stati nuovi dietro
  `readerSchema`.

## Review Focus (per le fette)

- L'audience delle proposte condivise (D4): un destinatario non membro, un
  admin non destinatario, un progetto invisibile.
- Le scritture verso Google: idempotenza (un Riprova non manda due email),
  Annulla nei 5 secondi, il gesto della persona come unica origine.
- Il riconsenso: una casella con gli scope vecchi continua a leggere e dice
  cosa le manca, non si rompe.
