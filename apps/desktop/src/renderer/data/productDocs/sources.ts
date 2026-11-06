import { CLAUDE_ID, PEOPLE } from "../seed/people";
import { canSeeDriveFile } from "../drive/visibility";
import { canSeeMessage, canSeeTranscript } from "../mail/visibility";
import { state, visibleProjectIds } from "../store";
import type {
  FirstVersionSourceRef,
  MailMessage,
  MeetingTranscript,
  ProductSourceRef,
  ProductSourceView,
} from "../types";

// La fonte di una modifica di Claude, vista da chi legge (11b, §21): UNA
// funzione per segno, cronologia, card, Home, riga della prima versione e
// risposte del riquadro. Email e riunioni attribuite al progetto aggiornano
// la doc senza il consenso di chi le ha ricevute (decisione del
// maintainer, 5 nov 2026): il titolare si nomina sempre — è un membro del
// progetto — ma a chi non può aprirle l'oggetto, il testo e il link non
// escono MAI, in nessun campo. `mailbox_owner` resta valida per l'email
// stessa. Sincrona e senza cancello: la chiamano le letture, che hanno già
// quello di chi guarda.
//
// `ProductSourceRef.id` di una email è l'id della riga `MailMessage`; di
// una riunione, l'id della riga `MailMessage` dell'email di Gemini
// (`MeetingTranscript.messageId`).

const nameOf = (personId: string): string =>
  PEOPLE.find((p) => p.id === personId)?.name ?? personId;

const messageById = (id: string): MailMessage | undefined =>
  state.mailMessages.find((m) => m.id === id);

const transcriptOf = (messageId: string): MeetingTranscript | undefined =>
  state.meetingTranscripts.find((t) => t.messageId === messageId);

const isMember = (personId: string, projectId: string): boolean =>
  !!state.projectsById.get(projectId)?.memberIds.includes(personId);

/**
 * Il titolare di una email nel progetto: chi ha scelto il progetto
 * (`MailProposal.projectChosenById`) se c'è, altrimenti il primo dei
 * `mailboxPersonIds` che è membro. Nessuno dei due: Claude.
 */
function emailOwner(m: MailMessage, projectId: string): string {
  const chosen = state.mailProposals.find(
    (p) => p.source !== "calendar" && p.sourceId === m.messageId && p.projectId === projectId,
  )?.projectChosenById;
  if (chosen) return chosen;
  return m.mailboxPersonIds.find((id) => isMember(id, projectId)) ?? CLAUDE_ID;
}

/**
 * Il titolare di una riunione: l'organizzatore dell'evento collegato;
 * senza evento (o senza organizzatore in Stubwise), come per l'email di
 * Gemini che la racconta.
 */
function meetingOwner(t: MeetingTranscript, projectId: string): string {
  const event =
    t.eventId === null ? undefined : state.calendarEvents.find((e) => e.id === t.eventId);
  const organizer = event?.attendees.find((a) => a.organizer && a.personId)?.personId;
  if (organizer) return organizer;
  const m = messageById(t.messageId);
  if (!m) return CLAUDE_ID;
  return emailOwner(m, projectId);
}

/**
 * Chi agisce per una fonte (Global Constraints, «Chi agisce»): email, il
 * titolare sopra; riunione, l'organizzatore; decisione, task chiusa e
 * rilascio, Claude. Se il titolare non ha `docs.edit` nel progetto, il fatto
 * diventa una domanda (`decideFact`).
 */
export function sourceOwnerOf(ref: ProductSourceRef, projectId: string): string {
  switch (ref.kind) {
    case "email": {
      const m = messageById(ref.id);
      return m ? emailOwner(m, projectId) : CLAUDE_ID;
    }
    case "meeting": {
      const t = transcriptOf(ref.id);
      return t ? meetingOwner(t, projectId) : CLAUDE_ID;
    }
    default:
      return CLAUDE_ID;
  }
}

const date = (iso: string): number => Date.parse(iso);

const GONE = (kind: ProductSourceView["kind"]): ProductSourceView => ({
  kind,
  label: { key: "productDocs.source.gone" },
  code: null,
  link: null,
  ownerId: null,
  at: null,
  gone: true,
});

/**
 * La fonte come la legge `me`. `projectId` è il progetto della pagina ed è
 * OBBLIGATORIO: dice quale titolare vale quando la stessa email è in più
 * progetti, e senza non c'è un titolare giusto da indovinare.
 */
