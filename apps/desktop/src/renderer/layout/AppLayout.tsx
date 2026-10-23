import { Outlet } from "@tanstack/react-router";

/** Tre zone: binario | colonna | area di lavoro. Binario e colonna si riempiono nei task 6 e 7. */
export function AppLayout() {
  return (
    <div className="grid h-full grid-cols-[64px_240px_minmax(0,1fr)] bg-ground text-ink">
      <nav aria-label="Rail" data-zone="rail" className="border-r border-rule bg-rail" />
      <aside data-zone="column" className="border-r border-rule bg-surface" />
      <main data-zone="work" className="min-w-0 overflow-auto">
        <Outlet />
      </main>
    </div>
  );
}
