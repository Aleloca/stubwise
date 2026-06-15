# Stubwise — Internazionalizzazione (i18n) (design)

> Design validato il 2026-06-15. Rende Stubwise multilingua: UI in inglese di
> default con preferenza per-utente, e contenuti generati / output LLM / notifiche
> nella lingua d'istanza. Motivazione: il progetto nasce open-source self-hostable
> ma oggi ha tutti i testi hardcoded in italiano, il che taglia fuori adozione e
> contributi. Farlo ora è il momento più economico (ogni feature futura
> aggiungerebbe altre stringhe italiane).

## Obiettivo

UI in **inglese di default**, con la possibilità di cambiare lingua dalle
impostazioni; il cambio lingua deve riflettersi anche sull'output degli LLM
(commenti AI, triage, report PR) e sui testi generati dal backend.

## Decisioni chiave

- **UI per-utente**: ogni utente sceglie la lingua della propria interfaccia.
- **Contenuti per-istanza**: commenti generati, report PR, notifiche e lingua
  dell'LLM seguono un'unica impostazione d'istanza (sono artefatti condivisi,
  salvati una volta sola).
- **Libreria UI**: `react-i18next`.
- **Errori API**: messaggi del server in inglese + **codice stabile**; la UI
  traduce per codice.
- **Lingue v1**: inglese (default) + italiano. Architettura pronta per N lingue.
- **Docs**: fuori dalla v1 (follow-up dedicato).

## Architettura — tre superfici, due risoluzioni di lingua

**A. Chrome UI (per-utente)** — stringhe statiche React.
**B. Contenuti generati + LLM + notifiche (per-istanza)** — commenti AI/sistema,
report PR, messaggi notifiche, lingua in cui l'agente scrive.
**C. Errori API** — inglese dal server, tradotti dalla UI.

**Modello dati:**

1. `users.language` — `text not null default 'en'`, check `'en'|'it'`. Preferenza
   UI del singolo utente. Letta da `/me`, modificabile da Settings → Account.
2. `instance_settings` — nuovo singleton (`id=1`, come `notification_settings`),
   con `content_language text not null default 'en'`. Lingua d'istanza per tutto
   il contenuto generato/condiviso. Modificabile da Settings (admin). Seedato
   dalla migrazione.

Due risoluzioni separate perché un commento/report è salvato una volta sola e
visto da tutti (→ lingua d'istanza), mentre la UI è renderizzata per ciascun
utente (→ preferenza personale).

**Nuovo pacchetto `@stubwise/i18n`** (db-free, funzioni pure): `t(lang, key, params)`
con cataloghi `en`/`it` per i **soli testi generati dal backend**:
- template commenti di sistema/AI;
- messaggi delle notifiche;
- header delle sezioni del report;
- nomi-lingua per i prompt (`"English"`/`"Italian"`).

Unica fonte di verità condivisa da server, worker e notifications.

## A — UI web (react-i18next)

**Setup.** `i18next` + `react-i18next` in `apps/web`. Init in `src/i18n/index.ts`:
risorse `en`/`it`, fallback `en`, interpolazione, plurali nativi.

**Cataloghi.** `src/i18n/locales/en.json` e `it.json`, per **namespace**
(`common`, `tickets`, `settings`, `auth`, `notifications`, `automation`,
`jobStatus`…). **Inglese = fonte di verità**; italiano = testi attuali ri-mappati.

**Risoluzione lingua.**
- Pre-login: `en` (rilevamento opzionale da `navigator.language`).
- Post-login: `i18n.changeLanguage(user.language)` da `/me`. Il select in
  Settings → Account fa `PATCH` della preferenza **e** `changeLanguage` live (no
  reload).

**Estrazione stringhe.** Sostituire le stringhe italiane hardcoded nei ~43 `.tsx`
con `t("ns:key")`. Include le mappe esistenti (etichette stati job, badge, form
settings, hint del dettaglio ticket). Parte più voluminosa, mechanical.

**Mappatura errori API.** Helper `translateApiError(error)`: mappa il `code`
stabile del server alle chiavi `t("errors:...")`; fallback al `message` grezzo.
Usato dove oggi si mostra `mutation.error.message`.

**Selettore lingua.** Settings → Account: select `English`/`Italiano` legato a
`user.language`.

## B — Backend: contenuti, LLM, notifiche

**Risoluzione lingua d'istanza.** Server e worker leggono
`instance_settings.content_language` dal DB e lo passano a `t(lang, …)`.

**Worker — prompt e report.** I prompt sostituiscono `"in Italian"` con
`in ${languageName(lang)}`; gli header fissi del report (`## Processo di indagine`…)
diventano localizzati da `@stubwise/i18n`. L'agente scrive report e contenuti
nella lingua d'istanza. I body dei commenti generati dal worker (triage
held/skip/duplicate, fix, piano) passano da `t(lang, …)`.

**Server — commenti di sistema e notifiche.** I commenti di sistema del webhook
(`PR mergiata`, `PR chiusa senza merge`) usano `t(lang, …)`. Il dispatch notifiche
passa `lang` a `formatNotification(event, format, lang)` (i testi vengono da
`@stubwise/i18n`).

## C — Errori API → codici stabili

Gli errori user-facing del server adottano un **codice stabile** oltre al
messaggio inglese: `{ code: "ticket_not_found", message: "Ticket not found" }`.
La UI traduce per `code`; senza match mostra `message`. In pratica i messaggi
Fastify/Zod oggi in italiano diventano inglesi, con `code` dove serve la
traduzione in UI.

## Migrazione e dati esistenti

**Migrazione (additiva).** `users.language` + singleton `instance_settings`
(seedato). Sicura sul prod esistente: gli utenti attuali ereditano `'en'`.

**Effetti dopo il deploy:**
- La UI passa a **inglese** per ogni utente finché non imposta `Italiano` in
  Settings → Account; i **nuovi contenuti** sono in **inglese** finché
  `content_language` d'istanza non è portato su `it`. È il comportamento voluto
  (default English) — la propria istanza italiana si imposta su `it` subito dopo
  il deploy se desiderato.
- I **contenuti esistenti** (ticket/commenti/report storici in italiano) restano
  invariati; solo i nuovi seguono l'impostazione.

## Docs — fuori dalla v1

Le docs (Astro Starlight) restano in italiano in questa feature. Discrepanza nota
(app inglese, docs italiane) tracciata come follow-up dedicato (tradurre le docs
in inglese, eventualmente i18n nativo Starlight dopo).

## Test

- `@stubwise/i18n`: unit su `t(lang,key,params)`; test di **parità chiavi** en/it
  (fallisce se manca una chiave in una lingua).
- web: selettore lingua (PATCH pref + `changeLanguage`); componenti resi in en/it;
  helper `translateApiError`.
- server: round-trip `users.language` e `instance_settings.content_language`;
  aggiornamento dei test che asserivano messaggi italiani → inglese/codici.
- worker: prompt con la lingua giusta + header report localizzati; commenti
  generati nella lingua d'istanza.
- notifications: `formatNotification` con `lang` → testi en/it.

## Dimensione

Feature **ampia** (più del loop di feedback come superficie): l'estrazione delle
stringhe UI (~43 file) e l'aggiornamento dei test server sono il grosso, ma
mechanical. Esecuzione subagent-driven, fase per fase, con review spec+qualità.
