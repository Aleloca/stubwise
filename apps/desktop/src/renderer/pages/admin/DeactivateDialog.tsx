import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useDeactivatePerson, usePeople, type PersonDetail } from "../../data/queries";
import { useReauth } from "../../layout/useReauth";
import { Dialog, selectButtonClass } from "../../tasks-ui/Dialog";
import { MenuGroup, RadioItem } from "../../tasks-ui/Menu";
import { useToast } from "../../tasks-ui/Toast";
import { ErrorLine } from "../entry/parts";
import { refusalOf } from "../preferences/parts";
import { OpenCircleGlyph } from "../preferences/glyphs";
import { Chevron, MenuButton, dangerSolidButton, secondaryButton } from "../tasks/controls";
import { reasonWords, useRefusalWords, type UiRefusal } from "./parts";

// «Deactivate…» (shape admin-people.md, «Disattiva e riattiva»): le
// conseguenze una per riga, poi le task aperte, ognuna con «Reassign to»
// (di base «Leave with Simone») e sopra «Reassign all to…» [PE 6]. Gli
// assegnatari possibili li dice il livello dati (`openTasks[].reassignTo`):
// le persone attive del progetto della task, e Claude se ne è membro.
// «Deactivate» passa dalla riconferma. Un blocco (ultimo full admin) spegne
// il bottone col motivo sopra.

/** `null` = resta a chi si disattiva. */
type Choice = Record<string, string | null>;

