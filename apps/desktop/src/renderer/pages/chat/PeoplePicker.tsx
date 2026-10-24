import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { useDepartments } from "../../data/queries";
import type { Person } from "../../data/types";
import { CheckBox } from "../../tasks-ui/Menu";
import { inputClass } from "../../tasks-ui/Dialog";
import { ChatAvatar } from "./MessageItem";

// Il selettore di persone della Chat (membri di un privato nuovo, «Add
// people», il «To:» di un messaggio diretto): ricerca per nome e reparto,
// righe 36px con avatar, nome e reparto, una casella per riga. Una riga
// può essere disattivata con il suo motivo scritto accanto («Already in»,
// «Ask a member to add you»): mai un clic che non fa nulla in silenzio.

const fold = (s: string) =>
  s
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase();

export function PeoplePicker({
  label,
  candidates,
  selected,
  onToggle,
  disabledReason,
  limitReached = false,
  autoFocus = false,
}: {
  label: string;
  candidates: Person[];
  selected: readonly string[];
  onToggle: (personId: string) => void;
  /** Perché una persona non si può scegliere (`null` = si può). */
  disabledReason?: (personId: string) => string | null;
  /** Il massimo è raggiunto: le non scelte non si aggiungono più. */
  limitReached?: boolean;
  autoFocus?: boolean;
}) {
  const { t } = useTranslation();
  const departments = useDepartments().data;
  const [q, setQ] = useState("");
  const searchId = useId();
  const deptName = (p: Person) =>
    p.departmentIds
      .map((id) => departments?.find((d) => d.id === id)?.name)
      .filter(Boolean)
      .join(", ");
  const needle = fold(q.trim());
  const shown = candidates
    .filter((p) => !needle || fold(`${p.name} ${deptName(p)}`).includes(needle))
    .sort((a, b) => a.name.localeCompare(b.name));
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <label htmlFor={searchId} className="sr-only">
        {label}
      </label>
      <input
        id={searchId}
        type="search"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder={t("chat.people.search")}
        data-autofocus={autoFocus || undefined}
        className={inputClass}
      />
      <ul
        aria-label={label}
        className="flex max-h-[216px] min-w-0 flex-col overflow-y-auto rounded-md border border-rule"
      >
        {shown.length === 0 && (
          <li className="px-3 py-2 text-sm text-ink-muted">{t("chat.people.noMatch")}</li>
        )}
        {shown.map((p) => {
          const checked = selected.includes(p.id);
          const reason = disabledReason?.(p.id) ?? null;
          const disabled = reason !== null || (limitReached && !checked);
          const dept = deptName(p);
          return (
            <li key={p.id}>
              <label
                data-person-option={p.id}
                className={`flex h-9 min-w-0 items-center gap-2.5 px-3 text-md has-[:focus-visible]:outline-2 has-[:focus-visible]:-outline-offset-2 has-[:focus-visible]:outline-focus ${
                  disabled ? "cursor-default text-ink-faint" : "cursor-pointer hover:bg-ink/6"
                }`}
              >
                <input
                  type="checkbox"
                  className="sr-only"
                  checked={checked}
                  disabled={disabled}
                  onChange={() => onToggle(p.id)}
                />
                <CheckBox checked={checked} />
                <ChatAvatar person={p} size={24} />
                <span className="min-w-0 flex-1 truncate">
                  <span className={disabled ? "" : "text-ink"}>{p.name}</span>
                  {dept && <span className="ml-2 text-sm text-ink-muted">{dept}</span>}
                </span>
                {reason && <span className="shrink-0 text-xs text-ink-faint">{reason}</span>}
              </label>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
