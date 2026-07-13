import { serverMetrics, servers, serviceChecks, type Db } from "@stubwise/db";
import {
  dispatchNotification,
  type MonitorCondition,
  type NotificationEvent,
} from "@stubwise/notifications";
import {
  alertThresholdsSchema,
  computeServerStatus,
  type AlertThresholds,
} from "@stubwise/shared";
import { and, eq, gte } from "drizzle-orm";

/**
 * VALUTAZIONE ALERT del monitoraggio (isteresi + recovery).
 *
 * Gira SOLO nel poller (single-flight per costruzione): niente concorrenza, per
 * questo lo stato anti-spam `servers.activeAlerts` si può riscrivere per intero
 * senza lock. Per ogni server valuta tre famiglie di condizioni:
 *
 *   1. offline — `computeServerStatus` (never_connected NON allarma);
 *   2. soglie sostenute cpu/mem/disk — sui campioni fini della finestra
 *      `sustainedMinutes` (solo se il server è online e la soglia non è null);
 *   3. check down — stato per-check in `service_checks.down_notified_at`.
 *
 * Le famiglie 1 e 2 usano `activeAlerts` (chiavi "offline"|"cpu"|"mem"|"disk")
 * come memoria di isteresi: si entra una volta sola (anti-spam), si esce con un
 * `monitor.recovered` quando la condizione rientra. La famiglia 3 usa il
 * contratto con l'ingest (B1): l'ingest NON tocca MAI `down_notified_at`, lo
 * scrive/azzera SOLO questo evaluator.
 *
 * SCELTA DELIBERATA (offline vs soglie): le soglie cpu/mem/disk si valutano solo
 * a server ONLINE. Se un server con un alert cpu attivo va offline, l'alert cpu
 * NON viene risolto (non c'è nulla da valutare): resta finché il server non
 * torna online e la condizione rientra davvero. Nel frattempo scatta l'alert
 * offline. Evita un falso "recovered" causato dalla sola assenza di campioni.
 *
 * Robustezza: try/catch PER SERVER e PER CHECK — un dato sporco (es. thresholds
 * jsonb malformati) non ferma gli altri. La funzione non lancia MAI. Le notifiche
 * sono best-effort: un dispatch che lancia viene inghiottito.
 */

/** Firma del dispatch iniettabile (default: dispatchNotification). */
export type DispatchFn = (db: Db, event: NotificationEvent) => Promise<void>;

/** Chiavi di `activeAlerts` gestite come condizioni con isteresi. */
type ThresholdKey = "cpu" | "mem" | "disk";

