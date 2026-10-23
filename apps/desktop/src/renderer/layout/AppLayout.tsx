import { Outlet } from "@tanstack/react-router";
import { useLayoutEffect } from "react";
import { NotificationsPanel } from "../notifications/NotificationsPanel";
import { CommandPalette } from "../palette/CommandPalette";
import { applyPlatformAttribute } from "../platform/platform";
import { ToastRegion } from "../tasks-ui/Toast";
import { Column } from "./Column";
import { Rail } from "./Rail";
import { useMenuEvents } from "./useMenuEvents";

/** Tre zone: binario | colonna | area di lavoro. */
export function AppLayout() {
  useMenuEvents();
  // Prima del primo disegno: le testate su Windows riservano i controlli finestra.
  useLayoutEffect(applyPlatformAttribute, []);
  return (
    <div className="grid h-full grid-cols-[64px_240px_minmax(0,1fr)] grid-rows-[minmax(0,1fr)] bg-ground text-ink">
      <Rail />
      <Column />
      <main data-zone="work" className="min-w-0 overflow-auto">
        <Outlet />
      </main>
      <CommandPalette />
      <NotificationsPanel />
      <ToastRegion />
    </div>
  );
}
