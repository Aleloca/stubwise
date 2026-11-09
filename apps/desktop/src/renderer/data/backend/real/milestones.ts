import type * as Fake from "../../api";
import { appClient } from "./client";
import { toMilestone } from "./statuses";

// La gestione dei traguardi della build app (integrazione area 2, fetta 4):
// crea, modifica, chiudi/riapri, elimina sulle rotte `/api/milestones`, col
// permesso `tickets.edit` come nel prototipo. «Chiuso» è `status: "closed"`
// (la data di chiusura la scrive il server); la scadenza del prototipo è un
// giorno, sul filo un istante alla mezzanotte UTC.

const dueOf = (day: string | null | undefined) => (day ? `${day}T00:00:00.000Z` : null);
const descriptionOf = (text: string | undefined) => (text?.trim() ? text : null);

export const createMilestone: typeof Fake.createMilestone = async (projectId, input) =>
  toMilestone(
    await appClient().milestones.create({
      projectId,
      name: input.name.trim(),
      description: descriptionOf(input.description),
      dueDate: dueOf(input.dueDate),
    }),
  );

export const updateMilestone: typeof Fake.updateMilestone = async (id, patch) =>
  toMilestone(
    await appClient().milestones.update(id, {
      ...(patch.name !== undefined ? { name: patch.name.trim() } : {}),
      ...(patch.description !== undefined ? { description: descriptionOf(patch.description) } : {}),
      ...(patch.dueDate !== undefined ? { dueDate: dueOf(patch.dueDate) } : {}),
      ...(patch.closed !== undefined ? { status: patch.closed ? "closed" : "open" } : {}),
    }),
  );

/** Le task del traguardo restano, senza traguardo (lo fa il server). */
export const deleteMilestone: typeof Fake.deleteMilestone = (id) => appClient().milestones.remove(id);
