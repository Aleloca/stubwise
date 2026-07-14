import { useTranslation } from "react-i18next";
import type { ServerDisk } from "../../lib/api";

const GB = 1024 ** 3;

/**
 * Barre compatte per punto di mount (used/total dall'ultimo campione). La
 * percentuale colora d'allarme (rosso) quando supera la soglia disco del server;
 * `threshold` null (soglia disattivata) → mai in allarme.
 */
export function DisksPanel({
  disks,
  threshold,
}: {
  disks: ServerDisk[];
  threshold: number | null;
}) {
  const { t } = useTranslation();

  return (
    <section className="rounded-sm border border-line bg-ink-900">
      <header className="border-b border-line px-4 py-3">
        <h2 className="font-mono text-[11px] font-medium tracking-[0.16em] text-fg-muted uppercase">
          {t("monitor:detail.disks.title")}
        </h2>
      </header>
      {disks.length === 0 ? (
        <p className="px-4 py-6 text-center font-mono text-[11px] tracking-[0.12em] text-fg-faint uppercase">
          {t("monitor:detail.disks.empty")}
        </p>
      ) : (
        <ul className="divide-y divide-line">
          {disks.map((disk) => {
            const pct = disk.totalBytes > 0 ? (disk.usedBytes / disk.totalBytes) * 100 : 0;
            const alarm = threshold !== null && pct > threshold;
            return (
              <li key={disk.mount} className="px-4 py-3">
                <div className="flex items-baseline justify-between gap-2 font-mono text-[12px]">
                  <span className="truncate text-fg">{disk.mount}</span>
                  <span className="shrink-0 text-fg-muted tabular-nums">
                    {t("monitor:detail.disks.usage", {
                      used: (disk.usedBytes / GB).toFixed(1),
                      total: (disk.totalBytes / GB).toFixed(1),
                    })}
                    <span className={`ml-2 ${alarm ? "text-danger" : "text-fg-faint"}`}>
                      {Math.round(pct)}%
                    </span>
                  </span>
                </div>
                <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-ink-800">
                  <div
                    className={`h-full rounded-full ${alarm ? "bg-danger" : "bg-signal"}`}
                    style={{ width: `${Math.min(100, pct)}%` }}
                  />
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
