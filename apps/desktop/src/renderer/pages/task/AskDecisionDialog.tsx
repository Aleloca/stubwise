import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAskDecision } from "../../data/queries";
import type { Task } from "../../data/types";
import { useViewer } from "../../data/viewer";
import { Dialog, DialogField, inputClass, selectButtonClass } from "../../tasks-ui/Dialog";
import { MenuGroup, RadioItem } from "../../tasks-ui/Menu";
import { Avatar } from "../../tasks-ui/PersonChip";
import { useToast } from "../../tasks-ui/Toast";
import { Chevron, MenuButton, primaryButton, secondaryButton } from "../tasks/controls";
import { useProjectMembers } from "../tasks/pickers";
import { CloseIcon, PlusIcon, ghostButton } from "./parts";

const MAX_OPTIONS = 6;

/**
 * «Ask for a decision»: a chi (fra i membri del progetto; non a sé stessi e
 * non a Claude, che le domande le fa), la domanda e, se si vuole, le opzioni.
 * Chi risponde può sempre scrivere la sua («Other…»). Gli errori del
 * «server» si dicono nel dialogo: una persona fuori dal progetto, una
 * richiesta già aperta alla stessa persona su questa task.
 */
export function AskDecisionDialog({ task, onClose }: { task: Task; onClose: () => void }) {
  const { t } = useTranslation();
  const { viewer } = useViewer();
  const toast = useToast();
  const ask = useAskDecision();
  const members = (useProjectMembers(task.projectId) ?? []).filter(
    (p) => !p.isClaude && p.id !== viewer.personId,
  );
  const [askedOfId, setAskedOfId] = useState<string | null>(null);
  const [question, setQuestion] = useState("");
  const [options, setOptions] = useState<string[]>([""]);
  const [error, setError] = useState<string | null>(null);
  const [tried, setTried] = useState(false);
  const questionId = useId();
  const person = members.find((p) => p.id === askedOfId);

  const submit = () => {
    setTried(true);
    if (!askedOfId || !question.trim()) return;
    setError(null);
    ask.mutate(
      {
        taskId: task.id,
        askedOfId,
        question: question.trim(),
        options: options.map((o) => o.trim()).filter(Boolean),
      },
      {
        onSuccess: () => {
          toast.show(t("taskDetail.ask.sent", { name: person?.name ?? "" }));
          onClose();
        },
        onError: (e) => {
          const message = e instanceof Error ? e.message : "";
          if (message === "duplicate") {
            setError(t("taskDetail.ask.duplicate", { name: person?.name ?? "" }));
          } else if (message.startsWith("invalid: askedOfId")) {
            setError(t("taskDetail.ask.notMember"));
          } else {
            setError(t("taskDetail.ask.failed"));
          }
        },
      },
    );
  };

  return (
    <Dialog
      title={t("taskDetail.ask.title")}
      description={t("taskDetail.ask.description", { code: task.code })}
      onClose={onClose}
      footer={
        <>
          <button type="button" className={secondaryButton} onClick={onClose}>
            {t("taskDetail.cancel")}
          </button>
          <button
            type="submit"
            form="ask-decision"
            className={primaryButton}
            disabled={ask.isPending}
          >
            {t("taskDetail.ask.submit")}
          </button>
        </>
      }
    >
      <form
        id="ask-decision"
        noValidate
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <DialogField label={t("taskDetail.ask.who")}>
          <MenuButton
            menuLabel={t("taskDetail.ask.who")}
            ariaLabel={t("taskDetail.ask.whoValue", {
              name: person?.name ?? t("taskDetail.ask.choose"),
            })}
            wrapperClassName="flex w-full min-w-0"
            className={`${selectButtonClass} ${tried && !askedOfId ? "border-critical" : ""}`}
            label={
              <>
                {person ? (
                  <>
                    <Avatar person={person} />
                    <span className="min-w-0 flex-1 truncate">{person.name}</span>
                  </>
                ) : (
                  <span className="min-w-0 flex-1 truncate text-ink-faint">
                    {t("taskDetail.ask.choose")}
                  </span>
                )}
                <Chevron />
              </>
            }
          >
            {(close) => (
              <MenuGroup>
                {members.map((p) => (
                  <RadioItem
                    key={p.id}
                    checked={p.id === askedOfId}
                    onSelect={() => {
                      close();
                      setAskedOfId(p.id);
                      setError(null);
                    }}
                  >
                    <Avatar person={p} />
                    <span className="min-w-0 truncate">{p.name}</span>
                  </RadioItem>
                ))}
              </MenuGroup>
            )}
          </MenuButton>
          {tried && !askedOfId && (
            <span className="text-xs text-critical">{t("taskDetail.ask.whoMissing")}</span>
          )}
        </DialogField>

        <DialogField label={t("taskDetail.ask.question")} htmlFor={questionId}>
          <textarea
            id={questionId}
            rows={3}
            value={question}
            aria-invalid={tried && !question.trim()}
            placeholder={t("taskDetail.ask.questionPlaceholder")}
            onChange={(e) => setQuestion(e.target.value)}
            className={`${inputClass} resize-y ${tried && !question.trim() ? "border-critical" : ""}`}
          />
          {tried && !question.trim() && (
            <span className="text-xs text-critical">{t("taskDetail.ask.questionMissing")}</span>
          )}
        </DialogField>

        <fieldset className="flex flex-col gap-1.5">
          <legend className="pb-1.5 text-sm font-medium text-ink">
            {t("taskDetail.ask.options")}
            <span className="ml-1.5 font-normal text-ink-muted">{t("taskDetail.ask.optional")}</span>
          </legend>
          {options.map((o, i) => (
            <div key={i} className="flex items-center gap-1.5">
              <input
                aria-label={t("taskDetail.ask.option", { n: i + 1 })}
                placeholder={t("taskDetail.ask.optionPlaceholder")}
                value={o}
                onChange={(e) =>
                  setOptions(options.map((v, j) => (j === i ? e.target.value : v)))
                }
                className={inputClass}
              />
              {options.length > 1 && (
                <button
                  type="button"
                  aria-label={t("taskDetail.ask.removeOption", { n: i + 1 })}
                  title={t("taskDetail.ask.removeOption", { n: i + 1 })}
                  onClick={() => setOptions(options.filter((_, j) => j !== i))}
                  className={`${ghostButton} w-8 justify-center px-0`}
                >
                  <CloseIcon size={14} />
                </button>
              )}
            </div>
          ))}
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs text-ink-muted">{t("taskDetail.ask.otherHint")}</span>
            {options.length < MAX_OPTIONS && (
              <button
                type="button"
                className={ghostButton}
                onClick={() => setOptions([...options, ""])}
              >
                <PlusIcon />
                {t("taskDetail.ask.addOption")}
              </button>
            )}
          </div>
        </fieldset>

        {error && (
          <p role="alert" className="rounded-md bg-critical/10 px-3 py-2 text-sm text-ink">
            {error}
          </p>
        )}
      </form>
    </Dialog>
  );
}