export function sourceViewOf(
  me: string,
  ref: ProductSourceRef | FirstVersionSourceRef,
  projectId: string,
): ProductSourceView {
  switch (ref.kind) {
    case "email": {
      const m = messageById(ref.id);
      if (!m) return GONE(ref.kind);
      const ownerId = emailOwner(m, projectId);
      if (canSeeMessage(me, m)) {
        return {
          kind: ref.kind,
          label: { key: "productDocs.source.email", params: { subject: m.subject } },
          code: null,
          link: `#/mail/${m.threadId}`,
          ownerId,
          at: m.at,
          gone: false,
        };
      }
      return {
        kind: ref.kind,
        label: {
          key: "productDocs.source.emailOf",
          params: { owner: nameOf(ownerId), date: date(m.at) },
        },
        code: null,
        link: null,
        ownerId,
        at: m.at,
        gone: false,
      };
    }
    case "meeting": {
      const t = transcriptOf(ref.id);
      const m = messageById(ref.id);
      if (!t || !m) return GONE(ref.kind);
      const event =
        t.eventId === null ? undefined : state.calendarEvents.find((e) => e.id === t.eventId);
      const ownerId = meetingOwner(t, projectId);
      const at = event?.startsAt ?? m.at;
      if (canSeeTranscript(me, t)) {
        return {
          kind: ref.kind,
          label: {
            key: "productDocs.source.meeting",
            params: { title: event?.title ?? t.docTitle },
          },
          code: null,
          link: `#/mail/${m.threadId}`,
          ownerId,
          at,
          gone: false,
        };
      }
      return {
        kind: ref.kind,
        label: {
          key: "productDocs.source.meetingOf",
          params: { owner: nameOf(ownerId), date: date(at) },
        },
        code: null,
        link: null,
        ownerId,
        at,
        gone: false,
      };
    }
    case "decision": {
      const d = state.decisionLog.find((x) => x.id === ref.id);
      if (!d) return GONE(ref.kind);
      // Le voci del registro non hanno codice: si cita il titolo e la data.
      if (!visibleProjectIds(me).has(d.projectId)) {
        return {
          kind: ref.kind,
          label: { key: "productDocs.source.decisionHidden" },
          code: null,
          link: null,
          ownerId: CLAUDE_ID,
          at: null,
          gone: false,
        };
      }
      return {
        kind: ref.kind,
        label: { key: "productDocs.source.decision", params: { title: d.title } },
        code: null,
        link: null,
        ownerId: CLAUDE_ID,
        at: d.decidedAt,
        gone: false,
      };
    }
    case "task": {
      const task = state.tasksById.get(ref.id);
      if (!task) return GONE(ref.kind);
      const seen = visibleProjectIds(me).has(task.projectId);
      return {
        kind: ref.kind,
        label: seen
          ? { key: "productDocs.source.task", params: { title: task.title } }
          : { key: "productDocs.source.taskHidden" },
        // Il codice c'è anche quando la task non si vede: `CodeLink` lo mostra tenue.
        code: task.code,
        link: null,
        ownerId: CLAUDE_ID,
        at: seen ? task.closedAt : null,
        gone: false,
      };
    }
    case "release": {
      const r = state.releases.find((x) => x.id === ref.id);
      if (!r) return GONE(ref.kind);
      const seen = visibleProjectIds(me).has(r.projectId);
      return {
        kind: ref.kind,
        label: seen
          ? { key: "productDocs.source.release", params: { title: r.title } }
          : { key: "productDocs.source.releaseHidden" },
        code: r.code,
        link: null,
        ownerId: CLAUDE_ID,
        at: seen ? r.mergedAt : null,
        gone: false,
      };
    }
    // Le due fonti che solo la prima versione ha (P31): il testo incollato,
    // di cui non resta il corpo, e un file del Drive del progetto, col suo
    // codice anche quando chi guarda non lo vede (`CodeLink` lo mostra tenue).
    case "text":
      return {
        kind: ref.kind,
        label: { key: "productDocs.source.text" },
        code: null,
        link: null,
        ownerId: null,
        at: null,
        gone: false,
      };
    case "drive": {
      const file = state.driveFiles.find((f) => f.id === ref.fileId);
      if (!file || file.unavailable === "deleted") return GONE(ref.kind);
      const seen = canSeeDriveFile(me, file, { includeHidden: true });
      return {
        kind: ref.kind,
        label: seen
          ? { key: "productDocs.source.drive", params: { name: file.name } }
          : { key: "productDocs.source.driveHidden" },
        code: file.code,
        link: null,
        ownerId: null,
        at: seen ? file.addedAt : null,
        gone: false,
      };
    }
    case "first_version":
      return {
        kind: ref.kind,
        label: { key: "productDocs.source.firstVersion" },
        code: null,
        link: null,
        ownerId: null,
        at: null,
        gone: false,
      };
  }
}
