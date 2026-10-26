import { useState } from "react";
import { useTranslation } from "react-i18next";
import { now } from "../../data/dates";
import {
  useAdvanceAutomationTime,
  useMailThreadOfMessage,
  useSimulateMailReply,
} from "../../data/queries";
import type { AutomationRunDetail } from "../../data/types";
import { inputClass } from "../../tasks-ui/Dialog";
import { useToast } from "../../tasks-ui/Toast";
import { primaryButton, quietButton, secondaryButton } from "../tasks/controls";
import { shortDate } from "./format";
import { PrototypeBox } from "./shared";
import { awaitedEmail } from "./RunNow";

// «Pass time» (solo prototipo, shape [A 15]/[A 16]): far passare il tempo
// su un'esecuzione in attesa; un'approvazione non scade e il riquadro lo dice.

export const DAY = 86_400_000;

/** «Pass time» (solo prototipo, [A 15]/[A 16]): un'approvazione non scade, e lo si vede. */
export function PassTime({ run }: { run: AutomationRunDetail }) {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const advance = useAdvanceAutomationTime();
  const reply = useSimulateMailReply();
  const email = awaitedEmail(run);
  const thread = useMailThreadOfMessage(email?.effects[0]?.code || null).data;
  const [writing, setWriting] = useState(false);
  const [text, setText] = useState("");
  const blocked = run.status === "waiting_approval";
  const toDeadline = run.waitingUntil
    ? Math.min(30, Math.max(1, Math.ceil((Date.parse(run.waitingUntil) - Date.parse(now())) / DAY)))
    : null;
  const pass = (days: number, hours = 0) =>
    advance.mutate(
      { runId: run.id, days, hours },
      { onError: () => toast.error(t("automations.toast.timeError")) },
    );
  return (
    <PrototypeBox label={t("automations.prototype.passTime")}>
      <p className="text-sm text-ink">
        {blocked
          ? t("automations.prototype.approvalsDontExpire")
          : t("automations.prototype.daysPass")}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className={`${secondaryButton} disabled:opacity-40`}
          disabled={blocked || advance.isPending}
          onClick={() => pass(0, 1)}
        >
          {t("automations.prototype.plusHour")}
        </button>
        <button
          type="button"
          className={`${secondaryButton} disabled:opacity-40`}
          disabled={blocked || advance.isPending}
          onClick={() => pass(1)}
        >
          {t("automations.prototype.plusDay")}
        </button>
        {(toDeadline !== null || blocked) && (
          <button
            type="button"
            className={`${secondaryButton} disabled:opacity-40`}
            disabled={blocked || toDeadline === null || advance.isPending}
            onClick={() => toDeadline !== null && pass(toDeadline)}
          >
            {run.waitingUntil
              ? t("automations.prototype.toDeadline", {
                  date: shortDate(run.waitingUntil, i18n.language),
                })
              : t("automations.prototype.toDeadlineNone")}
          </button>
        )}
        {!blocked && thread && !writing && (
          <button type="button" className={quietButton} onClick={() => setWriting(true)}>
            {t("automations.prototype.simulateReply")}
          </button>
        )}
      </div>
      {writing && thread && (
        <div className="flex flex-col gap-2">
          <textarea
            aria-label={t("automations.prototype.replyLabel")}
            className={`${inputClass} min-h-24`}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          <div className="flex items-center gap-2">
            <button type="button" className={secondaryButton} onClick={() => setWriting(false)}>
              {t("automations.actions.cancel")}
            </button>
            <button
              type="button"
              className={`${primaryButton} disabled:opacity-40`}
              disabled={!text.trim() || reply.isPending}
              onClick={() =>
                reply.mutate(
                  { threadId: thread, text },
                  {
                    onSuccess: () => {
                      setWriting(false);
                      setText("");
                      toast.show(t("automations.toast.replySent"));
                    },
                    onError: () => toast.error(t("automations.toast.replyError")),
                  },
                )
              }
            >
              {t("automations.prototype.sendReply")}
            </button>
          </div>
        </div>
      )}
    </PrototypeBox>
  );
}
