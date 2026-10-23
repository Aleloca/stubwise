import { useNavigate } from "@tanstack/react-router";
import { useId, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useSaveFilter, useSetFilterPinned, useUpdateFilter } from "../../data/queries";
import type { FilterCriteria, GroupBy, Project, SavedFilter, TaskView } from "../../data/types";
import { Dialog, DialogField, inputClass } from "../../tasks-ui/Dialog";
import { CheckBox, RadioDot } from "../../tasks-ui/Menu";
import { useToast } from "../../tasks-ui/Toast";
import { primaryButton, secondaryButton } from "../tasks/controls";

type Visibility = SavedFilter["visibility"];

/** Una scelta del dialogo (radio o casella) col suo segno disegnato e una riga di spiegazione. */
function Choice({
  type,
  name,
  checked,
  onChange,
  label,
  hint,
}: {
  type: "radio" | "checkbox";
  name?: string;
  checked: boolean;
  onChange: () => void;
  label: string;
  hint?: string;
}) {
  return (
    <label className="flex cursor-default items-start gap-2.5 rounded-md px-2 py-1.5 transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/4 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-focus">
      <input
        type={type}
        name={name}
        checked={checked}
        onChange={onChange}
        className="sr-only"
      />
      <span className="mt-0.5">
        {type === "radio" ? <RadioDot checked={checked} /> : <CheckBox checked={checked} />}
      </span>
      <span className="flex min-w-0 flex-col">
        <span className="text-md text-ink">{label}</span>
        {hint && <span className="text-sm text-ink-muted">{hint}</span>}
      </span>
    </label>
  );
}

/**
 * «Save as filter» e «Edit filter». Un filtro è privato o pubblico, nient'altro
 * (spec §4): il dialogo spiega che un pubblico lo apre chiunque e che
 * ognuno ci trova solo le task che vede già.
 *
 * - Nuovo: salva i criteri, la vista e il raggruppamento correnti (dentro un
 *   progetto i criteri hanno già quel progetto); di default lo fissa nella
 *   colonna della Home. Dopo il salvataggio un messaggio con «Open».
 * - Modifica (`filter`): nome e visibilità; se la pagina è stata cambiata
 *   (`changed`) può salvare anche i criteri, la vista e il raggruppamento
 *   correnti. `onSaved` riceve il filtro aggiornato.
 *
 * Un errore del «server» si dice nel dialogo, che resta aperto.
 */
export function SaveFilterDialog({
  criteria,
  view,
  groupBy,
  project,
  filter,
  changed = false,
  onClose,
  onSaved,
}: {
  criteria: FilterCriteria;
  view: TaskView;
  groupBy: GroupBy;
  /** Il progetto della pagina, se si salva da dentro un progetto. */
  project?: Pick<Project, "code" | "name">;
  filter?: SavedFilter;
  changed?: boolean;
  onClose: () => void;
  onSaved?: (filter: SavedFilter) => void;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const navigate = useNavigate();
  const save = useSaveFilter();
  const update = useUpdateFilter();
  const pin = useSetFilterPinned();
  const nameId = useId();
  const editing = !!filter;
  const [name, setName] = useState(filter?.name ?? "");
  const [visibility, setVisibility] = useState<Visibility>(filter?.visibility ?? "private");
  const [pinned, setPinned] = useState(true);
  const [withCurrent, setWithCurrent] = useState(true);
  const [tried, setTried] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = save.isPending || update.isPending;

  const scope = [
    groupBy === "none"
      ? t("filter.dialog.scopeNoGroup", { view: t(`tasks.views.${view}`) })
      : t("filter.dialog.scope", {
          view: t(`tasks.views.${view}`),
          group: t(`tasks.group.${groupBy}`),
        }),
    project ? t("filter.dialog.scopeProject", { code: project.code, name: project.name }) : null,
  ]
    .filter(Boolean)
    .join(" ");

  async function submit() {
    setTried(true);
    const trimmed = name.trim();
    if (!trimmed) return;
    setError(null);
    try {
      if (filter) {
        const saved = await update.mutateAsync({
          id: filter.id,
          patch: {
            name: trimmed,
            visibility,
            ...(changed && withCurrent ? { criteria, view, groupBy } : {}),
          },
        });
        onSaved?.(saved);
        onClose();
        return;
      }
      const saved = await save.mutateAsync({ name: trimmed, visibility, criteria, view, groupBy });
      // Fissarlo è un di più: se non riesce, il filtro resta salvato.
      if (pinned) pin.mutate({ filterId: saved.id, pinned: true });
      toast.show(t("filter.dialog.saved", { name: saved.name }), {
        action: {
          label: t("filter.dialog.open"),
          run: () => void navigate({ to: "/filters/$id", params: { id: saved.id } }),
        },
      });
      onSaved?.(saved);
      onClose();
    } catch {
      setError(t("filter.dialog.failed"));
    }
  }

  let extra: ReactNode = null;
  if (!editing) {
    extra = (
      <Choice
        type="checkbox"
        checked={pinned}
        onChange={() => setPinned((p) => !p)}
        label={t("filter.dialog.pin")}
      />
    );
  } else if (changed) {
    extra = (
      <Choice
        type="checkbox"
        checked={withCurrent}
        onChange={() => setWithCurrent((w) => !w)}
        label={t("filter.dialog.withCurrent")}
        hint={scope}
      />
    );
  }

  return (
    <Dialog
      title={editing ? t("filter.dialog.editTitle") : t("filter.dialog.saveTitle")}
      description={editing ? undefined : scope}
      onClose={onClose}
      footer={
        <>
          <button type="button" className={secondaryButton} onClick={onClose}>
            {t("filter.dialog.cancel")}
          </button>
          <button type="submit" form="save-filter" className={primaryButton} disabled={pending}>
            {editing ? t("filter.dialog.update") : t("filter.dialog.submit")}
          </button>
        </>
      }
    >
      <form
        id="save-filter"
        noValidate
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <DialogField label={t("filter.dialog.name")} htmlFor={nameId}>
          <input
            id={nameId}
            data-autofocus
            value={name}
            maxLength={80}
            onChange={(e) => setName(e.target.value)}
            aria-invalid={tried && !name.trim() ? true : undefined}
            className={`${inputClass} ${tried && !name.trim() ? "border-critical" : ""}`}
          />
          {tried && !name.trim() && (
            <span className="text-xs text-critical">{t("filter.dialog.nameMissing")}</span>
          )}
        </DialogField>

        <fieldset className="flex flex-col gap-1">
          <legend className="mb-1.5 text-sm font-medium text-ink">
            {t("filter.dialog.visibility")}
          </legend>
          <div className="-mx-2 flex flex-col">
            <Choice
              type="radio"
              name="visibility"
              checked={visibility === "private"}
              onChange={() => setVisibility("private")}
              label={t("filter.visibility.private")}
              hint={t("filter.dialog.privateHint")}
            />
            <Choice
              type="radio"
              name="visibility"
              checked={visibility === "public"}
              onChange={() => setVisibility("public")}
              label={t("filter.visibility.public")}
              hint={t("filter.dialog.publicHint")}
            />
          </div>
        </fieldset>

        {extra && <div className="-mx-2">{extra}</div>}

        {error && (
          <p role="alert" className="rounded-md bg-critical/10 px-3 py-2 text-sm text-ink">
            {error}
          </p>
        )}
      </form>
    </Dialog>
  );
}
