import type { Department, Person, Project } from "../../../data/types";
import { labelled, resulted, summarized, type Answer, type ReadAction } from "../answers";
import type { IntentContext } from "../context";
import { findProject, isHowToQuestion, normalize, QUESTION, stripCourtesy } from "../parse";

// S5 (area 10b, Task 7): «invita Luca come Developer in ACQ», «add Luca to
// ACQ as Developer». Una persona che chi chiede vede diventa una scheda C con
// `addMember` (avvisa chi entra, D4, e chiede il codice); più persone col
// nome, o un ruolo che non c'è, una scheda di scelta; nessuna persona, la
// riga D verso il dialogo «Invite» già compilato — il link d'invito è un
// segreto e lo crea l'app, mai Claude. Chi può cosa lo dice il livello dati
// (`canGrantRole`, `canInvitePeople`); il motore non lo deduce.

const K = "claude.answers.member";

/** Il verbo e la persona in testa: «add Luca», «invita Luca Bianchi». */
const VERB = /^(add|invite|aggiungi|invita)\s/;
const VERB_INF = /^(aggiungere|invitare)\s/;
/** Il nome dopo il verbo, nel testo originale: parole maiuscole (non un codice). */
const NAME =
  /\b(?:add|invite|aggiungi|invita|aggiungere|invitare)\s+([A-ZÀ-Ý][\p{Ll}'’-]+(?:\s+[A-ZÀ-Ý][\p{Ll}'’-]+)?)/u;
/** Il ruolo annunciato: «as Developer», «come Developer». */
const AS_ROLE = /\b(as|come)\s+\S/;
/** Un codice di progetto dopo una preposizione: «to ACQ», «ad ACQ», «in ACQ». */
const TO_PROJECT = /\b(?:to|into|in|ad|a|al|nel|per)\s+([A-Z]{2,4})\b/;

/**
 * «add Luca to ACQ as Developer», «invita Luca come Developer in ACQ».
 * Un comando (non una domanda: «come si aggiunge un membro?» resta a
 * `howto`, ruling T6 I1) con un nome proprio dopo il verbo; «add» vuole il
 * ruolo annunciato, così «add “Banner” to AUD» resta la creazione di una task.
 */