export function DeactivateDialog({
  person,
  onClose,
  onDone,
}: {
  person: PersonDetail;
  onClose: () => void;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const people = usePeople().data ?? [];
  const deactivate = useDeactivatePerson();
  const reauth = useReauth();
  const toast = useToast();
  const refusalWords = useRefusalWords();
  const [choice, setChoice] = useState<Choice>({});
  const [error, setError] = useState<string | null>(null);
  const name = person.name;
  const nameOf = (id: string | null) =>
    id === null ? t("admin.deactivate.leaveWith", { name }) : (people.find((p) => p.id === id)?.name ?? id);
  // «Reassign all to…»: chi può prendere almeno una task, nell'ordine in cui compare.
  const everyone = [...new Set(person.openTasks.flatMap((task) => task.reassignTo))];
  const blocked =
    person.actions.deactivate !== null && person.actions.deactivate !== "status"
      ? reasonWords(t, person.actions.deactivate, {
          name,
          self: t("admin.refusal.selfDeactivate"),
        })
      : null;

  async function submit() {
    setError(null);
    const result = await reauth(() => deactivate.mutateAsync([person.personId, choice]), {
      action: t("admin.deactivate.reauthAction", { name }),
    }).catch(() => null);
    if (result === null) return setError(t("admin.refusal.failed"));
    const refusal = refusalOf(result) as UiRefusal | null;
    if (refusal)
      return setError(
        refusalWords(refusal, { name, self: t("admin.refusal.selfDeactivate") }),
      );
    // Quante ne ha spostate lo dice il livello dati; a chi, le scelte fatte qui.
    const count = (result as { reassigned: number }).reassigned;
    const targets = [...new Set(Object.values(choice).filter((to) => to !== null))];
    toast.show(
      count === 0
        ? t("admin.deactivate.done", { name })
        : targets.length === 1
          ? t("admin.deactivate.doneOne", { name, count, to: nameOf(targets[0]!) })
          : t("admin.deactivate.doneMany", { name, count }),
    );
    onDone();
  }

  return (
    <Dialog
      title={t("admin.deactivate.title", { name })}
      onClose={onClose}
      width={560}
      footer={
        <>
          {blocked && <p className="mr-auto text-sm text-ink-muted">{blocked}</p>}
          <button type="button" className={secondaryButton} onClick={onClose}>
            {t("admin.invite.cancel")}
          </button>
          <button
            type="button"
            className={dangerSolidButton}
            disabled={blocked !== null || deactivate.isPending}
            onClick={() => void submit()}
          >
            {t("admin.deactivate.confirm")}
          </button>
        </>
      }
    >
      <ul className="flex flex-col gap-1.5 text-md text-ink">
        {(
          ["cantSignIn", "disappears", "tasksStay", "invitesRevoked", "reactivateLater"] as const
        ).map((k) => (
          <li key={k} className="flex items-start gap-2">
            <span aria-hidden="true" className="mt-[7px] size-1 shrink-0 rounded-full bg-ink-muted" />
            {t(`admin.deactivate.${k}`, { name })}
          </li>
        ))}
      </ul>
      <section aria-labelledby="deactivate-tasks" className="border-t border-rule pt-4">
        <div className="flex min-h-8 items-center gap-3">
          <h3 id="deactivate-tasks" className="min-w-0 flex-1 text-md font-semibold text-ink">
            {t("admin.deactivate.openTasks", { count: person.openTasks.length })}
          </h3>
          {everyone.length > 0 && (
            <MenuButton
              menuLabel={t("admin.deactivate.reassignAll")}
              className={`${secondaryButton} h-7 px-2.5`}
              label={
                <>
                  {t("admin.deactivate.reassignAll")}
                  <Chevron />
                </>
              }
            >
              {(close) => (
                <MenuGroup label={t("admin.deactivate.reassignAll")}>
                  {[null, ...everyone].map((id) => (
                    <RadioItem
                      key={id ?? "leave"}
                      checked={false}
                      onSelect={() => {
                        close();
                        // Ogni riga prende la persona solo se può prendere quella task.
                        setChoice(
                          Object.fromEntries(
                            person.openTasks.map((task) => [
                              task.taskId,
                              id === null || task.reassignTo.includes(id)
                                ? id
                                : (choice[task.taskId] ?? null),
                            ]),
                          ),
                        );
                      }}
                    >
                      {nameOf(id)}
                    </RadioItem>
                  ))}
                </MenuGroup>
              )}
            </MenuButton>
          )}
        </div>
        {person.openTasks.length === 0 ? (
          <p className="mt-1 flex items-center gap-1.5 text-sm text-ink-muted">
            <OpenCircleGlyph size={12} />
            {t("admin.deactivate.noTasks", { name })}
          </p>
        ) : (
          <ul className="mt-1">
            {person.openTasks.map((task) => {
              const current = choice[task.taskId] ?? null;
              return (
                <li
                  key={task.taskId}
                  className="flex min-h-11 items-center gap-3 border-b border-rule last:border-b-0"
                >
                  {/* Testo, non link: il dialogo non si lascia a metà. */}
                  <span className="num w-16 shrink-0 text-xs font-semibold tracking-[0.02em] text-ink">
                    {task.code}
                  </span>
                  <span title={task.title} className="min-w-0 flex-1 truncate text-md text-ink">
                    {task.title}
                  </span>
                  <span className="w-48 shrink-0">
                    <MenuButton
                      menuLabel={t("admin.deactivate.reassignLabel", { code: task.code })}
                      ariaLabel={`${t("admin.deactivate.reassignLabel", { code: task.code })}: ${nameOf(current)}`}
                      wrapperClassName="flex min-w-0"
                      align="right"
                      className={selectButtonClass}
                      label={
                        <>
                          <span
                            className={`min-w-0 flex-1 truncate ${current === null ? "text-ink-muted" : ""}`}
                          >
                            {nameOf(current)}
                          </span>
                          <Chevron />
                        </>
                      }
                    >
                      {(close) => (
                        <MenuGroup label={t("admin.deactivate.reassignTo")}>
                          {[null, ...task.reassignTo].map((id) => (
                            <RadioItem
                              key={id ?? "leave"}
                              checked={current === id}
                              onSelect={() => {
                                close();
                                setChoice((c) => ({ ...c, [task.taskId]: id }));
                              }}
                            >
                              {nameOf(id)}
                            </RadioItem>
                          ))}
                        </MenuGroup>
                      )}
                    </MenuButton>
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </section>
      {error && <ErrorLine>{error}</ErrorLine>}
    </Dialog>
  );
}
