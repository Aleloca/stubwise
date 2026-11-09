import { PEOPLE } from "../seed/people";
import { chatKey, state, visibleProjectIds } from "../store";
import type { Channel, ChannelPermissions, NotifyLevel } from "../types";
import { can, viewerFor } from "../viewer";

// Chi vede e chi legge un canale della Chat: l'unica regola, per ogni
// lettura (elenchi, flusso, thread, ricerca, citazioni, anteprime,
// notifiche, «Da decidere») e per lo stream. Vedere = sapere che esiste
// (nome e membri); leggere = i messaggi. Privacy (maintainer): chi gestisce
// i canali vede un privato ma non ne legge i messaggi; un DM esiste solo per
// chi partecipa, nemmeno per il full admin.

const HUMANS: ReadonlySet<string> = new Set(PEOPLE.filter((p) => !p.isClaude).map((p) => p.id));

/** Una persona che usa la Chat (Claude no: si chiama con «@Claude», non è membro di nulla). */
export const isHuman = (id: string): boolean => HUMANS.has(id);

/**
 * I membri di adesso. Il «general» di un progetto non ha un elenco suo: sono
 * i membri del progetto (Claude escluso), sempre, anche quando cambiano.
 */
export function membersOf(ch: Channel): string[] {
  if (ch.isGeneral && ch.projectId !== null) {
    return (state.projectsById.get(ch.projectId)?.memberIds ?? []).filter(isHuman);
  }
  return ch.memberIds;
}

export const isMember = (personId: string, ch: Channel): boolean =>
  membersOf(ch).includes(personId);

/** Chi gestisce i canali di quell'ambito: `chat.channels.manage` nel progetto o `chat.general.manage`. Mai un DM. */
export function managesScope(personId: string, ch: Channel): boolean {
  if (ch.kind === "dm") return false;
  const viewer = viewerFor(personId);
  if (ch.kind === "project") {
    return ch.projectId !== null && can(viewer, "chat.channels.manage", ch.projectId);
  }
  return can(viewer, "chat.general.manage");
}

/** Il creatore o chi gestisce l'ambito: modifica, archivia, invita in un privato (eliminare: solo chi gestisce). */
export const managesChannel = (personId: string, ch: Channel): boolean =>
  ch.kind !== "dm" && (ch.createdById === personId || managesScope(personId, ch));

const projectVisible = (personId: string, ch: Channel): boolean =>
  ch.kind !== "project" || (ch.projectId !== null && visibleProjectIds(personId).has(ch.projectId));

/**
 * Il canale esiste per questa persona: aperto di progetto → chi vede il
 * progetto; aperto generale → tutti; privato → i membri e chi gestisce
 * quell'ambito; DM → solo chi partecipa.
 */
export function canSeeChannel(personId: string, ch: Channel): boolean {
  if (!isHuman(personId)) return false;
  if (ch.kind === "dm") return isMember(personId, ch);
  if (!projectVisible(personId, ch)) return false;
  if (ch.visibility === "open") return true;
  return isMember(personId, ch) || managesScope(personId, ch);
}

/**
 * La persona ne legge i messaggi: aperto → chi lo vede; privato e DM → solo
 * i membri (chi gestisce no). Un archiviato si legge come prima.
 */
export function canReadChannel(personId: string, ch: Channel): boolean {
  if (!canSeeChannel(personId, ch)) return false;
  return ch.visibility === "open" || isMember(personId, ch);
}

/** Le notifiche della persona per il canale; senza preferenza, `all`. */
export const notifyLevelOf = (personId: string, channelId: string): NotifyLevel =>
  state.chatNotify.get(chatKey(personId, channelId)) ?? "all";

/** Cosa può fare la persona in un canale che vede (la UI li legge, non li deduce). */
export function channelPermissions(personId: string, ch: Channel): ChannelPermissions {
  const members = membersOf(ch);
  const member = members.includes(personId);
  const canRead = canReadChannel(personId, ch);
  const manager = managesChannel(personId, ch);
  const live = !ch.archived;
  const dm = ch.kind === "dm";
  // Il «general» segue il progetto: nessuno entra, esce, invita o toglie a mano.
  const fixedMembers = ch.isGeneral || dm;
  return {
    canRead,
    isMember: member,
    canWrite: member && canRead && live,
    canJoin: !member && canRead && live && !fixedMembers && ch.visibility === "open",
    // Un DM a due non si lascia; un gruppo sì. Un privato non resta senza membri.
    canLeave:
      member &&
      !ch.isGeneral &&
      (dm ? members.length > 2 : ch.visibility === "open" || members.length > 1),
    canEditInfo: manager && live && !dm,
    canEditTopic: member && live && !dm,
    canEditEvents: manager && live && ch.kind === "project",
    canInvite: live && !fixedMembers && (ch.visibility === "private" ? manager : member || manager),
    canRemove: manager && live && !fixedMembers,
    canArchive: manager && !ch.isGeneral && !dm,
    // Eliminare: solo chi gestisce i canali dell'ambito (R-G3), non il creatore.
    canDelete: managesScope(personId, ch) && !ch.isGeneral && !dm,
  };
}
