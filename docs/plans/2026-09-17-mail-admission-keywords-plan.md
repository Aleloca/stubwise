# Piano — Una keyword non scavalca il cancello (17 set 2026)

Design: `2026-09-17-mail-admission-keywords-design.md`. Quattro task. Nessuna
migrazione, nessuno schema toccato: è un cambio di ORDINE dentro una funzione
pura, più i test che lo fissano.

Chiusura: `pnpm typecheck`, `pnpm test`, **`pnpm lint` dalla radice**.

---

## Task 1 — L'ordine di `admit()`

`packages/notifications/src/email-routing.ts`. Il passo 1 smette di consultare
TUTTE le regole e guarda solo quelle che nominano un interlocutore:

```ts
const decisive = config.routes.filter((route) => route.kind !== "keyword");
if (matchRoutes(message, decisive).inScope) {
  return { admitted: true, reason: "project_rule" };
}
```

…e dopo le esclusioni (etichetta vietata, `looksAutomated`) le `keyword`
rientrano, insieme al dominio di lavoro:

```ts
if (matchRoutes(message, config.routes).inScope) {
  return { admitted: true, reason: "project_rule" };
}
```

**`gmail_label` sta coi mittenti** (design §3.1): il filtro esclude la sola
`keyword`, non elenca i tipi ammessi — così un tipo NUOVO aggiunto un domani
scavalca per default, che è il comportamento storico, e chi lo introduce deve
decidere esplicitamente di metterlo fra i non-decisivi. In produzione oggi non
esiste nessuna regola `gmail_label`: è una decisione presa in anticipo, non un
comportamento osservato.

**Il docblock di `admit()` va riscritto**, non ritoccato: l'ordine che descrive
è la cosa che cambia, e quel testo è il motivo per cui la fase 6c si capisce.
Deve dire perché un mittente scavalca e una keyword no — «una keyword descrive
un CONTENUTO, e il contenuto lo scrive chiunque» — e citare il caso vero
(notifiche GitHub ammesse dalla keyword `stubwise` nell'oggetto).

⚠️ **`matchRoutes` non si tocca**, e `EmailRoutingResult` non cambia forma: il
calendario la usa con TUTTE le regole per la sua attribuzione e non deve
accorgersi di niente (unico chiamante di `admit()`:
`apps/worker/src/google/poller.ts:858` — verificato).

## Task 2 — I test che fissano la regola

In `packages/notifications/src/email-routing.test.ts`, accanto a quelli
esistenti della 6c. Il caso centrale è **il caso vero di produzione**, non uno
inventato:

1. **Una notifica automatica che combacia per keyword è FUORI**: oggetto
   `[Aleloca/stubwise] Run failed: CI`, header `List-Unsubscribe`, regola
   `keyword: stubwise` → `admitted: false`, `reason: "automated"`.
2. **La stessa mail SENZA header automatici è DENTRO** (passo 4): stesso
   oggetto, stessa keyword, nessun `List-Unsubscribe` → `admitted: true`. È la
   riga che dimostra che non abbiamo spento le keyword, solo tolto loro il
   privilegio di scavalcare.
3. **Un mittente esplicito scavalca ancora**: `sender_domain: cliente.com` +
   `List-Unsubscribe` → `admitted: true`. Un cliente che scrive da un sistema
   di ticketing continua ad arrivare, ed è la ragione per cui non abbiamo reso
   il cancello assoluto.
4. **`gmail_label` scavalca come un mittente** (design §3.1): regola
   `gmail_label` + `List-Unsubscribe` → `admitted: true`.
5. **Un'etichetta vietata batte tutto tranne un mittente esplicito**: keyword +
   `SPAM` → fuori; `sender_domain` + `SPAM` → dentro (invariato dalla 6c).

## Task 3 — Il conteggio che dice se è servito

Non un test: una **query di verifica** da lanciare qualche giorno dopo il
deploy, scritta nel design (§6) e ricopiata nella voce di deploy di CLAUDE.md.

```sql
select split_part(m.from_address,'@',2) dominio, count(*)
from email_messages m
join email_proposals p on p.email_message_id = m.id
where p.status not in ('actioned','ignored','failed')
group by 1 order by 2 desc;
```

Atteso: `github.com`, `*.atlassian.net`, `vercel.com` a **zero**; i domini dei
clienti **invariati**. Il primo numero dice che il cancello morde, il secondo
che non morde troppo.

## Task 4 — CLAUDE.md

Aggiornare **l'invariante esistente** della fase 6c (non aggiungerne una
nuova accanto, o si contraddicono): il paragrafo che descrive l'ordine di
`admit()` dice oggi «una regola di progetto che combacia ammette SUBITO,
esclusioni comprese». Va corretto in «una regola che nomina un INTERLOCUTORE
(`sender_address`, `sender_domain`, `gmail_label`) ammette subito; una
`keyword` no, perché descrive un contenuto e il contenuto lo scrive chiunque»,
col caso GitHub come esempio.

Più la voce di deploy: rebuild del **solo worker** (`admit()` gira lì; il
server non la chiama), nessuna migrazione, nessuna env nuova, rollback =
immagine precedente, che torna ad ammettere troppo senza rompere nulla.

---

## Fuori perimetro

- **`looksAutomated` non si tocca**: riconosceva già gli header giusti.
- **Le impostazioni di ammissione non cambiano forma**: nessuna colonna, nessuna
  migrazione, nessun interruttore nuovo in UI.
- **Le 23 proposte già aperte** non sono un task: le chiude a mano il
  maintainer sui dati di produzione (design §4), e la decisione su quali è già
  presa lì.
