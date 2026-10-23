import { Outlet } from "@tanstack/react-router";
import { Rail } from "./Rail";

/** Tre zone: binario | colonna | area di lavoro. La colonna si riempie nel task 7. */
export function AppLayout() {
  return (
    <div className="grid h-full grid-cols-[64px_240px_minmax(0,1fr)] grid-rows-[minmax(0,1fr)] bg-ground text-ink">
      <Rail />
      <aside data-zone="column" className="border-r border-rule bg-surface" />
      <main data-zone="work" className="min-w-0 overflow-auto">
        <Outlet />
      </main>
    </div>
  );
}
