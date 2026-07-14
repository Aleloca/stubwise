import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { AlertThresholds, ServerDetail } from "../../lib/api";
import { updateServer } from "../../lib/api";
import { serverKeys } from "../../lib/queries";

/** Numero (o null) → stringa dell'input; null = soglia disattivata = campo vuoto. */
function toInput(value: number | null): string {
  return value === null ? "" : String(value);
}

/**
 * Stringa dell'input → soglia percentuale. Vuoto = null (disattivata). Altrimenti
 * clampata in 1..99: il valutatore usa un confronto STRICT `>`, quindi 100 non
 * scatterebbe mai — l'input è limitato a 99.
 */
function parsePct(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  const n = Math.round(Number(trimmed));
  if (!Number.isFinite(n)) return null;
  return Math.min(99, Math.max(1, n));
}

/**
 * Stringa dell'input → minuti di superamento continuo. Vuoto o non numerico =
 * default 5 (Number("") sarebbe 0 e verrebbe clampato a 1 in silenzio);
 * altrimenti clampato in 1..60 come lo schema server.
 */
function parseSustained(raw: string): number {
  const trimmed = raw.trim();
  if (trimmed === "") return 5;
  const n = Math.round(Number(trimmed));
  if (!Number.isFinite(n)) return 5;
  return Math.min(60, Math.max(1, n));
}

/**
 * Form delle soglie di alert. ATTENZIONE: il PATCH è full-replacement, quindi si
 * manda SEMPRE l'oggetto completo {cpuPct, memPct, diskPct, sustainedMinutes}
 * (null = disattivata) — mai un sottoinsieme, altrimenti i campi omessi tornano
 * ai default del server. Al successo invalida il sotto-albero del server.
 */
export function ThresholdsPanel({ server }: { server: ServerDetail }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const th = server.alertThresholds;

  // Stato locale inizializzato dalle soglie del server e risincronizzato dopo
  // un salvataggio/refetch.
  const [cpu, setCpu] = useState(toInput(th.cpuPct));
  const [mem, setMem] = useState(toInput(th.memPct));
  const [disk, setDisk] = useState(toInput(th.diskPct));
  const [sustained, setSustained] = useState(String(th.sustainedMinutes));
  useEffect(() => {
    setCpu(toInput(th.cpuPct));
    setMem(toInput(th.memPct));
    setDisk(toInput(th.diskPct));
    setSustained(String(th.sustainedMinutes));
  }, [th.cpuPct, th.memPct, th.diskPct, th.sustainedMinutes]);

  const mutation = useMutation({
    mutationFn: (thresholds: AlertThresholds) =>
      updateServer(server.id, { alertThresholds: thresholds }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: serverKeys.detail(server.id) });
      void queryClient.invalidateQueries({ queryKey: serverKeys.lists() });
    },
  });

  const onSubmit = (event: React.FormEvent): void => {
    event.preventDefault();
    // Oggetto COMPLETO, sempre: full-replacement.
    mutation.mutate({
      cpuPct: parsePct(cpu),
      memPct: parsePct(mem),
      diskPct: parsePct(disk),
      sustainedMinutes: parseSustained(sustained),
    });
  };

  const dirty = (): void => {
    if (mutation.isSuccess) mutation.reset();
  };

  return (
    <section className="rounded-sm border border-line bg-ink-900">
      <header className="border-b border-line px-4 py-3">
        <h2 className="font-mono text-[11px] font-medium tracking-[0.16em] text-fg-muted uppercase">
          {t("monitor:detail.thresholds.title")}
        </h2>
        <p className="mt-1 font-mono text-[11px] text-fg-faint">
          {t("monitor:detail.thresholds.subtitle")}
        </p>
      </header>
      <form onSubmit={onSubmit} className="flex flex-wrap items-end gap-4 px-4 py-4">
        <PctField
          label={t("monitor:detail.thresholds.cpu")}
          value={cpu}
          onChange={(v) => {
            setCpu(v);
            dirty();
          }}
          disabled={mutation.isPending}
        />
        <PctField
          label={t("monitor:detail.thresholds.mem")}
          value={mem}
          onChange={(v) => {
            setMem(v);
            dirty();
          }}
          disabled={mutation.isPending}
        />
        <PctField
          label={t("monitor:detail.thresholds.disk")}
          value={disk}
          onChange={(v) => {
            setDisk(v);
            dirty();
          }}
          disabled={mutation.isPending}
        />
        <label className="flex flex-col gap-1 font-mono text-[11px] text-fg-muted">
          <span className="tracking-[0.08em] uppercase">
            {t("monitor:detail.thresholds.sustained")}
          </span>
          <input
            type="number"
            min={1}
            max={60}
            value={sustained}
            disabled={mutation.isPending}
            onChange={(e) => {
              setSustained(e.target.value);
              dirty();
            }}
            className="w-24 rounded-sm border border-line-strong bg-ink-950/70 px-2 py-1 text-[12px] text-fg tabular-nums transition-colors hover:border-ink-700 focus-visible:border-signal-dim"
          />
        </label>

        <div className="flex flex-col gap-1">
          <button
            type="submit"
            disabled={mutation.isPending}
            className="rounded-sm border border-signal-dim bg-signal/10 px-3 py-1.5 font-mono text-[12px] text-signal transition-colors hover:bg-signal/20 disabled:opacity-50"
          >
            {mutation.isPending
              ? t("monitor:detail.thresholds.saving")
              : t("monitor:detail.thresholds.save")}
          </button>
        </div>

        <p className="w-full font-mono text-[10px] text-fg-faint">
          {t("monitor:detail.thresholds.disabledHint")}
          {mutation.isSuccess && (
            <span className="ml-2 text-ok">{t("monitor:detail.thresholds.saved")}</span>
          )}
          {mutation.isError && (
            <span className="ml-2 text-danger">{t("monitor:detail.thresholds.error")}</span>
          )}
        </p>
      </form>
    </section>
  );
}

function PctField({
  label,
  value,
  onChange,
  disabled,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
}) {
  return (
    <label className="flex flex-col gap-1 font-mono text-[11px] text-fg-muted">
      <span className="tracking-[0.08em] uppercase">{label}</span>
      <input
        type="number"
        min={1}
        max={99}
        value={value}
        disabled={disabled}
        aria-label={label}
        onChange={(e) => onChange(e.target.value)}
        className="w-24 rounded-sm border border-line-strong bg-ink-950/70 px-2 py-1 text-[12px] text-fg tabular-nums transition-colors hover:border-ink-700 focus-visible:border-signal-dim"
      />
    </label>
  );
}
