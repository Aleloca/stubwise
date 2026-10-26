import { Outlet } from "@tanstack/react-router";
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
import { SourceDetailHost } from "../pages/automations/SourcePanel";
import { CommandPalette } from "../palette/CommandPalette";
import { applyPlatformAttribute } from "../platform/platform";
import { ToastRegion } from "../tasks-ui/Toast";
import { Column } from "./Column";
import { Rail } from "./Rail";
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
  // Prima del primo disegno: le testate su Windows riservano i controlli finestra.
  useLayoutEffect(applyPlatformAttribute, []);
  return (
    <div className="grid h-full grid-cols-[64px_240px_minmax(0,1fr)] grid-rows-[minmax(0,1fr)] bg-ground text-ink">
      <Rail />
      <Column />
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
      <CommandPalette />
      <NotificationsPanel />
      <ToastRegion />
    </div>
  );
}
