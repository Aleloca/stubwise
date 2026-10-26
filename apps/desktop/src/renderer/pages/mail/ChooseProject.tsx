import { useTranslation } from "react-i18next";
import { useProjects } from "../../data/queries";
import type { MailProposalView } from "../../data/types";
import { WorkingRing } from "../claude/conversation/parts";

/** «Which project is this about?»: una riga per candidato, «None of these» = Ignora. */
export function ChooseProject({
  view,
  chosen,
  busy,
  onChoose,
  onNone,
}: {
  view: MailProposalView;
  chosen: string | null;
  busy: boolean;
  onChoose: (projectId: string) => void;
  onNone: () => void;
}) {
  const { t } = useTranslation();
  const projects = useProjects().data;
  const action = view.proposal.actions.find((a) => a.fn === "chooseProject")!;
  const ids = (action.args.projectIds as string[] | undefined) ?? [];
  const row =
    "flex min-h-10 w-full items-center gap-2 rounded-md border border-rule px-3 text-left text-md text-ink transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/6 disabled:opacity-40";
  if (chosen) {
    const p = projects?.find((x) => x.id === chosen);
    return (
      <p role="status" className="flex items-center gap-2 text-sm text-ink-muted">
        <WorkingRing size={10} />
        {t("mail.proposal.analysingFor", { code: p?.code ?? "" })}
      </p>
    );
  }
  return (
    <ul className="flex flex-col gap-1.5">
      {ids.map((id) => {
        const p = projects?.find((x) => x.id === id);
        if (!p) return null;
        return (
          <li key={id}>
            <button type="button" className={row} disabled={busy} onClick={() => onChoose(id)}>
              <span className="num w-9 shrink-0 text-xs font-semibold tracking-[0.02em]">{p.code}</span>
              <span className="min-w-0 truncate">{p.name}</span>
            </button>
          </li>
        );
      })}
      <li>
        <button type="button" className={`${row} text-ink-muted`} disabled={busy} onClick={onNone}>
          {t("mail.proposal.none")}
        </button>
      </li>
    </ul>
  );
}
