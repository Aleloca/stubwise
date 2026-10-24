import { useRouterState } from "@tanstack/react-router";
import { useLayoutEffect, useState } from "react";
import { flushSync } from "react-dom";
import { APP_ROUTES } from "../data/routes";
import { PersonalColumn, type Destination } from "./PersonalColumn";
import { ProjectColumn } from "./ProjectColumn";
import { prefersReducedMotion } from "./useMediaQuery";

/**
 * Il contesto della colonna, dal pathname: `p/<CODE>` per un progetto,
 * altrimenti il nome della destinazione. Cambia solo cambiando progetto o
 * destinazione, non sezione.
 */
export function contextOf(pathname: string): string {
  const project = /^\/p\/([^/]+)/.exec(pathname);
  if (project) return `p/${project[1]!.toUpperCase()}`;
  const first = pathname.split("/")[1] ?? "";
  // I filtri (fissati e «All filters») e la Planning trasversale vivono nella colonna della Home.
  if (first === "filters" || first === "planning") return "home";
  return (APP_ROUTES as readonly string[]).includes(first) ? first : "home";
}

/** Classe dell'entrata animata in CSS, quando non c'è la View Transitions API. */
export const CONTEXT_ENTER_CLASS = "context-enter";

type ViewTransitionDocument = Document & {
  startViewTransition?: (update: () => void) => unknown;
};

/**
 * La colonna (240 px): personale o di progetto secondo la route. Al cambio di
 * contesto esce ed entra (12 px in orizzontale + dissolvenza, `--duration`):
 * con la View Transitions API se c'è, con un'animazione CSS d'entrata se no,
 * senza movimento se l'utente l'ha chiesto ridotto.
 */
export function Column() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const target = contextOf(pathname);
  const [shown, setShown] = useState(target);
  const [entering, setEntering] = useState(false);

  // Layout effect: la colonna vecchia è ancora nel DOM, quindi la View
  // Transition ne fotografa lo stato prima di sostituirla.
  useLayoutEffect(() => {
    if (target === shown) return;
    const doc = document as ViewTransitionDocument;
    if (prefersReducedMotion()) {
      setEntering(false);
      setShown(target);
    } else if (typeof doc.startViewTransition === "function") {
      setEntering(false);
      doc.startViewTransition(() => flushSync(() => setShown(target)));
    } else {
      setEntering(true);
      setShown(target);
    }
  }, [target, shown]);

  return (
    <aside
      data-zone="column"
      className="flex min-h-0 flex-col overflow-hidden border-r border-rule bg-surface"
    >
      <div
        key={shown}
        data-context={shown}
        onAnimationEnd={() => setEntering(false)}
        className={`flex min-h-0 flex-1 flex-col [view-transition-name:context-column] ${entering ? CONTEXT_ENTER_CLASS : ""}`}
      >
        {shown.startsWith("p/") ? (
          <ProjectColumn code={shown.slice(2)} />
        ) : (
          <PersonalColumn destination={shown as Destination} />
        )}
      </div>
    </aside>
  );
}
