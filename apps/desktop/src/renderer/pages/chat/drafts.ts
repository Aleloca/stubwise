import { useSyncExternalStore } from "react";
import { onBeforePersonaChange } from "../../data/session";
import type { ComposerToken } from "../claude/conversation/useComposerField";

// La bozza della casella, per canale e per persona: sopravvive al cambio di
// canale (si ritrova tornando), sparisce al cambio di persona — nessun testo
// di chi guardava prima resta nella casella di chi guarda adesso. Vive solo
// in memoria, come il resto del prototipo; la colonna (Task 6) ne legge la
// presenza per la matita.

let drafts = new Map<string, string>();
// I gettoni della bozza (gli oggetti scelti col «#», o citati da «Cite in
// Chat»): restano con il testo, così una citazione entra nel messaggio con
// il suo oggetto qualunque strada abbia preso per arrivare nella casella.
let draftTokens = new Map<string, ComposerToken[]>();
const listeners = new Set<() => void>();

const key = (personId: string, channelId: string) => `${personId}\u0000${channelId}`;

function emit() {
  for (const l of listeners) l();
}

export function readDraft(personId: string, channelId: string): string {
  return drafts.get(key(personId, channelId)) ?? "";
}

export function writeDraft(personId: string, channelId: string, text: string): void {
  const k = key(personId, channelId);
  if ((drafts.get(k) ?? "") === text) return;
  drafts = new Map(drafts);
  if (text.trim()) drafts.set(k, text);
  else {
    drafts.delete(k);
    draftTokens.delete(k);
  }
  emit();
}

export function readDraftTokens(personId: string, channelId: string): ComposerToken[] {
  return draftTokens.get(key(personId, channelId)) ?? [];
}

export function writeDraftTokens(
  personId: string,
  channelId: string,
  tokens: readonly ComposerToken[],
): void {
  const k = key(personId, channelId);
  if (tokens.length > 0) draftTokens.set(k, [...tokens]);
  else draftTokens.delete(k);
}

/** Tutte le bozze via (il cambio di persona, un reset del prototipo). */
export function clearDrafts(): void {
  draftTokens = new Map();
  if (drafts.size === 0) return;
  drafts = new Map();
  emit();
}

onBeforePersonaChange(clearDrafts);

// «Reply in thread»: il pannello del thread si apre (o è già aperto) con il
// fuoco nella casella. La richiesta resta in attesa finché il pannello di
// quella radice non la prende.
let replyFocus: string | null = null;
const replyListeners = new Set<(rootId: string) => void>();

export function requestReplyFocus(rootId: string): void {
  replyFocus = rootId;
  for (const l of replyListeners) l(rootId);
}

/** Il pannello di `rootId` prende la richiesta (una volta). */
export function takeReplyFocus(rootId: string): boolean {
  if (replyFocus !== rootId) return false;
  replyFocus = null;
  return true;
}

export function onReplyFocus(fn: (rootId: string) => void): () => void {
  replyListeners.add(fn);
  return () => replyListeners.delete(fn);
}

onBeforePersonaChange(() => {
  replyFocus = null;
});

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** C'è una bozza della persona in quel canale (la matita della colonna). */
export function useHasDraft(personId: string, channelId: string): boolean {
  return useSyncExternalStore(subscribe, () => drafts.has(key(personId, channelId)));
}
