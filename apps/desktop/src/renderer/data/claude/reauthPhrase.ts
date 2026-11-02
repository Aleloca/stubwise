import { visiblePeopleFor } from "../access/whoCan";
import { roleById } from "../admin/common";
import type { ProposedAction, Utterance } from "../model";
import { PEOPLE } from "../seed/people";
import { state, visibleProjectIds } from "../store";

// La frase della riconferma di una scheda C (area 10a, M1 della revisione
// finale): «To add Laura Costa to OLV as Developer, enter…» / «Per
// aggiungere Laura Costa a OLV come Developer, inserisci…». È all'infinito,
// una chiave per azione C (`claude.conversation.proposal.reauthAction.<fn>`),
// coi nomi di adesso letti per chi chiede (R-G5): il riassunto della scheda
// è all'imperativo e non si piega dentro «Per …».

/** Il nome di una persona, se chi chiede la vede. */
function personFor(me: string, id: unknown): string | null {
  if (typeof id !== "string" || !visiblePeopleFor(me).has(id)) return null;
  return PEOPLE.find((p) => p.id === id)?.name ?? null;
}

/** Il codice di un progetto, se chi chiede lo vede. */
function projectFor(me: string, id: unknown): string | null {
  if (typeof id !== "string" || !visibleProjectIds(me).has(id)) return null;
  return state.projectsById.get(id)?.code ?? null;
}

const roleFor = (id: unknown): string | null =>
  typeof id === "string" ? (roleById(id)?.name ?? null) : null;

const KEY = "claude.conversation.proposal.reauthAction";

/**
 * La frase all'infinito di un'azione C per chi la chiede; `null` se
 * l'azione non ne ha una (o i nomi non si possono dire): la pagina usa
 * allora la frase generica, mai il riassunto.
 */
export function reauthPhraseOf(me: string, action: Pick<ProposedAction, "fn" | "args">): Utterance | null {
  const { args } = action;
  switch (action.fn) {
    case "addMember":
    case "setMemberRole": {
      const name = personFor(me, args.personId);
      const code = projectFor(me, args.projectId);
      const role = roleFor(args.roleId);
      return name && code && role ? { key: `${KEY}.${action.fn}`, params: { name, code, role } } : null;
    }
    case "removeMember": {
      const name = personFor(me, args.personId);
      const code = projectFor(me, args.projectId);
      return name && code ? { key: `${KEY}.removeMember`, params: { name, code } } : null;
    }
    case "registerPlugin":
      return typeof args.url === "string"
        ? { key: `${KEY}.registerPlugin`, params: { url: args.url } }
        : null;
    case "updatePluginRef":
      return typeof args.ref === "string"
        ? { key: `${KEY}.updatePluginRef`, params: { ref: args.ref } }
        : null;
    case "saveStorage":
      return { key: `${KEY}.saveStorage` };
    default:
      return null;
  }
}
