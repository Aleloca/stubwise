# App desktop, area 4: la Chat — piano di implementazione

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Costruire nel prototipo `apps/desktop` la Chat che sostituisce
Slack: canali di progetto e generali (aperti o privati), messaggi diretti,
thread, reazioni, menzioni, non letti, ricerca, citazioni di Stubwise,
@Claude, eventi dei progetti nei canali.

**Architecture:** Il modello della chat vive in `data/model.ts` con un
livello dati finto (`data/chat/*`: visibilità in una sola funzione,
letture, scritture con `need()`); i messaggi in arrivo passano dal motore
di stream esistente (`data/stream.ts`, un id di flusso per canale e per
thread) così l'arrivo dal vivo e le risposte di @Claude usano lo stesso
percorso. La UI (`pages/chat/*`) riusa i pezzi della conversazione con
Claude (Markdown, citazioni, Composer con «#»/«@», schede proposta).

**Tech Stack:** quello delle aree 1–3; nessuna dipendenza nuova (emoji:
un elenco fisso di emoji Unicode nel codice, nessuna libreria).

**Spec:** `docs/plans/2026-10-25-desktop-area4-chat-design.md` (approvato
25 ott 2026). Contesto: design area 3 (conversazione, citazioni, R-E9),
`apps/desktop/DESIGN.md`, `apps/desktop/docs/web-inventory.md` (voci
Slack).

## Global Constraints

- Tutte le Global Constraints delle aree 2–3 restano (nessuna rete; en/it con parità; temi; niente monospace salvo logo e codice; codice sempre con nome; colore mai unico segnale; movimento 150–250 ms con reduced-motion; pagine solo via `data/queries.ts`; stati completi; lint/typecheck/test verdi a ogni commit; orologio fisso del prototipo; Impeccable obbligatorio con gli shape approvati vincolanti).
- **Privacy** (maintainer): chi gestisce i canali vede nome e membri di un canale privato e può archiviarlo/eliminarlo, ma **non ne legge i messaggi**; i **messaggi diretti** li vede solo chi partecipa, **nemmeno il full admin**; ricerca, anteprime, citazioni, notifiche, «Da decidere» seguono le stesse regole. Una sola funzione decide (`canReadChannel`).
- **Solo i propri messaggi** si modificano/eliminano; una risposta di @Claude la elimina chi l'aveva chiamato. Un messaggio eliminato non ha più testo in nessun posto (stessa regola dei commenti).
- **@Claude**: ogni chiamata è di chi la fa (permessi di chi scrive, nessun controllo sulla pubblicazione); risponde nel thread; legge il thread come contesto; senza «@Claude» non risponde; proposte confermabili solo da chi le ha chieste, scadenza area 3 (20 messaggi del thread o 24 ore).
- **Storico per sempre**: nessuna scadenza dei messaggi.
- Permessi nuovi (prototipo, `data/viewer.ts`): progetto `chat.channels.create` (Project Lead, Developer), `chat.channels.manage` (Project Lead); istanza `chat.general.create` (tutti gli utenti), `chat.general.manage` (admin). Assegnabili a qualunque ruolo.
- Slack non esiste nell'app desktop (nessuna voce Slack nelle impostazioni o preferenze); il webhook in uscita resta all'area 9.

## Review Focus

1. **Admin e canale privato/DM**: Roberta (full admin) vede nome e membri di un privato a cui non appartiene ma nessun messaggio (lista, canale, ricerca, citazione, anteprima, notifica); un DM altrui non esiste per lei. → test in Task 2 e Task 7.
2. **Cambio di persona** con un canale o un thread aperto: nessun messaggio della persona precedente resta (inclusi bozza nella casella, thread aperto, «Nuovi»). → test in Task 4 e Task 5.
3. **Messaggio eliminato**: il testo sparisce dal canale, dal thread, dalla ricerca, dalle anteprime di citazione, dalle notifiche e da «Da decidere»; resta «Messaggio eliminato». → test in Task 2 e Task 7.
4. **@Claude chiamato da due persone nello stesso thread**: ogni risposta con i permessi di chi l'ha chiamato e «chiamato da X»; le proposte confermabili solo dal rispettivo richiedente. → test in Task 3.
5. **Contenuti estremi**: messaggio lunghissimo, blocco di codice largo, 300 messaggi, 40 reazioni diverse, nomi di canale lunghi in italiano: nessun overflow orizzontale, scorrimento stabile. → test in Task 4.

---

### Task 0 (controller): shape di Impeccable

Brief Impeccable `shape`, approvati dal maintainer, in `apps/desktop/.impeccable/shape/`: `chat.md` (destinazione Chat: colonna canali/DM/Thread/Menzioni, canale con flusso dei messaggi, riga «Nuovi», reazioni, conteggio thread, messaggi di sistema con scheda, casella), `chat-thread.md` (pannello thread, @Claude nel thread), `chat-manage.md` (nuovo canale, impostazioni del canale con eventi pubblicati, membri, archivia/elimina, nuovo messaggio diretto), `chat-search.md` (ricerca nella Chat e da ⌘K). Nessun codice.

### Task 1: Modello, permessi e seme della Chat

**Files:** Modify `data/model.ts`, `data/viewer.ts` (+test); Create `data/seed/chat/*.ts`; Test `data/seed.test.ts`.

**Interfaces — Produces (`model.ts`):**
```ts
export type ChannelKind = "project" | "general" | "dm";
export interface Channel { id: string; kind: ChannelKind; projectId: string | null; name: string; description: string; topic: string;
  visibility: "open" | "private"; createdById: string; archived: boolean; isGeneral: boolean /* the project «general» */;
  memberIds: string[]; publishedEvents: ChatEventKind[]; createdAt: string }
export type ChatEventKind = "release_page" | "pr_opened" | "pr_merged" | "milestone_reached" | "brief_ready" | "request_new" | "task_closed";
export interface ChatMessage { id: string; channelId: string; threadOf: string | null; authorId: string | null /* null = system */;
  kind: "person" | "system" | "claude"; calledById?: string; text: string; attachments: Attachment[];
  citations: CitationRef[]; reactions: { emoji: string; personIds: string[] }[]; asksReplyOf: string[] /* person ids asked a question */;
  alsoInChannel?: boolean; event?: { kind: ChatEventKind; ref: CitationRef }; linkedCodes: string[];
  createdAt: string; editedAt: string | null; deletedAt: string | null; deletedById: string | null;
  claudeEvents?: ConversationEvent[] /* actions/cards of a @Claude reply */ }
export interface ReadState { personId: string; channelId: string; lastReadAt: string; threadReads: Record<string, string> }
export type NotifyLevel = "all" | "mentions" | "muted";
```
`viewer.ts`: the four permissions with defaults from Global Constraints.
- [ ] Tests (seed): every project has one `isGeneral` channel whose members = project members; thematic channels (AUD «releases», MKX «grafica», one private on a project), generals «announcements», «marketing», «chit-chat»; DMs (1:1 and a group ≤8) incl. one Giulia–Marco; weeks of history with threads, reactions, citations to tasks/requests/doc pages/files, system events with refs to existing objects (a fake Release page object for `release_page`), one @Claude reply with a proposal; read states per person yielding different unread/mentions; a private channel Roberta is NOT in; messages in a project channel never cite objects of other projects invisible to its members (seed hygiene). Viewer tests for the four permissions.
- [ ] Commit `feat(desktop): modello e seme della Chat`.

### Task 2: Livello dati della Chat

**Files:** Create `data/chat/{visibility.ts,reads.ts,writes.ts}` (+`data/chat/chat.test.ts`); Modify `data/api.ts` (re-exports), `data/queries.ts` (hooks), `data/store.ts` (load seed, reset).

**Interfaces — Produces:**
- `canSeeChannel(me, ch)` (exists for me: open project channel → can see the project; open general → everyone; private → member, or manager of that scope; dm → participant) and `canReadChannel(me, ch)` (messages: open → as see; private → member only; dm → participant only). Single source for every read.
- Reads: `listChannels({ scope: "all" | "project", projectId? })` → rows with unread count, mention count, last activity, member flag; `getChannel(id)`; `listMessages(channelId, { before?, limit })` (top-level only, with thread summaries); `listThread(messageId)`; `listThreadsWithNews()`; `listMentions()`; `searchChat(q, filters)` (only readable channels; deleted messages excluded); `listChannelMembers(id)`.
- Writes (all with `need()` and visibility, refusals leave state unchanged): `sendMessage(channelId, { text, attachments, threadOf?, alsoInChannel? })` (must be member; open channel auto-join on first send *(scelta)*), `editMessage`/`deleteMessage` (own only; Claude reply: deletable by `calledById`), `toggleReaction`, `markRead(channelId, at?)`, `markThreadRead`, `setNotifyLevel`, `joinChannel`/`leaveChannel` (not the project general), `createChannel` (`chat.channels.create` / `chat.general.create`), `updateChannel`/`archiveChannel`/`deleteChannel` (creator or `*.manage`), `inviteMembers`/`removeMember` (private: creator or manage; project private: only project members), `openDm(personIds)` (≤8, finds existing), `createTaskFromMessage`/`createRequestFromMessage` (existing create mutations + `linkedCodes` on the message), `setPublishedEvents`.
- Mentions: parsing `@persona`, `@reparto` (members of the channel in that department), `@canale`, `@Claude`; mentions produce notifications for readers who can read the channel; a mention that is a question («?» or flag) adds a `chat_question` decision for that person until they reply in the thread/channel or dismiss.
- System events: `publishChatEvent(projectId, kind, ref)` posts to channels whose `publishedEvents` include it; wired into existing mutations (milestone closed → reached, brief, PR opened/merged in run scripts, request created, task closed) through one helper.
- Live arrival: posting appends through `runScript` on stream id `chat:<channelId>` (single emission path); hook `useChannelStream(channelId)` merges new messages.
- [ ] Tests: visibility matrix incl. Review Focus 1 (Roberta: private existence yes, messages no; DM no); Review Focus 3 (deleted text absent from channel, thread, search, mention/decision payloads); unread/mention counts with mute and system events; permissions for each write; auto-join; DM ≤8 and dedupe; events posted only where enabled; persona-scoped keys.
- [ ] Commit `feat(desktop): livello dati della Chat`.

### Task 3: @Claude nei thread

**Files:** Create `data/chat/claude.ts` (+test); Modify `data/chat/writes.ts`.

**Interfaces — Produces:** `sendMessage` detects «@Claude»; a reply message `kind:"claude"`, `calledById`, `threadOf` = the root (or the thread of the calling message) is created and filled through `runScript` on `chat:thread:<rootId>` with text chunks, action rows and proposal events (`claudeEvents`), produced by `respond(text, ctx)` of `domain/claude/intents.ts` run **as the caller** with the thread's messages (readable to the caller) as context; proposals confirmed via the existing `confirmProposal` path adapted to chat messages (requester only; expiry 20 thread messages / 24h).
- [ ] Tests: Review Focus 4 (two callers in one thread: two replies, each «called by», each proposal confirmable only by its requester); no reply without «@Claude»; reply in thread even when called in the channel root; caller-permission reads (Giulia can explain an AUD task even if others in the channel can't — maintainer accepted); deleting a Claude reply only by its caller.
- [ ] Commit `feat(desktop): @Claude nei thread della Chat`.

### Task 4: Canale — flusso dei messaggi e casella

**Files:** Create `pages/chat/{ChannelView,MessageList,MessageItem,Reactions,SystemCard,MessageMenu,ChatComposer}.tsx` (+tests); reuse `tasks-ui/Markdown.tsx`, `pages/claude/conversation/{citations,MentionMenu,AttachmentChip,ProposalCard,ActionRows}`.

Comportamenti (spec «Messaggi», «Citazioni», shape `chat.md`): flusso con raggruppamento per autore/minuti, riga «Nuovi», giorni separati, messaggi di sistema come schede, reazioni (più usate + selettore, chi al passaggio), «N risposte · ultima di X» che apre il thread, menu del messaggio (Rispondi nel thread, Reagisci, Copia link, Crea task, Crea richiesta, Modifica/Elimina se propri), «modificato», «Messaggio eliminato», citazioni con codice+nome e anteprima (R-E9 per invisibili), casella con «#»/«@» (incl. @Claude, @canale, @reparto), allegati, invio con Invio, bozza per canale, «non inviato · Rimanda». Canale archiviato in sola lettura; non membro di un aperto: «Entra nel canale».
- [ ] Tests: Review Focus 2 (persona switch clears flow, draft, «Nuovi»); Review Focus 5 (long/wide/many: no page overflow, stable scroll); reactions toggle; edit/delete own only; create task from message links back; system card opens the object; invisible citation faint.
- [ ] Commit `feat(desktop): canale della Chat`.

### Task 5: Pannello del thread

**Files:** Create `pages/chat/ThreadPanel.tsx` (+test).

Pannello a destra (docked ≥1200, overlay sotto, `useDetailPanel`), messaggio radice, risposte, casella con «Rispondi anche nel canale», risposte di @Claude in diretta con righe d'azione e proposte (stesso aspetto della conversazione), segna letto. Route `?thread=<messageId>` validata.
- [ ] Tests: open/close, live Claude reply streams in, proposal buttons only for the caller, also-in-channel shows in both, persona switch closes it.
- [ ] Commit `feat(desktop): thread della Chat`.

### Task 6: Destinazione Chat, canali nel progetto, gestione

**Files:** Create `pages/chat/{ChatPage,ChatColumn,NewChannelDialog,ChannelSettings,NewDmDialog,MentionsView,ThreadsView}.tsx` (+tests); Modify `router.tsx` (`/chat`, `/chat/$channelId`, project section `chat`), `layout/PersonalColumn.tsx`, `layout/ProjectColumn.tsx`, `palette/commands.ts` («New message», «Go to channel…»).

Colonna: Canali raggruppati per progetto poi generali (non letti in grassetto, conteggio menzioni), Messaggi diretti, «Thread», «Menzioni», «Nuovo messaggio»; la sezione Chat del progetto mostra gli stessi canali del progetto. Nuovo canale (scope, nome, descrizione, aperto/privato, membri iniziali per privato) con i permessi; impostazioni del canale (nome, descrizione, argomento, eventi pubblicati, notifiche, membri, invita/rimuovi, archivia, elimina con conferma) con i permessi; nuovo DM (≤8). Privato visto da chi gestisce ma non membro: pagina con nome, membri, archivia/elimina e «Non puoi leggere i messaggi di questo canale».
- [ ] Tests: column grouping per persona; same channel in global and project section (same unread); create/manage gated; Roberta sees private existence page, no messages; DM of others absent.
- [ ] Commit `feat(desktop): destinazione Chat e gestione dei canali`.

### Task 7: Ricerca nella Chat e da ⌘K

**Files:** Create `pages/chat/ChatSearch.tsx` (+test); Modify `palette/*` (chat results group).

Barra in testa alla Chat con filtri (canale, persona, data, con allegati, con citazioni), risultati raggruppati per canale con contesto, clic → messaggio evidenziato (anche nel thread); in ⌘K un gruppo «Messaggi».
- [ ] Tests: only readable channels (Review Focus 1); deleted excluded (Review Focus 3); filters; jump highlights.
- [ ] Commit `feat(desktop): ricerca nella Chat`.

### Task 8: Menzioni, notifiche, «Da decidere» e segnali

**Files:** Modify `pages/home/blocks/DecideBlock.tsx` (+test), notifications (chat mention kinds), `layout/Rail.tsx` (Chat unread dot).

Menzioni dirette nelle notifiche (apri → messaggio); domande rivolte a te in «Da decidere» con «Rispondi» (apre il thread) e «Ignora»; si chiudono rispondendo; segnale non letti sulla voce Chat del binario (punto, nessun numero, come le tessere).
- [ ] Tests: mention notification only if readable; question appears and closes on reply; dismiss; rail dot; persona switch.
- [ ] Commit `feat(desktop): menzioni e domande della Chat`.

### Task 9: Parità, screenshot, follow-up

`apps/desktop/docs/area4-parity.md`: voci Slack dell'inventario (impostazioni Slack, identità Slack, DM Slack, invito da Slack, comando slash, domande dell'agente nei DM) → «sostituite dalla Chat» con il posto che le sostituisce e il test; webhook in uscita → «area 9»; buchi se ce ne sono (non costruiti). `capture.mjs`: scatti a4-* (Chat con canale, thread con @Claude, privato visto da Roberta, impostazioni canale, ricerca, Da decidere con domanda) light/dark, en/it, 1440 e 1024; vite ucciso. «Area 4 — minori aperti» in `ossatura-follow-ups.md`. Suite, typecheck, lint, build verdi. Commit `docs(desktop): parità dell'area 4`.

Dopo il Task 9: revisione finale del branch (area 4) e revisione visiva di Impeccable.
