import { Outlet, useRouterState } from "@tanstack/react-router";
import { useLayoutEffect } from "react";
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
import { useAutomationsLiveRefresh } from "../data/queries";
import { CommandPalette } from "../palette/CommandPalette";
import { applyPlatformAttribute } from "../platform/platform";
import { ToastRegion } from "../tasks-ui/Toast";
import { Column } from "./Column";
import { Rail } from "./Rail";
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
  const noColumn = !wide && /^\/automations\/[^/]+\/(edit|test)$/.test(pathname);
  return (
    <div
      data-column={noColumn ? "closed" : undefined}
      className={`grid h-full ${noColumn ? "grid-cols-[64px_minmax(0,1fr)]" : "grid-cols-[64px_240px_minmax(0,1fr)]"} grid-rows-[minmax(0,1fr)] bg-ground text-ink`}
    >
      <Rail />
      {!noColumn && <Column />}
      <div data-zone="work-row" className="relative flex min-h-0 min-w-0">
        <main data-zone="work" className="min-w-0 flex-1 overflow-auto">
          <Outlet />
        </main>
        <TaskDetailHost />
        <RequestDetailHost />
        <BriefPanelHost />
        <ThreadPanelHost />
        <ChannelSettingsHost />
        <DriveDetailHost />
        <SourceDetailHost />
        {/* L'anteprima intera di un file del Drive copre l'area di lavoro (binario e colonna restano). */}
        <FilePreviewHost />
      </div>
      <NewTaskHost />
      <NewRequestHost />
      <ChatDialogsHost />
      <GoogleAccountHost />
      <WhichProjectHost />
      <NewAutomationHost />
      <CommandPalette />
      <NotificationsPanel />
      <ToastRegion />
    </div>
  );
}
