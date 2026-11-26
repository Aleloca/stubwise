import { isFullAdmin } from "../data/access/index";
import { knownPeopleFor } from "../data/access/whoCan";
import { canReadChannel } from "../data/chat/visibility";
import { CLAUDE_ID, PEOPLE } from "../data/seed/people";
import { state, visibleProjectIds } from "../data/store";

// SOLO TEST (registro, A11 r.1414). Nel seme quasi tutti si conoscono: i
// canali di tutta l'azienda (ch-announcements) hanno tutti per membri, e «chi
// scrive in un canale che vedo è conosciuto» (decisione del maintainer del 23
// nov 2026). Uno sconosciuto si costruisce: una persona senza progetti in
// comune con chi guarda, tolta dai canali che chi guarda legge, coi suoi
// messaggi lì tolti. Lo stato si ripristina col `resetApi` dei test.

/** Chi non condivide con `viewerId` nessun progetto visibile (né è full admin). */
function candidatesFor(viewerId: string): string[] {
  const projects = visibleProjectIds(viewerId);
  const sharesProject = (id: string) =>
    state.projects.some((p) => projects.has(p.id) && p.memberIds.includes(id));
  return PEOPLE.map((p) => p.id).filter(
    (id) => id !== viewerId && id !== CLAUDE_ID && !isFullAdmin(id) && !sharesProject(id),
  );
}

/** Una persona (non full admin) che ha almeno `count` candidati a sconosciuti. */
export function viewerWithStrangers(count: number): string {
  const viewer = PEOPLE.find(
    (p) => p.id !== CLAUDE_ID && !isFullAdmin(p.id) && candidatesFor(p.id).length >= count,
  );
  if (!viewer) throw new Error(`viewerWithStrangers: nobody has ${count} candidates`);
  return viewer.id;
}

/**
 * Toglie `ids` dai canali che `viewerId` legge, coi loro messaggi lì: così
 * li conosce SOLO per i progetti (per provare disattivati ed ex membri senza
 * che un canale di tutta l'azienda li faccia conoscere comunque).
 */
export function withoutChannels(viewerId: string, ids: readonly string[]): void {
  for (const ch of state.channels) {
    if (!canReadChannel(viewerId, ch)) continue;
    ch.memberIds = ch.memberIds.filter((id) => !ids.includes(id));
  }
  const readable = new Set(
    state.channels.filter((ch) => canReadChannel(viewerId, ch)).map((c) => c.id),
  );
  state.chatMessages = state.chatMessages.filter(
    (m) => !(readable.has(m.channelId) && m.authorId !== null && ids.includes(m.authorId)),
  );
}

/** `count` persone che `viewerId` non conosce (costruite dal seme), o lancia. */
export function strangersTo(viewerId: string, count = 1): string[] {
  const chosen = candidatesFor(viewerId).slice(0, count);
  if (chosen.length < count) throw new Error(`strangersTo: only ${chosen.length} candidates`);
  withoutChannels(viewerId, chosen);
  const known = knownPeopleFor(viewerId);
  for (const id of chosen) if (known.has(id)) throw new Error(`strangersTo: ${id} is still known`);
  return chosen;
}
