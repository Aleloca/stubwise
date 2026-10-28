import { useNavigate } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { useSupportWidgets } from "../../data/queries";
import { PageEmpty, PageError, PageSkeleton } from "../../tasks-ui/PageStates";
import { primaryButton, secondaryButton } from "../claude/conversation/parts";
import { WidgetPanel } from "./WidgetPanel";

// La vista Widget della sezione (shape support.md §6, [A 1], [A 16], R-K13):
// solo per chi ha `widget.manage`. Righe di 48 px (nome · On/Off in parole ·
// conversazioni · Edit), «New widget» in testa; nuovo e modifica nel pannello
// agganciato a destra coi campi del web; sotto, per un widget salvato, lo
// snippet e la guida. Eliminare chiede conferma sul posto: le conversazioni
// restano.

export function Widgets({
  projectId,
  projectCode,
  open,
}: {
  projectId: string;
  projectCode: string;
  /** Il pannello aperto: l'id di un widget o `new`. */
  open: string | null;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const q = useSupportWidgets(projectId);
  const setOpen = (widget: string | null) =>
    void navigate({
      to: "/p/$code/$section",
      params: { code: projectCode, section: "support" },
      search: { view: "widgets", widget: widget ?? undefined } as never,
      replace: true,
    });
  const widgets = q.data?.widgets ?? [];
  const current = open && open !== "new" ? (widgets.find((w) => w.id === open) ?? null) : null;
  const panelOpen = open === "new" || current !== null;

  return (
    <div className="flex min-h-0 flex-1">
      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto px-8 pt-4 pb-10">
        <div className="flex max-w-[760px] flex-col gap-3">
          <div>
            <button type="button" className={primaryButton} onClick={() => setOpen("new")}>
              {t("support.widgets.new")}
            </button>
          </div>
          {q.isError ? (
            <PageError message={t("support.widgets.error")} onRetry={() => void q.refetch()} />
          ) : !q.data ? (
            <PageSkeleton rows={2} />
          ) : widgets.length === 0 ? (
            <PageEmpty title={t("support.widgets.empty")} />
          ) : (
            <ul aria-label={t("support.views.widgets")} className="@container border-t border-rule">
              {widgets.map((w) => (
                <li
                  key={w.id}
                  data-widget-row={w.id}
                  aria-current={w.id === open || undefined}
                  className="flex min-h-12 flex-wrap items-center gap-x-4 gap-y-1 border-b border-rule px-3 py-2 aria-[current]:bg-ink/10"
                >
                  {/* Stretta (pannello aperto a 1024): il nome ha una riga sua, mai nascosto. */}
                  <span
                    title={w.name}
                    className="min-w-0 basis-full truncate text-md font-medium text-ink @[440px]:flex-1 @[440px]:basis-auto"
                  >
                    {w.name}
                  </span>
                  <span className={`text-sm ${w.enabled ? "text-ink" : "text-ink-muted"}`}>
                    {w.enabled ? t("support.widgets.on") : t("support.widgets.off")}
                  </span>
                  <span className="num text-sm text-ink-muted @[440px]:min-w-32 @[440px]:text-right">
                    {t("support.widgets.conversations", { count: w.conversationCount })}
                  </span>
                  <button
                    type="button"
                    className={secondaryButton}
                    aria-label={t("support.widgets.editNamed", { name: w.name })}
                    onClick={() => setOpen(w.id)}
                  >
                    {t("support.widgets.edit")}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
      {panelOpen && (
        <WidgetPanel
          key={open!}
          projectId={projectId}
          widget={current}
          onClose={() => setOpen(null)}
        />
      )}
    </div>
  );
}