export function isMemberRequest(text: string): boolean {
  if (isHowToQuestion(text) || /["“«]/.test(text)) return false;
  const { polite, command } = stripCourtesy(normalize(text));
  if (!polite && QUESTION.test(command)) return false;
  if (!VERB.test(command) && !(polite && VERB_INF.test(command))) return false;
  if (!NAME.test(text)) return false;
  const invite = /^(invite|invita|invitare)\b/.test(command);
  return invite || AS_ROLE.test(command);
}

/** Il «a»/«ad» italiano davanti al codice: lo sceglie la frase (contesto `vowel`). */
const vowel = (code: string): { context?: string } =>
  /^[AEIOU]/i.test(code) ? { context: "vowel" } : {};

const say = (actions: ReadAction[], text: string): Answer => ({ actions, text });

export async function member(text: string, ctx: IntentContext): Promise<Answer> {
  const { read, t } = ctx;
  const name = NAME.exec(text)?.[1] ?? "";

  // Il progetto: nominato e visibile, o «non lo trovo» — identico per un
  // progetto invisibile e per uno che non c'è (R-G5).
  const projects = await read.listProjects();
  const asked = TO_PROJECT.exec(text)?.[1];
  const project = asked
    ? (projects.find((p) => p.code === asked) ?? null)
    : findProject(text, projects, ctx.contextProjectId).project;
  if (asked && !project) {
    return say([], t("claude.answers.status.projectNotFound", { code: asked }));
  }
  if (!project) return say([], t(`${K}.noProject`, { name }));
  if (!name) return say([], t(`${K}.noName`, { code: project.code, ...vowel(project.code) }));

  const roles = await read.listProjectRoles();
  const role = roleIn(text, roles);

  // La persona, fra quelle che chi chiede vede; una risposta di una scheda
  // («Luca Rinaldi») sceglie fra quelle col nome.
  const people = await read.findPeople(name);
  const lookup: ReadAction = {
    tool: "list_users",
    ...labelled(t, "claude.answers.actions.lookupPerson", { name }),
    ...resulted(t, "claude.answers.actions.people", { count: people.length }),
  };
  const plain = normalize(text);
  const named = people.filter((p) => plain.includes(normalize(p.name)));
  const person = people.length === 1 ? people[0]! : named.length === 1 ? named[0]! : null;

  if (people.length === 0) return invite(ctx, lookup, name, project, role);

  // Chi non gestisce i membri lì non riceve una scheda che non potrebbe
  // confermare: lo dice, col «Who?». Non dipende dal ruolo.
  const anyRole = role ?? roles[0];
  if (!anyRole || (await read.canGrantRole(project.id, anyRole.id)) === "forbidden") {
    return {
      actions: [lookup],
      text: `${t(`${K}.cantAdd`, { code: project.code, ...vowel(project.code) })} [${t("claude.answers.refused.who")}](who:manageMembers/${project.code})`,
    };
  }

  if (!person) {
    if (!ctx.asks) return say([lookup], t(`${K}.several`, { name }));
    const departments = await read.listDepartments();
    return {
      actions: [lookup],
      text: "",
      ask: {
        text: t(`${K}.whichPerson`, { name, code: project.code, ...vowel(project.code) }),
        // Nessuna consigliata: sarebbe una scelta di Claude presentata come un fatto [SC 9].
        options: people.map((p) => ({ label: personLabel(p, departments) })),
      },
    };
  }

  const current = await read.memberRoleOf(project.id, person.id);
  if (current !== null) {
    const was = roles.find((r) => r.id === current)?.name ?? "";
    return say([lookup], t(`${K}.already`, { name: person.name, code: project.code, role: was }));
  }

  if (!role) {
    const params = { name: person.name, code: project.code };
    if (!ctx.asks) {
      return say(
        [lookup],
        t(`${K}.roleNeeded`, { ...params, roles: roles.map((r) => r.name).join(", ") }),
      );
    }
    return {
      actions: [lookup],
      text: "",
      // I ruoli di progetto nell'ordine dei preset; nessuno consigliato.
      ask: { text: t(`${K}.whichRole`, params), options: roles.map((r) => ({ label: r.name })) },
    };
  }

  const grant = await read.canGrantRole(project.id, role.id);
  return {
    actions: [lookup],
    // Nessun pronome per chi entra: il nome dice abbastanza [SC 13].
    text: t(`${K}.exists`, { name: person.name }),
    refs: [{ kind: "project", id: project.id }],
    proposal: [
      {
        fn: "addMember",
        args: { projectId: project.id, personId: person.id, roleId: role.id },
        ...summarized(t, `${K}.summary`, {
          name: person.name,
          code: project.code,
          role: role.name,
          ...vowel(project.code),
        }),
      },
    ],
    ...(grant === "escalation" ? { blocked: { kind: "escalation" as const, roleId: role.id } } : {}),
  };
}

/**
 * Il ruolo nominato: l'ultimo che compare nel testo (la risposta di una
 * scheda si accoda alla richiesta), a parola intera e senza maiuscole.
 */
function roleIn(
  text: string,
  roles: { id: string; name: string }[],
): { id: string; name: string } | null {
  const plain = normalize(text);
  let best: { role: { id: string; name: string }; at: number } | null = null;
  for (const role of roles) {
    const word = normalize(role.name).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    for (const m of plain.matchAll(new RegExp(`(^|[^a-z0-9])${word}(?=$|[^a-z0-9])`, "g"))) {
      if (!best || m.index! > best.at) best = { role, at: m.index! };
    }
  }
  return best?.role ?? null;
}

/** «Luca Bianchi · Sales»: il nome e i reparti, per distinguere le persone. */
function personLabel(p: Person, departments: Department[]): string {
  const names = p.departmentIds.flatMap((id) => {
    const d = departments.find((x) => x.id === id);
    return d ? [d.name] : [];
  });
  return names.length > 0 ? `${p.name} · ${names.join(", ")}` : p.name;
}

/**
 * Nessuna persona col nome: un invito vero lo crea l'app, e il suo link è un
 * segreto — mai nel testo né nell'indirizzo. Chi può invitare ha la riga D
 * verso il dialogo «Invite» con progetto e ruolo scelti e l'email vuota; chi
 * non può, la frase col «Who?» d'istanza (ruling del controller, Q2).
 */
async function invite(
  ctx: IntentContext,
  lookup: ReadAction,
  name: string,
  project: Project,
  role: { id: string; name: string } | null,
): Promise<Answer> {
  const { read, t } = ctx;
  const first = t(`${K}.noPerson`, { name });
  if (!(await read.canInvitePeople())) {
    return {
      actions: [lookup],
      text: `${first} ${t(`${K}.cantInvite`)} [${t("claude.answers.refused.who")}](who:invitePeople)`,
    };
  }
  const query = new URLSearchParams({ invite: "1", inviteProject: project.code });
  if (role) query.set("inviteRole", role.id);
  return {
    actions: [lookup],
    text: first,
    place: {
      route: `#/admin/people?${query.toString()}`,
      labelKey: role ? `${K}.openInvite` : `${K}.openInviteNoRole`,
      labelParams: { code: project.code, ...(role ? { role: role.name } : {}), ...vowel(project.code) },
    },
  };
}
