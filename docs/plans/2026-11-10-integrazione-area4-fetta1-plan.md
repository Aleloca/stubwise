# Area 4 — Chat, fetta 1: canali di progetto, messaggi, menzioni — piano

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans.

**Spec**: `docs/plans/2026-11-10-integrazione-area4-chat-design.md`, deciso
il 10 nov 2026. Il comportamento è quello del prototipo:
- `apps/desktop/src/renderer/data/chat/*`: `visibility.ts` (chi vede e chi
  scrive), `mentions.ts` (le menzioni), `writes.ts` (`deliverMentions`,
  `ownMessage`), `reads.ts`;
- `data/model.ts:2181-2328`: i tipi;
- la parità in `apps/desktop/docs/area4-parity.md`.

**Branch**: si lavora su `feat/area4-f1-server` (stubwise-72, server) e sul
branch del renderer (stubwise-94), entrambi a cascata da
`feat/integrazione-area4`. Le migrazioni partono dalla **0135**.

## Cosa entra nella fetta 1 (D1)

- I **canali di progetto**: il «general» di ogni progetto (D8) e i canali
  aperti creati da chi ha `chat.channels.create`. Si possono rinominare,
  cambiare descrizione e argomento, archiviare ed eliminare, con
  `chat.channels.manage`. Il «general» non si archivia, non si elimina, e i
  suoi membri sono quelli del progetto.
- **Entrare e uscire** da un canale aperto. In un canale aperto scrive chi lo
  vede ed è membro.
- **I messaggi**: invio, thread a un livello, reazioni, modifica ed
  eliminazione solo dei propri (D6). Un messaggio eliminato non ha testo
  (CHECK). La conservazione è per sempre (D7).
- **Letti e non letti** per canale e per thread, e la preferenza del canale
  (`all|mentions|muted`).
- **Le menzioni** `@Nome` diventano card d'inbox `chat.mention` con push
  (D4). Avvisano solo chi legge il canale; `@channel` e `@reparto` mai
  (R-G6).
- **Lo stream** del canale (SSE), anche dal desktop via `openStream`.
- **I permessi**: tutti e 4 nel registro condiviso con i preset (D3); i
  generali si usano dalla fetta 2.

Fuori dalla fetta 1, nelle fette dopo:
- DM, canali privati, canali generali, ricerca, domande e «Da decidere»
  (`chat.question`): fetta 2;
- @Claude: fetta 3;
- eventi dei progetti e allegati: fetta 4.

## Global Constraints

1. **Chi vede lo decide il server, in UN modulo** (`chat-access.ts`), nella
   WHERE: un canale di progetto lo vede chi vede il progetto. Un canale non
   visibile è 404. Lista, lettura, stream, menzioni e notifiche passano tutte
   da lì, con un test di registro sulle rotte `/api/chat/*`.
2. **Il client legge i permessi calcolati** (`canWrite`, `canManage`,
   `canJoin`, `canEdit` e `canDelete` sul messaggio), non li deduce.
3. **Un messaggio eliminato non ha testo**, garantito da un CHECK. Ognuno
   elimina solo i propri.
4. **Le menzioni le ricava il server dal testo**, sui nomi delle persone che
   leggono il canale. Il client non manda l'elenco degli avvisati.
5. **Le card d'inbox si derivano a lettura** (la regola del repo):
   - nel jsonb solo `chatMessageId`, `channelId` e il nome di chi scrive al
     momento;
   - titolo, testo e link si derivano;
   - un messaggio eliminato o un canale non più visibile danno una card senza
     link (`objectGone`).
