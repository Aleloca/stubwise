import { useTranslation } from "react-i18next";
import { WhoCanLink } from "../../components/WhoCanLink";
import type { SectionAccess } from "../../data/queries";
import type { ProjectSettingsSection } from "../../data/routes";
import { OpenCircleGlyph } from "../preferences/glyphs";

// «View only» delle impostazioni di progetto (shape project-settings.md
// [PS 3], forma (a) confermata dal maintainer il 31 ott 2026). Tutto si
// legge da `access` del livello dati (`projectSettingsAccess`), mai da
// `can()`:
// 1. una sezione è in sola lettura se si vede, non si scrive e ha qualcosa
//    da scrivere (`editAction`): Usage e Change log non lo sono mai;
// 2. il segno di colonna sta su «Settings» se TUTTE le sezioni scrivibili
//    sono in sola lettura, sulle singole voci rientrate se lo sono solo
//    alcune, da nessuna parte se si scrive tutto;
// 3. nella sezione, sempre, la riga ○ con la frase e «Who?».

const readOnly = (a: SectionAccess): boolean => a.visible && !a.canEdit && a.editAction !== null;

/** Dove sta il segno «View only» nella colonna, per le regole 1 e 2. */
export function viewOnlyMarks(access: Record<ProjectSettingsSection, SectionAccess>): {
  onSettings: boolean;
  sections: ReadonlySet<ProjectSettingsSection>;
} {
  const entries = Object.entries(access) as [ProjectSettingsSection, SectionAccess][];
  const editable = entries.filter(([, a]) => a.visible && a.editAction !== null);
  const locked = editable.filter(([, a]) => readOnly(a)).map(([id]) => id);
  if (locked.length === 0) return { onSettings: false, sections: new Set() };
  if (locked.length === editable.length) return { onSettings: true, sections: new Set() };
  return { onSettings: false, sections: new Set(locked) };
}

/** Il segno di colonna: la parola, il perché nel `title` e per chi legge con lo schermo. */
export function ViewOnlyMark() {
  const { t } = useTranslation();
  const why = t("settings.viewOnly.markTitle");
  return (
    <span data-view-only title={why} className="ml-auto shrink-0 text-xs font-normal text-ink-faint">
      <span aria-hidden="true">{t("settings.viewOnly.mark")}</span>
      <span className="sr-only">{why}</span>
    </span>
  );
}

/** Le azioni di `ACTIONS` che una sezione di Settings può nominare nel suo «Who?». */
type ViewOnlyAction = "manageProjectSettings" | "manageMembers" | "manageRepos";

/**
 * La riga ○ in testa a una sezione in sola lettura: la frase della sezione
 * e «Who?» in coda. `id` la fa leggere ai controlli spenti
 * (`aria-describedby`): ognuno ha così la sua frase e il suo «Who?».
 */
export function ViewOnlyLine({
  action,
  projectId,
  code,
  id,
}: {
  action: string;
  projectId: string;
  code: string;
  id?: string;
}) {
  const { t } = useTranslation();
  return (
    <p
      id={id}
      data-view-only-line={action}
      className="flex max-w-[72ch] items-start gap-1.5 pb-5 text-sm text-pretty text-ink-muted"
    >
      <span className="mt-[3px] shrink-0">
        <OpenCircleGlyph size={12} />
      </span>
      <span className="min-w-0">
        {t(`settings.viewOnly.lines.${action as ViewOnlyAction}`, { code })}{" "}
        <WhoCanLink action={action} projectId={projectId} projectCode={code} />
      </span>
    </p>
  );
}
