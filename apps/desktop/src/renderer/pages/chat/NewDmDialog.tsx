import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { DM_MAX_PEOPLE } from "../../data/chat";
import {
  useChatChannels,
  useOpenDm,
  usePeople,
  useSendChatMessage,
  useSessionPersonId,
} from "../../data/queries";
import type { ChannelView } from "../../data/types";
import { Dialog, inputClass } from "../../tasks-ui/Dialog";
import { primaryButton, secondaryButton } from "../tasks/controls";
import { CloseIcon } from "../task/parts";
import { PeoplePicker } from "./PeoplePicker";

// «New message» (shape chat-manage.md §5): «To:» con i gettoni delle
// persone, ricerca per nome e reparto, al più 8 persone compreso chi scrive
// («3 of 8 people»). Se esiste già un messaggio diretto con le stesse
// persone, il bottone dice «Open conversation» e porta lì. Sotto, il primo
// messaggio: l'invio crea (o riapre) e apre.

export function NewDmDialog({
  onOpened,
  onClose,
}: {
  onOpened: (channel: ChannelView) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const me = useSessionPersonId();
  const people = usePeople().data;
  const dms = useChatChannels().data?.filter((r) => r.kind === "dm");
  const openDm = useOpenDm();
  const send = useSendChatMessage();
  const [to, setTo] = useState<string[]>([]);
  const [text, setText] = useState("");
  const [failed, setFailed] = useState(false);
  const messageId = useId();

  const count = to.length + 1;
  const full = count >= DM_MAX_PEOPLE;
  const group = [me, ...to];
  const existing = dms?.find(
    (c) => c.memberIds.length === group.length && group.every((id) => c.memberIds.includes(id)),
  );
  const candidates = (people ?? []).filter((p) => !p.isClaude && p.id !== me);
  const busy = openDm.isPending || send.isPending;

  const submit = () => {
    if (to.length === 0 || busy) return;
    setFailed(false);
    openDm.mutate(to, {
      onSuccess: (channel) => {
        if (!text.trim()) return onOpened(channel);
        send.mutate(
          { channelId: channel.id, input: { text: text.trim() } },
          { onSuccess: () => onOpened(channel), onError: () => setFailed(true) },
        );
      },
      onError: () => setFailed(true),
    });
  };

  return (
    <Dialog
      title={t("chat.newDm.title")}
      onClose={onClose}
      width={480}
      confirmDiscard={
        text.trim()
          ? {
              message: t("chat.newDm.discard"),
              keep: t("chat.newChannel.keep"),
              discard: t("chat.newChannel.discardAction"),
            }
          : undefined
      }
      footer={
        <>
          <button type="button" className={secondaryButton} onClick={onClose}>
            {t("chat.newChannel.cancel")}
          </button>
          <button
            type="submit"
            form="new-dm"
            className={`${primaryButton} disabled:opacity-40`}
            disabled={to.length === 0 || busy}
          >
            {existing ? t("chat.newDm.open") : t("chat.newDm.start")}
          </button>
        </>
      }
    >
      <form
        id="new-dm"
        noValidate
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <div className="flex min-w-0 flex-col gap-1.5">
          <div className="flex items-baseline justify-between gap-3">
            <span className="text-sm font-medium text-ink">{t("chat.newDm.to")}</span>
            <span className="num text-xs text-ink-muted" aria-live="polite">
              {t("chat.newDm.count", { count, max: DM_MAX_PEOPLE })}
            </span>
          </div>
          {to.length > 0 && (
            <ul aria-label={t("chat.newDm.chosen")} className="flex flex-wrap gap-1.5">
              {to.map((id) => {
                const person = people?.find((p) => p.id === id);
                return (
                  <li
                    key={id}
                    className="flex h-7 items-center gap-1 rounded-md border border-rule-strong pr-1 pl-2 text-sm text-ink"
                  >
                    {person?.name}
                    <button
                      type="button"
                      aria-label={t("chat.newDm.remove", { name: person?.name ?? "" })}
                      onClick={() => setTo((list) => list.filter((x) => x !== id))}
                      className="grid size-5 place-items-center rounded text-ink-muted hover:bg-ink/6 hover:text-ink"
                    >
                      <CloseIcon size={12} />
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          <PeoplePicker
            label={t("chat.newDm.to")}
            candidates={candidates}
            selected={to}
            limitReached={full}
            autoFocus
            onToggle={(id) =>
              setTo((list) => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id]))
            }
          />
          {full && <span className="text-xs text-ink-muted">{t("chat.newDm.max", { max: DM_MAX_PEOPLE })}</span>}
          {existing && (
            <span className="text-xs text-ink-muted">{t("chat.newDm.exists")}</span>
          )}
        </div>
        <div className="flex min-w-0 flex-col gap-1.5">
          <label htmlFor={messageId} className="text-sm font-medium text-ink">
            {t("chat.newDm.message")}
          </label>
          <textarea
            id={messageId}
            rows={3}
            value={text}
            placeholder={t("chat.newDm.messagePlaceholder")}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                submit();
              }
            }}
            className={`${inputClass} resize-none`}
          />
        </div>
        {failed && (
          <p role="alert" className="text-sm text-critical">
            {t("chat.newDm.failed")}
          </p>
        )}
      </form>
    </Dialog>
  );
}
