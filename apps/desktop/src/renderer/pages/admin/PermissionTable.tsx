import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { groupsFor, type AccessScope } from "../../domain/access/actions";
import { inputClass } from "../../tasks-ui/Dialog";
import { CheckBox } from "../../tasks-ui/Menu";
import { Switch } from "../preferences/SubscriptionRow";
import { capitalized, usePermissionHint, usePermissionWords } from "./parts";

// La tabella dei permessi (shape admin-roles-members.md, «PermissionTable»),
// condivisa da Roles, Departments e Members: i permessi sono un elenco di
// frasi, non una griglia di sigle [RM 1]. Gruppi nell'ordine del web (gli 11
// di `permission-groups.ts`) più «Prototype» per i permessi che vivono solo
// nel prototipo; ogni riga è casella · nome · frase · a destra il contesto
// (perché è spenta, o da dove viene). La chiave tecnica sta solo nel `title`.
//
// La tabella non decide niente: cosa è spento e perché lo passa chi la usa,
// leggendolo dal livello dati (`notGivable`, le fonti di Members).

/** Il contesto di una riga, a destra: il motivo per cui è spenta o la sua fonte. */
export interface RowContext {
  /** Le parole brevi a destra («You don't have this», «From the Developer role»). */
  short: string;
  /** La frase lunga, letta da chi usa un lettore di schermo (`aria-describedby`). */
  long?: string;
  /** La casella non si cambia (spenta per escalation, o la spunta viene da altrove). */
  locked: boolean;
  /** Spuntata anche se non è in `checked` (inclusa nel full admin, dal ruolo). */
  forcedOn?: boolean;
}

export function PermissionTable({
  scope,
  label,
  checked,
  onToggle,
  context,
}: {
  scope: AccessScope;
  /** Il nome della tabella per chi non la vede («Permissions of Developer»). */
  label: string;
  checked: ReadonlySet<string>;
  /** Senza, la tabella è in sola lettura. */
  onToggle?: (permission: string) => void;
  context?: (permission: string) => RowContext | null;
}) {
  const { t, i18n } = useTranslation();
  const words = usePermissionWords();
  const hint = usePermissionHint();
  const [find, setFind] = useState("");
  const [onlyOn, setOnlyOn] = useState(false);
  const baseId = useId();
  const q = find.trim().toLocaleLowerCase(i18n.language);
  const isOn = (p: string) => checked.has(p) || context?.(p)?.forcedOn === true;
  const matches = (p: string) =>
    (!onlyOn || isOn(p)) &&
    (!q || `${words(p)} ${hint(p)}`.toLocaleLowerCase(i18n.language).includes(q));
  const groups = groupsFor(scope)
    .map((g) => ({ ...g, shown: g.permissions.filter(matches) }))
    .filter((g) => g.shown.length > 0);

  return (
    <div role="group" aria-label={label} className="@container">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <input
          type="search"
          value={find}
          aria-label={t("admin.permissionTable.findLabel")}
          placeholder={t("admin.permissionTable.find")}
          onChange={(e) => setFind(e.target.value)}
          className={`${inputClass} h-7 max-w-64 py-0 text-sm`}
        />
        <label className="flex items-center gap-2 text-sm text-ink-muted">
          <Switch
            checked={onlyOn}
            label={t("admin.permissionTable.onlyOn")}
            onChange={setOnlyOn}
          />
          <span aria-hidden="true">{t("admin.permissionTable.onlyOn")}</span>
        </label>
      </div>
      {groups.length === 0 && (
        <p className="mt-4 text-sm text-ink-muted">{t("admin.permissionTable.noMatch")}</p>
      )}
      {groups.map((g) => {
        const on = g.permissions.filter(isOn).length;
        return (
          <fieldset key={g.key} className="mt-5 min-w-0">
            <legend className="flex w-full items-baseline gap-3 border-b border-rule pb-1.5">
              <span className="heading-group min-w-0 flex-1">{t(`whoCan.groups.${g.key}`)}</span>
              <span className="num shrink-0 text-xs text-ink-faint">
                {t("admin.permissionTable.count", { on, total: g.permissions.length })}
              </span>
            </legend>
            <ul>
              {g.shown.map((p) => (
                <PermissionRow
                  key={p}
                  id={`${baseId}-${p}`}
                  permission={p}
                  name={capitalized(words(p), i18n.language)}
                  hint={hint(p)}
                  on={isOn(p)}
                  context={context?.(p) ?? null}
                  onToggle={onToggle}
                />
              ))}
            </ul>
          </fieldset>
        );
      })}
    </div>
  );
}

function PermissionRow({
  id,
  permission,
  name,
  hint,
  on,
  context,
  onToggle,
}: {
  id: string;
  permission: string;
  name: string;
  hint: string;
  on: boolean;
  context: RowContext | null;
  onToggle?: (permission: string) => void;
}) {
  const locked = !onToggle || context?.locked === true;
  const describedBy = context?.long ? `${id}-why` : undefined;
  return (
    <li title={permission} className="border-b border-rule last:border-b-0">
      <label
        className={`relative flex min-h-9 items-start gap-3 rounded-md px-1 py-1.5 transition-colors duration-[var(--duration-fast)] ease-out has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-focus ${locked ? "" : "hover:bg-ink/4"}`}
      >
        <input
          type="checkbox"
          checked={on}
          disabled={locked}
          aria-describedby={describedBy}
          onChange={() => onToggle?.(permission)}
          className="sr-only"
        />
        <span className={`mt-[3px] ${locked ? "opacity-50" : ""}`}>
          <CheckBox checked={on} />
        </span>
        {/* Largo: nome · frase · contesto su una riga (la frase va a capo da sola);
            stretto: la frase sotto il nome, e il contesto sotto la frase. */}
        <span className="flex min-w-0 flex-1 flex-col gap-0.5 @min-[720px]:flex-row @min-[720px]:items-baseline @min-[720px]:gap-4">
          <span
            className={`text-md @min-[720px]:w-52 @min-[720px]:shrink-0 ${locked && !on ? "text-ink-muted" : "text-ink"}`}
          >
            {name}
          </span>
          <span className="min-w-0 flex-1 text-sm text-pretty text-ink-muted">{hint}</span>
          {context && (
            <span className="shrink-0 text-xs text-ink-muted @min-[720px]:max-w-[28ch] @min-[720px]:text-right">
              {context.short}
            </span>
          )}
        </span>
      </label>
      {describedBy && (
        <span id={describedBy} className="sr-only">
          {context!.long}
        </span>
      )}
    </li>
  );
}
