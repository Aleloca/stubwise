import { useTranslation } from "react-i18next";
import { usePeople } from "../data/queries";
import type { Person } from "../data/types";

/**
 * Il dischetto delle iniziali. Una persona: inchiostro al 10%, nessun colore
 * proprio (il colore pieno di una riga è già la striscia del reparto della
 * task). Claude: lo stesso disco senza fondo, con l'anello tratteggiato
 * d'inchiostro dell'ossatura — si distingue per FORMA, come sul binario.
 * Senza assegnatario: il solo contorno pieno, vuoto.
 */
export function Avatar({ person }: { person: Person | null | undefined }) {
  const base = "grid size-[22px] shrink-0 place-items-center rounded-full text-xs font-semibold";
  if (!person) {
    return <span aria-hidden="true" className={`${base} border border-rule-strong`} />;
  }
  if (person.isClaude) {
    return (
      <span
        aria-hidden="true"
        data-claude-ring
        className={`${base} border-[1.5px] border-dashed border-claude text-ink`}
      >
        {person.initials}
      </span>
    );
  }
  return (
    <span aria-hidden="true" className={`${base} bg-ink/10 text-ink`}>
      {person.initials}
    </span>
  );
}

/**
 * Una persona (o Claude) accanto a una task: iniziali e nome. Il nome si
 * può nascondere (`nameClassName`, es. sotto una certa larghezza della riga)
 * restando per i lettori di schermo: lo dice `title` al passaggio.
 * `null` = non assegnata.
 */
export function PersonChip({
  personId,
  nameClassName = "",
}: {
  personId: string | null;
  nameClassName?: string;
}) {
  const { t } = useTranslation();
  const people = usePeople().data;
  const person = personId ? people?.find((p) => p.id === personId) : null;
  // In caricamento (persona attesa ma non ancora letta) resta solo lo spazio.
  if (personId && !person) {
    return <span data-person={personId} className="block h-[22px]" />;
  }
  const name = person ? personName(t, person) : t("taskUi.unassigned");
  return (
    <span
      data-person={personId ?? "none"}
      title={name}
      className="flex min-w-0 items-center gap-2 text-sm"
    >
      <Avatar person={person} />
      <span
        className={`truncate ${person && !person.deactivated ? "text-ink-muted" : "text-ink-faint"} ${nameClassName}`}
      >
        {name}
      </span>
    </span>
  );
}

/**
 * Il nome di chi è assegnato a una task: «Marco Bellini (deactivated)» se
 * la persona è disattivata (area 9a, RF 4). `deactivated` lo calcola il
 * livello dati (`listPeople`, come `assigneeStatus` della task): qui si legge.
 */
export function personName(
  t: (key: string, opts?: Record<string, unknown>) => string,
  person: Person,
): string {
  return person.deactivated ? t("taskUi.deactivatedName", { name: person.name }) : person.name;
}
