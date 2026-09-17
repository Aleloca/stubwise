# Una keyword non scavalca il cancello (17 set 2026)

## §1 — Il problema, misurato sui dati veri

Test manuale del 17 settembre. L'inbox del maintainer dice «34 decisioni che ti
bloccano»; le prime card sono Google Search Console, un alert di Vercel e una
mail commerciale.

Conteggio sulle **37 proposte aperte** in produzione, per dominio del mittente:

| dominio | proposte |
|---|---|
| github.com | 11 |
| thecove.atlassian.net + po.atlassian.net | 7 |
| calvizie.net (commerciale) | 3 |
| vercel.com | 2 |
| tutto il resto | 14 |

**23 su 37 — quasi due su tre — sono notifiche automatiche o posta
indesiderata.** E non è arretrato storico: le notifiche GitHub arrivano fino a
oggi.

⚠️ Una prima stesura di questo design diceva «23 su 32»: il numero veniva da
una query con `limit 10` di cui avevo sommato le righe come se fossero il
totale. Corretto ricontando senza limite. Il fatto non cambia la decisione, ma
un design che dice «misurato sui dati veri» non può portarsi dietro un conto
fatto male.

Perché conta più di un fastidio: dalla fine di ottobre 2026 saranno operatori
non tecnici a lavorare da quelle card. Un'inbox per tre quarti rumore non viene
filtrata con pazienza — viene ignorata, e con lei le quattordici che contavano.

## §2 — La causa, che non è un difetto

Il cancello anti-automatico è ACCESO (`email_admission_deny_automated = true`)
e `looksAutomated` riconosce `List-Unsubscribe`, `List-Id`, `Precedence` e
`Auto-Submitted` — header che GitHub, Jira e Vercel mandano tutti.

Non li ferma per via del **passo 1 di `admit()`**
(`packages/notifications/src/email-routing.ts`):

```ts
if (matchRoutes(message, config.routes).inScope) {
  return { admitted: true, reason: "project_rule" };
}
```

Una regola che combacia ammette SUBITO, esclusioni comprese. È una decisione
esplicita del maintainer dell'8 settembre 2026, scritta nel docblock: una
regola di progetto è una scelta deliberata dell'admin su un mittente preciso,
non un'ammissione larga, e deve vincere.

Il ragionamento regge per un mittente. **Non regge per una keyword**, e lì sta
lo scivolamento: delle 41 regole configurate, **21 sono `keyword`** (20
`sender_domain`, zero `sender_address`, zero `gmail_label`). Una keyword non
nomina un interlocutore: descrive un CONTENUTO, e il contenuto lo scrive
chiunque — GitHub compreso.

La catena, su un caso vero:

```
oggetto: [Aleloca/stubwise] Run failed: CI - main (6d6c975)
         → combacia keyword «stubwise» (progetto Stubwise)
         → passo 1: ammessa
         → List-Unsubscribe mai guardato
         → proposta creata
```

⚠️ `admit()` gira sui soli **metadati** (nessun corpo scaricato), quindi una
keyword può combaciare solo nell'**oggetto**. È esattamente il caso qui: gli
oggetti delle notifiche portano il nome del repository.

## §3 — La decisione: solo un mittente esplicito scavalca

Scelta del maintainer, 17 settembre, sull'anteprima dei due ordini.

```
ORDINE DI admit() — OGGI          PROPOSTO
1. QUALUNQUE regola    → dentro   1. sender_address/_domain  → dentro
2. etichetta vietata   → fuori    2. etichetta vietata       → fuori
3. sembra automatica   → fuori    3. sembra automatica       → fuori
4. dominio di lavoro   → dentro   4. keyword O dominio       → dentro
```

Il principio: **scavalca il cancello solo chi ha nominato QUALCUNO.**
`sender_address` e `sender_domain` sono un interlocutore scritto a mano
dall'admin; una `keyword` è una descrizione di argomento, e non basta a
rendere lavoro una notifica automatica.

Una mail NON automatica che combacia solo per keyword **entra come prima**, al
passo 4: non si perde nulla di ciò che arriva da persone.

