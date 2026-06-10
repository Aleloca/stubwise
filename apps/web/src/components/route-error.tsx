import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { useEffect } from "react";
import { ApiError } from "../lib/api";

/**
 * Error boundary di default del router. Un 401 emerso da un loader significa
 * sessione scaduta a app già montata (la guardia `beforeLoad` copre solo
 * l'ingresso): si svuota tutta la cache — come al logout, il prossimo login
 * non deve vedere dati dell'identità precedente — e si torna al login. Tutti
 * gli altri errori mostrano un pannello con messaggio e retry.
 */
export function RouteError({ error }: { error: Error }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const sessionExpired = error instanceof ApiError && error.status === 401;

  useEffect(() => {
    if (!sessionExpired) return;
    queryClient.clear();
    void router.navigate({ to: "/login" });
  }, [sessionExpired, queryClient, router]);

  // Niente pannello d'errore per la sessione scaduta: il redirect è in volo.
  if (sessionExpired) return null;

  return (
    <div className="grid min-h-[60vh] place-items-center p-8" role="alert">
      <div className="w-full max-w-md rounded-sm border border-danger/30 bg-ink-900 p-6">
        <p className="font-mono text-[11px] tracking-[0.18em] text-danger uppercase">Errore</p>
        <p className="mt-2 text-sm text-fg-muted">{error.message}</p>
        <button
          type="button"
          onClick={() => void router.invalidate()}
          className="mt-4 rounded-sm border border-line-strong px-3 py-1.5 font-mono text-[11px] tracking-[0.12em] text-fg-muted uppercase transition-colors hover:border-signal-dim hover:text-fg"
        >
          Riprova
        </button>
      </div>
    </div>
  );
}
