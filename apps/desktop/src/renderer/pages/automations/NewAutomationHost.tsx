import { useSyncExternalStore } from "react";
import { useProjects } from "../../data/queries";
import { onBeforePersonaChange } from "../../data/session";
import { CreateAutomationDialog } from "./CreateAutomationDialog";
import { useAutomationPerms } from "./shared";

// «New automation» da ⌘K (shape automations.md §6): il dialogo di
// creazione si apre sopra qualunque pagina. Chi lo apre chiama
// `openNewAutomation` col codice del progetto in cui si è (se c'è); il
// dialogo vive nel layout e si chiude al cambio di persona.

let openFor: { projectCode: string | null } | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

/** Apre «New automation»; dentro un progetto lo preimposta (se chi guarda vi può crearne). */
export function openNewAutomation(projectCode?: string): void {
  openFor = { projectCode: projectCode ?? null };
  emit();
}

export function closeNewAutomation(): void {
  if (!openFor) return;
  openFor = null;
  emit();
}

onBeforePersonaChange(closeNewAutomation);

export function NewAutomationHost() {
  const open = useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => openFor,
  );
  const perms = useAutomationPerms();
  const project = useProjects().data?.find((p) => p.code === open?.projectCode);
  if (!open) return null;
  return (
    <CreateAutomationDialog
      projectId={project && perms.inProject(project.id) ? project.id : undefined}
      onClose={closeNewAutomation}
    />
  );
}