### §3.1 — `gmail_label` sta coi mittenti, e va detto

Il quarto tipo di regola non è stato nominato nella decisione perché **in
produzione non ne esiste nessuna** (zero righe). Va comunque deciso ora, o lo
deciderà per sbaglio chi implementa: `gmail_label` scavalca **come i
mittenti**. Un'etichetta è una marcatura che una persona ha messo a mano sulla
propria casella — è una scelta deliberata su QUEL messaggio, non una
descrizione di contenuto. Chi un domani crea la prima regola `gmail_label` si
aspetta che vinca, come vince oggi.

### §3.2 — Come si distingue, senza toccare `matchRoutes`

`EmailRoutingResult` espone `matchedRuleCount` (quante regole per progetto) ma
**non il TIPO** delle regole che hanno combaciato. Non serve aggiungerlo: al
passo 1 si chiama `matchRoutes` su un sottoinsieme FILTRATO delle regole.

```ts
const decisive = config.routes.filter(
  (route) => route.kind !== "keyword",
);
if (matchRoutes(message, decisive).inScope) { … }
```

Così `matchRoutes` resta invariata, `EmailRoutingResult` non cambia forma, e
**il calendario non è toccato**: non chiama `admit()` — verificato, l'unico
chiamante è `apps/worker/src/google/poller.ts:858` — e continua a usare
`matchRoutes` con TUTTE le regole per la sua attribuzione.

Costo: `matchRoutes` viene calcolata due volte invece di una (una filtrata al
passo 1, una completa al passo 4). È una funzione pura su poche decine di
regole in memoria, dentro un tick che scarica messaggi dalla rete: non è il
posto dove si guadagna qualcosa a risparmiare.

## §4 — Le 23 già aperte

La modifica vale da qui in avanti. Le proposte già pubblicate restano dov'è
sono: nessuna migrazione le tocca, nessuna viene cancellata.

Vanno chiuse a parte, e **non è una scelta tecnica**: quelle card sono in
un'inbox. Decisione del maintainer, 17 settembre:

- **si chiudono in blocco le 20 da macchine** — `github.com`,
  `*.atlassian.net`, `vercel.com` — con un esito che dice DA COSA sono state
  chiuse, non un `ignored` generico: restano leggibili fra le gestite, nessuna
  riga viene cancellata (stessa forma di `superseded_in_thread` e
  `declined`);
- **le 3 commerciali di `calvizie.net` NO.** Le ha scritte una persona, non
  una macchina: chiuderle d'ufficio è una decisione sul contenuto, e quella la
  prende chi legge. Restano aperte.

⚠️ La chiusura è un'operazione **una tantum sui dati di produzione**, non un
passo della migrazione e non qualcosa che il codice rifà da solo. Chiude solo
righe di `email_proposals` ancora aperte e marca `handled` le loro notifiche —
mai `email_messages` del padre, se non `updated_at` (l'invariante della fase
6b: confermare o chiudere una proposta non tocca le sorelle).

## §5 — Cosa NON cambia

- **`looksAutomated` non si tocca**: gli header che riconosce sono quelli
  giusti, il problema era solo che nessuno li guardava per quei messaggi.
- **Le impostazioni di ammissione non cambiano forma**: nessuna colonna nuova
  su `instance_settings`, nessuna migrazione. `admitWorkspaceDomains`,
  `denyLabels`, `denyAutomated` restano quelli, con lo stesso significato.
- **Nessun `ALTER TYPE`, nessuno schema toccato.** È un cambio di ORDINE
  dentro una funzione pura, più i suoi test.
- **Il rollback è il codice precedente**: non c'è stato da ripulire, non c'è un
  interruttore da spegnere. Un'immagine worker precedente torna a comportarsi
  come prima — ammette di nuovo troppo, senza rompere niente.

## §6 — Come si verifica che sia servito

Non «i test passano», ma il conteggio del §1 rifatto dopo qualche giorno di
posta vera: le proposte aperte da `github.com`, `*.atlassian.net` e
`vercel.com` devono essere **zero**, e quelle dai domini dei clienti invariate.
Il primo numero dice che il cancello morde; il secondo che non morde troppo.
