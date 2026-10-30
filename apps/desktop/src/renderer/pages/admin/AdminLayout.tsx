import { Link, Navigate } from "@tanstack/react-router";
import { useId } from "react";
import { useTranslation } from "react-i18next";
import { adminSections, canSeeAdminSection } from "../../data/adminSections";
import { useAdminPeople } from "../../data/queries";
import { isAdminSection, type AdminSection } from "../../data/routes";
import { useViewer } from "../../data/viewer";
import { ONE_LINE, columnItemClass } from "../../layout/ProjectColumn";
import { NotFound } from "../NotFound";
import { ChangeLogPage } from "./ChangeLogPage";
import { DepartmentsPage } from "./DepartmentsPage";
import { InvitePage } from "./InvitePage";
import { PeoplePage } from "./PeoplePage";
import { PersonDetail } from "./PersonDetail";
import { RoleEditor } from "./RoleEditor";
import { RolesPage } from "./RolesPage";
import { WhoCanPage } from "./WhoCanPage";

// L'intelaiatura dell'Amministrazione (area 9a, shape admin-people.md §3):
// la colonna con le voci che chi guarda vede (`adminSections`), raggruppate
// in ACCESS e RECORDS, senza titolo (l'h1 della pagina è il titolo); `/admin`
// apre la prima voce visibile; una voce aperta per indirizzo senza permesso è
// la pagina «not found» dell'app (R-G5), non un «forbidden».

/** Il numero di persone attive accanto a People, in cifre tabellari. */
function PeopleCount() {
  const people = useAdminPeople({ statuses: ["active"] });
  if (!people.data) return null;
  return (
    <span className="num ml-auto shrink-0 pl-2 text-xs text-ink-faint">{people.data.length}</span>
  );
}

/** La colonna dell'Amministrazione: le voci per gruppo, un gruppo senza voci non c'è. */
export function AdminColumn() {
  const { t } = useTranslation();
  const { viewer } = useViewer();
  const sections = adminSections(viewer);
  const baseId = useId();
  const groups = (["access", "records"] as const)
    .map((group) => ({ group, items: sections.filter((s) => s.group === group) }))
    .filter((g) => g.items.length > 0);
  return (
    <nav
      aria-label={t("admin.columnLabel")}
      className="min-h-0 flex-1 overflow-y-auto px-2 pt-1 pb-2"
    >
      {groups.map(({ group, items }) => (
        <div key={group}>
          {/* Non un titolo (la colonna non ne ha): dà il nome al gruppo. */}
          <p id={`${baseId}-${group}`} className="heading-group px-2.5 pt-4 pb-1.5">
            {t(`admin.groups.${group}`)}
          </p>
          <ul aria-labelledby={`${baseId}-${group}`} className="flex flex-col gap-px">
            {items.map((s) => (
              <li key={s.id}>
                <Link
                  to="/admin/$section"
                  params={{ section: s.id }}
                  // La persona e l'invito restano dentro People.
                  activeOptions={{ exact: false }}
                  style={{ whiteSpace: "nowrap" }}
                  className={columnItemClass}
                >
                  <span style={ONE_LINE} className="min-w-0">
                    {t(`admin.sections.${s.id}`)}
                  </span>
                  {s.id === "people" && <PeopleCount />}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </nav>
  );
}

/** `/admin`: la prima voce visibile; senza voci, «not found». */
export function AdminIndex() {
  const { viewer } = useViewer();
  const first = adminSections(viewer)[0];
  if (!first) return <NotFound />;
  return <Navigate to="/admin/$section" params={{ section: first.id }} replace />;
}

/**
 * Una voce dell'Amministrazione. Cambiare persona («vedi come») la rimonta:
 * filtri, dialoghi e valori mostrati una volta della persona di prima non
 * restano.
 */
export function AdminSectionPage({ section }: { section: string }) {
  const { viewer } = useViewer();
  if (!isAdminSection(section) || !canSeeAdminSection(viewer, section)) return <NotFound />;
  return <SectionBody key={viewer.personId} section={section} />;
}

function SectionBody({ section }: { section: AdminSection }) {
  if (section === "people") return <PeoplePage />;
  if (section === "departments") return <DepartmentsPage />;
  if (section === "roles") return <RolesPage />;
  if (section === "changelog") return <ChangeLogPage />;
  return <WhoCanPage />;
}

/** La pagina di un ruolo (`/admin/roles/$roleId`): dentro Roles, con `roles.manage`. */
export function AdminRolePage({ roleId }: { roleId: string }) {
  const { viewer } = useViewer();
  if (!canSeeAdminSection(viewer, "roles")) return <NotFound />;
  return <RoleEditor key={`${viewer.personId}:${roleId}`} roleId={roleId} />;
}

/** La pagina di una persona (`/admin/people/$personId`): dentro People, che legge chiunque. */
export function AdminPersonPage({ personId }: { personId: string }) {
  const { viewer } = useViewer();
  if (!canSeeAdminSection(viewer, "people")) return <NotFound />;
  return <PersonDetail key={`${viewer.personId}:${personId}`} personId={personId} />;
}

/** La pagina di un invito (`/admin/people/invites/$inviteId`). */
export function AdminInvitePage({ inviteId }: { inviteId: string }) {
  const { viewer } = useViewer();
  if (!canSeeAdminSection(viewer, "people")) return <NotFound />;
  return <InvitePage key={`${viewer.personId}:${inviteId}`} inviteId={inviteId} />;
}
