import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  useSimulateServerAlert,
  useSimulateServerRecovery,
  useSimulateSshUnreachable,
} from "../../data/queries";
import type { ServerDetail } from "../../data/servers";
import type { EpisodeReason } from "../../data/types";
import { useToast } from "../../tasks-ui/Toast";
import { PrototypeBox } from "../automations/shared";
import { smallSecondary } from "../task/parts";
import { shortInput } from "./Part";

// SOLO PROTOTIPO (shape servers.md §3, «Prototype only»): i segnali che nel
// prodotto arrivano dall'agente o dal server, scelti a mano. Nessuno tocca
// un server: fanno arrivare l'allarme, il rientro, o un SSH che non
// risponde. Visibile a chiunque veda il server.

const REASONS: readonly EpisodeReason["kind"][] = [
  "cpu",
  "memory",
  "disk",
  "check",
  "agent_silent",
];

export function SimulatePanel({ server }: { server: ServerDetail }) {
  const { t } = useTranslation();
  const toast = useToast();
  const alert = useSimulateServerAlert();
  const recovery = useSimulateServerRecovery();
  const unreachable = useSimulateSshUnreachable();
  const ids = { reason: useId(), severity: useId(), overrun: useId() };
  const [reason, setReason] = useState<EpisodeReason["kind"]>("memory");
  const [severity, setSeverity] = useState<"trouble" | "down">("trouble");
  const [overrun, setOverrun] = useState(false);
  const fail = () => toast.error(t("servers.simulate.error"));
  const open = server.episodes.some((e) => e.recoveredAt === null);

  return (
    <PrototypeBox label={t("servers.simulate.label")}>
      <p className="text-sm text-ink-muted">{t("servers.simulate.intro")}</p>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <label htmlFor={ids.reason} className="flex items-center gap-2 text-sm text-ink">
          {t("servers.simulate.reason")}
          <select
            id={ids.reason}
            value={reason}
            onChange={(e) => setReason(e.target.value as EpisodeReason["kind"])}
            className={`${shortInput} h-7 py-0 text-sm`}
          >
            {REASONS.map((r) => (
              <option key={r} value={r} disabled={r === "check" && server.checks.length === 0}>
                {t(`servers.reasonShort.${r}`)}
              </option>
            ))}
          </select>
        </label>
        <label htmlFor={ids.severity} className="flex items-center gap-2 text-sm text-ink">
          {t("servers.simulate.severity")}
          <select
            id={ids.severity}
            value={severity}
            onChange={(e) => setSeverity(e.target.value as "trouble" | "down")}
            className={`${shortInput} h-7 py-0 text-sm`}
          >
            <option value="trouble">{t("servers.health.trouble")}</option>
            <option value="down">{t("servers.health.down")}</option>
          </select>
        </label>
        <label htmlFor={ids.overrun} className="flex items-center gap-2 text-sm text-ink">
          <input
            id={ids.overrun}
            type="checkbox"
            checked={overrun}
            onChange={(e) => setOverrun(e.target.checked)}
            className="accent-ink"
          />
          {t("servers.simulate.overrun")}
        </label>
        <button
          type="button"
          className={smallSecondary}
          disabled={alert.isPending}
          onClick={() =>
            alert.mutate({ code: server.code, reason, severity, overrun }, { onError: fail })
          }
        >
          {t("servers.simulate.alert")}
        </button>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className={`${smallSecondary} disabled:opacity-40`}
          disabled={!open || recovery.isPending}
          onClick={() => recovery.mutate(server.code, { onError: fail })}
        >
          {t("servers.simulate.recovery")}
        </button>
        <button
          type="button"
          className={smallSecondary}
          onClick={() =>
            unreachable.mutate({ code: server.code, on: server.sshReachable }, { onError: fail })
          }
        >
          {t(server.sshReachable ? "servers.simulate.unreachable" : "servers.simulate.reachable")}
        </button>
      </div>
    </PrototypeBox>
  );
}
