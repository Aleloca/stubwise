import { Outlet, useRouterState } from "@tanstack/react-router";
import { useLayoutEffect } from "react";
import { integrationTargetOf, isIntegrated } from "../data/integration";
import { ComingSoon } from "../pages/Placeholder";
import { NotificationsPanel } from "../notifications/NotificationsPanel";
import { BriefPanelHost } from "../pages/overview/BriefCard";
import { NewRequestHost } from "../pages/requests/NewRequestDialog";
import { RequestDetailHost } from "../pages/requests/RequestDetail";
import { NewTaskHost } from "../pages/task/NewTaskDialog";
import { ChannelSettingsHost } from "../pages/chat/ChannelSettings";
import { ChatDialogsHost } from "../pages/chat/ChatDialogsHost";
import { ThreadPanelHost } from "../pages/chat/ThreadPanel";
import { TaskDetailHost } from "../pages/task/TaskDetail";
import { DriveDetailHost } from "../pages/drive/DriveDetail";
import { FilePreviewHost } from "../pages/drive/FilePreview";
import { GoogleAccountHost } from "../pages/drive/GoogleAccountCard";
import { WhichProjectHost } from "../pages/drive/WhichProjectDialog";
import { NewAutomationHost } from "../pages/automations/NewAutomationHost";
import { SourceDetailHost } from "../pages/automations/SourcePanel";
import { PrPanelHost } from "../pages/releases/PrPanel";
import { DepartmentPanelHost } from "../pages/admin/DepartmentPanel";
import { MemberPanelHost } from "../pages/settings/MembersSettings";
import { useAutomationsLiveRefresh } from "../data/queries";
import { CommandPalette } from "../palette/CommandPalette";
import { applyPlatformAttribute } from "../platform/platform";
import { ToastRegion } from "../tasks-ui/Toast";
import { ClaudePanelHost } from "./claudePanel/ClaudePanel";
import { useClaudeBeside } from "./claudePanel/panelEvents";
import { Column } from "./Column";
import { Rail } from "./Rail";
import { ReauthHost } from "./ReauthDialog";
import { DOCKED_PANEL_QUERY } from "./useDetailPanel";
import { useMediaQuery } from "./useMediaQuery";
import { useMenuEvents } from "./useMenuEvents";

/**
 * Tre zone: binario | colonna | area di lavoro. Nella terza, accanto alla
 * pagina, il pannello della task (`?task=`): affiancato occupa la sua
 * larghezza, sovrapposto copre la pagina. Il dialogo «New task» (`?newTask=1`)
 * si apre sopra qualunque route, come «New request» (`?newRequest=`). Nelle richieste di
 * un progetto, `?request=` apre il pannello della richiesta al posto di quello della task;
 * nell'Overview, `?brief=` quello di lettura del brief; ovunque, `?file=` quello di un
 * file del Drive.
 */
export function AppLayout() {
  useMenuEvents();
  useAutomationsLiveRefresh();
  // Prima del primo disegno: le testate su Windows riservano i controlli finestra.
  useLayoutEffect(applyPlatformAttribute, []);
  // Il costruttore delle automazioni (shape automation-builder.md [A 4]):
  // sotto i 1200 px la colonna si chiude, così flusso e pannello hanno spazio;
  // la prova (automation-test.md §6) è una sua modalità, e fa lo stesso.
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const wide = useMediaQuery(DOCKED_PANEL_QUERY);
  // Area 10b (D2, [AU 12]): arrivando dal riquadro di Claude sulla prova, la
  // colonna si chiude anche a 1440 (la pagina della prova lascia al riquadro la
  // sua larghezza: il flusso gli sta accanto, non sotto, claude-automations §6).
  const beside = useClaudeBeside();
  const noColumn = (!wide && /^\/automations\/[^/]+\/(edit|test)$/.test(pathname)) || beside > 0;
  return (
    <div
      data-column={noColumn ? "closed" : undefined}
      className={`grid h-full ${noColumn ? "grid-cols-[64px_minmax(0,1fr)]" : "grid-cols-[64px_240px_minmax(0,1fr)]"} grid-rows-[minmax(0,1fr)] bg-ground text-ink`}
    >
      <Rail />
      {!noColumn && <Column />}
      <div data-zone="work-row" className="relative flex min-h-0 min-w-0">
        <main data-zone="work" className="min-w-0 flex-1 overflow-auto">
          <IntegrationGate />
        </main>
        <TaskDetailHost />
        <RequestDetailHost />
        <BriefPanelHost />
        <ThreadPanelHost />
        <ChannelSettingsHost />
        <DriveDetailHost />
        <SourceDetailHost />
        <PrPanelHost />
        <DepartmentPanelHost />
        <MemberPanelHost />
        {/* L'anteprima intera di un file del Drive copre l'area di lavoro (binario e colonna restano). */}
        <FilePreviewHost />
      </div>
      {/* Il riquadro di Claude (area 10a): montato una volta, sopra l'area di
          lavoro e a sinistra del pannello di dettaglio; chiuso resta montato. */}
      <ClaudePanelHost />
      <NewTaskHost />
      <NewRequestHost />
      <ChatDialogsHost />
      <GoogleAccountHost />
      <WhichProjectHost />
      <NewAutomationHost />
      <CommandPalette />
      <ReauthHost />
      <NotificationsPanel />
      <ToastRegion />
    </div>
  );
}

/**
 * L'area di lavoro: la pagina dell'indirizzo, o «Coming soon» quando la
 * build app non l'ha ancora integrata (nel prototipo sempre la pagina). La
 * pagina non integrata non si monta proprio: nessuna sua lettura parte.
 */
function IntegrationGate() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const gate = integrationTargetOf(pathname);
  if (gate && !isIntegrated(gate.target)) return <ComingSoon titleKey={gate.titleKey} />;
  return <Outlet />;
}
