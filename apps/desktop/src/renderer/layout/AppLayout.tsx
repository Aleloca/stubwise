import { Outlet } from "@tanstack/react-router";
import { useLayoutEffect } from "react";
import { NotificationsPanel } from "../notifications/NotificationsPanel";
import { BriefPanelHost } from "../pages/overview/BriefCard";
import { NewRequestHost } from "../pages/requests/NewRequestDialog";
import { RequestDetailHost } from "../pages/requests/RequestDetail";
import { NewTaskHost } from "../pages/task/NewTaskDialog";
import { TaskDetailHost } from "../pages/task/TaskDetail";
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
 * nell'Overview, `?brief=` quello di lettura del brief.
 */
export function AppLayout() {
  useMenuEvents();
  // Prima del primo disegno: le testate su Windows riservano i controlli finestra.
  useLayoutEffect(applyPlatformAttribute, []);
  return (
    <div className="grid h-full grid-cols-[64px_240px_minmax(0,1fr)] grid-rows-[minmax(0,1fr)] bg-ground text-ink">
      <Rail />
      <Column />
      <div data-zone="work-row" className="flex min-h-0 min-w-0">
        <main data-zone="work" className="min-w-0 flex-1 overflow-auto">
          <Outlet />
        </main>
        <TaskDetailHost />
        <RequestDetailHost />
        <BriefPanelHost />
      </div>
      <NewTaskHost />
      <NewRequestHost />
      <CommandPalette />
      <NotificationsPanel />
      <ToastRegion />
    </div>
  );
}