interface WindowSample {
  cpuPct: number;
  memUsedBytes: number;
  memTotalBytes: number;
  diskUsedBytes: number;
  diskTotalBytes: number;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Percentuale used/total; null se `total` non è positivo (non calcolabile). */
function pctOf(used: number, total: number): number | null {
  return total > 0 ? (used / total) * 100 : null;
}

/** Emette una notifica best-effort: mai propaga (una notifica non altera lo stato). */
async function safeDispatch(dispatch: DispatchFn, db: Db, event: NotificationEvent): Promise<void> {
  try {
    await dispatch(db, event);
  } catch {
    // Best-effort: la notifica non deve mai far fallire la valutazione.
  }
}

export interface EvaluateMonitorAlertsDeps {
  db: Db;
  /** Dispatch iniettabile nei test. Default: dispatchNotification. */
  dispatch?: DispatchFn;
  /** URL pubblico dell'istanza (senza slash finali): base dei link nei payload. */
  publicUrl: string;
}

/**
 * Un giro di valutazione su TUTTI i server. Non lancia mai: ogni errore
 * per-server/per-check viene loggato e la valutazione prosegue.
 */
export async function evaluateMonitorAlertsOnce(
  deps: EvaluateMonitorAlertsDeps,
  now: Date = new Date(),
): Promise<void> {
  const { db } = deps;
  const dispatch = deps.dispatch ?? dispatchNotification;
  const base = deps.publicUrl.replace(/\/+$/, "");

  let allServers: (typeof servers.$inferSelect)[];
  try {
    allServers = await db.select().from(servers);
  } catch (err) {
    console.error(`[stubwise-worker] monitor-alerts: lettura server fallita: ${errText(err)}`);
    return;
  }

  for (const server of allServers) {
    const url = `${base}/monitor/servers/${server.id}`;
    // Stato host (offline + soglie): isolato dai check, isolato dagli altri server.
    try {
      await evaluateServerStatus(db, dispatch, server, url, now);
    } catch (err) {
      console.error(
        `[stubwise-worker] monitor-alerts: server ${server.id} fallito: ${errText(err)}`,
      );
    }
    // Check down: caricamento + loop, ogni check con il suo try/catch.
    try {
      const checks = await db
        .select()
        .from(serviceChecks)
        .where(eq(serviceChecks.serverId, server.id));
      for (const check of checks) {
        try {
          await evaluateCheck(db, dispatch, server.name, check, url, now);
        } catch (err) {
          console.error(
            `[stubwise-worker] monitor-alerts: check ${check.id} fallito: ${errText(err)}`,
          );
        }
      }
    } catch (err) {
      console.error(
        `[stubwise-worker] monitor-alerts: check del server ${server.id} falliti: ${errText(err)}`,
      );
    }
  }
}

/** Valuta offline + soglie sostenute per un server, aggiornando `activeAlerts`. */
async function evaluateServerStatus(
  db: Db,
  dispatch: DispatchFn,
  server: typeof servers.$inferSelect,
  url: string,
  now: Date,
): Promise<void> {
  const nowIso = now.toISOString();
  // Copia mutabile dello stato anti-spam; a fine giro si riscrive se cambiato.
  const active: Record<string, { since: string; notifiedAt: string | null }> = {
    ...(server.activeAlerts ?? {}),
  };
  const pending: NotificationEvent[] = [];
  let changed = false;

  /** Entra in allarme (una volta sola) o resta silente (anti-spam). */
  const enter = (key: string, condition: MonitorCondition, detail: string): void => {
    const existing = active[key];
    if (existing && existing.notifiedAt !== null) return; // già notificato
    active[key] = { since: existing?.since ?? nowIso, notifiedAt: nowIso };
    changed = true;
    pending.push({ kind: "monitor.alert", serverName: server.name, condition, detail, url });
  };
  /** Esce dall'allarme (recovered) se una chiave era attiva. */
  const exit = (key: string, condition: MonitorCondition, detail: string): void => {
    if (!active[key]) return;
    delete active[key];
    changed = true;
    pending.push({ kind: "monitor.recovered", serverName: server.name, condition, detail, url });
  };

  const status = computeServerStatus(server.lastSeenAt, server.sampleIntervalSeconds, now);

  // 1) Offline. never_connected NON allarma e non risolve nulla.
  if (status === "offline") {
    const silentMin = server.lastSeenAt
      ? Math.floor((now.getTime() - server.lastSeenAt.getTime()) / 60_000)
      : 0;
    enter("offline", "offline", `Nessun heartbeat da ${silentMin} minuti`);
  } else if (status === "online") {
    exit("offline", "offline", "Server di nuovo online");
  }

  // 2) Soglie sostenute cpu/mem/disk: solo a server online. A server offline le
  // soglie NON si valutano (vedi docblock del modulo) e le eventuali chiavi
  // restano intatte.
  if (status === "online") {
    const thresholds = parseThresholds(server.alertThresholds);
    const window = await loadWindowSamples(db, server.id, thresholds.sustainedMinutes, now);
    // Minimo di campioni: metà di quelli attesi nella finestra (tolleranza buchi 50%).
    const expected = (thresholds.sustainedMinutes * 60) / server.sampleIntervalSeconds;
    const minSamples = expected * 0.5;

    const conds: {
      key: ThresholdKey;
      threshold: number | null;
      label: string;
      value: (s: WindowSample) => number | null;
    }[] = [
      { key: "cpu", threshold: thresholds.cpuPct, label: "CPU", value: (s) => s.cpuPct },
      {
        key: "mem",
        threshold: thresholds.memPct,
        label: "Memoria",
        value: (s) => pctOf(s.memUsedBytes, s.memTotalBytes),
      },
      {
        key: "disk",
        threshold: thresholds.diskPct,
        label: "Disco",
        value: (s) => pctOf(s.diskUsedBytes, s.diskTotalBytes),
      },
    ];

    for (const cond of conds) {
      // Soglia null = condizione disattivata: non allarma e non risolve.
      if (cond.threshold === null) continue;
      const threshold = cond.threshold;
      const enough = window.length > 0 && window.length >= minSamples;
      const allBreach = enough && window.every((s) => {
        const v = cond.value(s);
        return v !== null && v > threshold;
      });
      if (allBreach) {
        const last = window[window.length - 1]!;
        const cur = Math.round(cond.value(last) ?? 0);
        enter(
          cond.key,
          cond.key,
          `${cond.label} al ${cur}% da ${thresholds.sustainedMinutes} minuti (soglia ${threshold}%)`,
        );
      } else {
        exit(cond.key, cond.key, `${cond.label} rientrata sotto la soglia (${threshold}%)`);
      }
    }
  }

  // Persisti lo stato anti-spam PRIMA di notificare: l'anti-spam deve riflettere
  // realtà committata (una notifica persa è meglio di un doppio alert).
  if (changed) {
    await db.update(servers).set({ activeAlerts: active }).where(eq(servers.id, server.id));
  }
  for (const event of pending) {
    await safeDispatch(dispatch, db, event);
  }
}

/** Normalizza le soglie; su jsonb malformato torna i default (fail-safe). */
function parseThresholds(raw: unknown): AlertThresholds {
  const parsed = alertThresholdsSchema.safeParse(raw);
  if (parsed.success) return parsed.data;
  // Default dello schema: soglie standard, così un jsonb sporco non fa saltare
  // la valutazione (l'errore è già isolato dal try/catch per-server).
  return alertThresholdsSchema.parse({});
}

/** Campioni fini del server nella finestra `[now - sustainedMinutes, now]`, ordinati per ts. */
async function loadWindowSamples(
  db: Db,
  serverId: string,
  sustainedMinutes: number,
  now: Date,
): Promise<WindowSample[]> {
  const windowStart = new Date(now.getTime() - sustainedMinutes * 60_000);
  return db
    .select({
      cpuPct: serverMetrics.cpuPct,
      memUsedBytes: serverMetrics.memUsedBytes,
      memTotalBytes: serverMetrics.memTotalBytes,
      diskUsedBytes: serverMetrics.diskUsedBytes,
      diskTotalBytes: serverMetrics.diskTotalBytes,
    })
    .from(serverMetrics)
    .where(and(eq(serverMetrics.serverId, serverId), gte(serverMetrics.ts, windowStart)))
    .orderBy(serverMetrics.ts);
}

/**
 * Valuta un singolo check per il check_down. Contratto con B1: `downNotifiedAt`
 * lo scrive/azzera SOLO questo evaluator.
 *  - enabled && down && downNotifiedAt null → alert + scrivi downNotifiedAt;
 *  - (up | unknown) && downNotifiedAt valorizzato → recovered + azzera.
 */
async function evaluateCheck(
  db: Db,
  dispatch: DispatchFn,
  serverName: string,
  check: typeof serviceChecks.$inferSelect,
  url: string,
  now: Date,
): Promise<void> {
  if (check.enabled && check.lastStatus === "down" && check.downNotifiedAt === null) {
    await db.update(serviceChecks).set({ downNotifiedAt: now }).where(eq(serviceChecks.id, check.id));
    const detail = check.lastError
      ? `Check "${check.name}" non raggiungibile: ${check.lastError}`
      : `Check "${check.name}" non raggiungibile`;
    await safeDispatch(dispatch, db, {
      kind: "monitor.alert",
      serverName,
      condition: "check_down",
      detail,
      url,
    });
    return;
  }
  if (
    (check.lastStatus === "up" || check.lastStatus === "unknown") &&
    check.downNotifiedAt !== null
  ) {
    await db
      .update(serviceChecks)
      .set({ downNotifiedAt: null })
      .where(eq(serviceChecks.id, check.id));
    await safeDispatch(dispatch, db, {
      kind: "monitor.recovered",
      serverName,
      condition: "check_down",
      detail: `Check "${check.name}" di nuovo raggiungibile`,
      url,
    });
  }
}

export interface StartMonitorAlertPollerOptions {
  db: Db;
  dispatch?: DispatchFn;
  publicUrl: string;
  /** Intervallo di poll in minuti. ≤ 0 = disabilitato (non avvia nulla). */
  intervalMinutes: number;
  signal: AbortSignal;
}

/**
 * Avvia la valutazione degli alert su un proprio setInterval (pattern
 * startMonitorRollupPoller). Ad ogni tick esegue evaluateMonitorAlertsOnce; gli
 * errori residui vengono loggati e MAI propagati. Single-flight: non sovrappone
 * due giri. Stop sull'AbortSignal del worker. Ritorna uno stop idempotente.
 */
export function startMonitorAlertPoller(opts: StartMonitorAlertPollerOptions): () => void {
  if (opts.intervalMinutes <= 0) {
    return () => {};
  }
  let running = false;

  const tickOnce = async (): Promise<void> => {
    if (running) return; // evita sovrapposizioni se un giro è lento
    running = true;
    try {
      await evaluateMonitorAlertsOnce({
        db: opts.db,
        dispatch: opts.dispatch,
        publicUrl: opts.publicUrl,
      });
    } catch (err) {
      // evaluateMonitorAlertsOnce non dovrebbe mai lanciare: difesa in profondità.
      console.error(`[stubwise-worker] monitor-alerts: tick fallito: ${errText(err)}`);
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => {
    void tickOnce();
  }, opts.intervalMinutes * 60_000);
  if (typeof timer.unref === "function") timer.unref();

  const stop = (): void => clearInterval(timer);
  opts.signal.addEventListener("abort", stop, { once: true });
  return stop;
}