6. **Verso i client solo cambi additivi.** I kind nuovi passano da
   `readerSchema`; i campi nuovi delle risposte che il mobile legge (l'inbox)
   hanno un default.
7. **Il registro decisioni non si scrive mai** dalla Chat.
8. **Migrazioni**: `ALTER TYPE notification_kind ADD VALUE 'chat.mention'` va
   in uno statement a sé, e non si usa nello stesso batch.

## F1.1 (DB + shared), da pushare per primo

- **Migrazione 0135**:
  - `chat_channels`: id, `project_id` (FK CASCADE), kind
    `project|general|dm`, visibility `open|private`, name, description,
    topic, `is_general`, `created_by`, `archived_at`/`archived_by`,
    `published_events` text[], `created_at`/`updated_at`. Un solo «general»
    per progetto (indice unico parziale).
  - `chat_channel_members`: `(channel_id, user_id, joined_at)`.
  - `chat_messages`: id, `channel_id`, `author_id` (SET NULL), kind
    `person|system|claude`, `called_by_id`, `thread_root_id`, body,
    `asks_reply_of` uuid[], `created_at`, `edited_at`,
    `deleted_at`/`deleted_by`, `via_claude_action_id`. CHECK
    `deleted_at IS NULL OR body = ''`. Indici per canale e per thread.
  - `chat_reactions`: `(message_id, user_id, emoji)`.
  - `chat_reads`: `(user_id, channel_id, thread_root_id nullable,
    last_read_at)`.
  - `chat_channel_prefs`: `(user_id, channel_id, level)`.
  - Il «general» di ogni progetto esistente non archiviato, con i
    `published_events` predefiniti (D8).
  - I 4 permessi ai preset (D3), con `distinct unnest` come la 0114.
- **Migrazione 0136**: `ALTER TYPE notification_kind ADD VALUE
  'chat.mention'`, da sola.
- **Shared**:
  - i 4 permessi nel registro, con etichette e gruppi del web;
  - `chatChannelSchema` (vista per chi guarda: membri, `canWrite`,
    `canManage`, `canJoin`, `unread`, `mentions`, `level`);
  - `chatMessageSchema` (autore, kind, thread, `replyCount`, reazioni,
    `editedAt`, `deleted`, `canEdit`, `canDelete`, `viaClaude`);
  - i corpi (crea canale, modifica canale, invia, modifica, reazione, letto,
    preferenza);
  - le pagine (cursori);
  - lo stream (`messages`, `channel`);
  - la card d'inbox `chat.mention` (campi derivati con default);
  - test di parse senza i campi nuovi.

## F1.2 (server)

- `chat-access.ts`:
  - `channelVisibleSql(viewer)`;
  - `canWriteChannel`, `canManageChannel`: `chat.channels.manage` nel
    progetto, e il «general» mai;
  - `readersOf(channel)`, per le menzioni.
- Servizi `chat-channels.ts` e `chat-messages.ts`, con le rotte
  `/api/chat/...`:
  - lista dei canali per progetto e per chi guarda;
  - crea, modifica, archivia ed elimina un canale;
  - entra ed esci;
  - pagina di messaggi del canale e di un thread;
  - invia, modifica ed elimina un messaggio, reazione;
  - segna come letto;
  - preferenza del canale.
- **Menzioni** (`chat-mentions.ts`): `@Nome` sui nomi (`personName`) di chi
  legge il canale, autore escluso, con `publishNotification('chat.mention')`
  nella stessa transazione del messaggio. Chi è nominato in un thread lo
  segue. L'inbox deriva titolo, testo e link (`readChatMention`).
- **Stream**: un bus `chat` su LISTEN/NOTIFY con SSE
  `GET /api/chat/channels/:id/stream` (cursore `after`). La visibilità si
  rilegge a ogni giro, come lo stream delle sessioni.
- **Il «general» col progetto**: `createProject` lo crea nella stessa
  transazione. Un membro aggiunto o tolto dal progetto è anche nel
  «general», perché i membri sono quelli del progetto, derivati e non
  copiati.
- **Test**:
  - visibilità (un progetto che non vedi è 404; registro delle rotte);
  - permessi (creare, gestire, «general» intoccabile);
  - messaggi (thread, eliminazione senza testo, solo i propri);
  - menzioni (nome, R-G6, chi non legge non riceve; derivazione nell'inbox
    con un evento VECCHIO senza campi nuovi);
  - non letti;
  - stream.

## F1.3 (renderer, stubwise-94)

Il flag `chat` nella build app, `real/chat*.ts` sopra le rotte, la parità.

## Chiusura

- Parità in `apps/desktop/docs/integration-area4.md`.
- Deploy-log:
  - 0135–0136;
  - ⚠️ `chat.mention` è un `notification_kind` nuovo, quindi non è sicuro
    scendere d'immagine sul server finché ne esistono righe (500 su
    `/api/inbox`); il rollback le deve togliere;
  - l'ordine: server, poi caddy.
- Invarianti in `docs/invariants/chat.md`: chi vede, l'eliminazione senza
  testo, le menzioni del server, le card derivate.
- Registro: le voci dell'area 4 della fetta 1 vanno in «Chiuse», con i limiti.
