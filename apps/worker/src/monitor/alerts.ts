import { serverAppUrl } from "@stubwise/notifications";
import { environmentServers, projectEnvironments, serverEpisodes, serverMetrics, servers, serviceChecks, type Db } from "@stubwise/db";
import {
  publishNotification,
  type MonitorCondition,
  type NotificationEvent,
  type PublishOpts,
} from "@stubwise/notifications";
import {
  alertThresholdsSchema,
  computeServerStatus,
  type AlertThresholds,
} from "@stubwise/shared";
import { and, desc, eq, gte, isNotNull, isNull } from "drizzle-orm";

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
 * sono best-effort: una publish che lancia viene inghiottita.
 *
 * ANCORE degli eventi `monitor.*`: non c'è né ticket né job dietro un alert. Un
 * server può essere usato dagli ambienti di più progetti (area 8, F4a: i
 * progetti di un server sono quelli dei suoi AMBIENTI, `server_projects` non
 * conta più): si passa `projectId` solo quando il legame è NON AMBIGUO
 * (esattamente un progetto), altrimenti nessuna ancora.
 *
 * EPISODI (area 8, F4a): a fine giro di un server lo stato degli allarmi
 * (`activeAlerts` più i check notificati giù) si riflette in
 * `server_episodes`: uno aperto finché c'è almeno un allarme, coi motivi e la
 * gravità (`down` se offline), chiuso quando tutto è rientrato. Si DERIVA
 * dallo stato a ogni giro: un giro ripetuto o un worker riavviato non lo
 * duplicano (e l'indice unico sull'aperto lo garantisce). Il pubblico non cambia comunque — i
 * `monitor.*` sono admin-only — cambia solo il progetto a cui la notifica
 * risulta agganciata.
 */

/** Firma della publish iniettabile (default: publishNotification). */
export type PublishFn = typeof publishNotification;

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
async function safePublish(
  publish: PublishFn,
  db: Db,
  event: NotificationEvent,
  opts: PublishOpts,
): Promise<void> {
  try {
    await publish(db, event, opts);
  } catch {
    // Best-effort: la notifica non deve mai far fallire la valutazione.
  }
}

/**
 * Ancore dell'evento per un server: il progetto collegato SE ne esiste
 * esattamente uno (vedi docblock del modulo). Il risultato è memoizzato dal
 * chiamante per server, così un giro senza alert non paga la query.
 */
async function serverRefs(db: Db, serverId: string): Promise<PublishOpts> {
  try {
    const rows = await db
      .selectDistinct({ projectId: projectEnvironments.projectId })
      .from(environmentServers)
      .innerJoin(projectEnvironments, eq(projectEnvironments.id, environmentServers.environmentId))
      .where(eq(environmentServers.serverId, serverId))
      .limit(2);
    return rows.length === 1 ? { projectId: rows[0]!.projectId } : {};
  } catch {
    // Best-effort come tutto il resto della notifica: senza ancora si pubblica
    // lo stesso (gli admin la vedono comunque).
    return {};
  }
}

/** Memoizza `serverRefs`: UNA query per server, e solo se serve davvero. */
function lazyServerRefs(db: Db, serverId: string): () => Promise<PublishOpts> {
  let pending: Promise<PublishOpts> | undefined;
  return () => (pending ??= serverRefs(db, serverId));
}

export interface EvaluateMonitorAlertsDeps {
  db: Db;
  /** Publish iniettabile nei test. Default: publishNotification. */
  publish?: PublishFn;
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
  const publish = deps.publish ?? publishNotification;
  const base = deps.publicUrl.replace(/\/+$/, "");

  let allServers: (typeof servers.$inferSelect)[];
  try {
    allServers = await db.select().from(servers);
  } catch (err) {
    console.error(`[stubwise-worker] monitor-alerts: lettura server fallita: ${errText(err)}`);
    return;
  }

  for (const server of allServers) {
    // Ritiro del web vecchio: la pagina del server nella nuova app (`app-links`),
    // nel progetto se il legame è univoco. Pigra: un giro senza avvisi non la
    // compone, e i ricevitori leggono il server da `serverId`, non dall'URL.
    let urlOnce: Promise<string> | undefined;
    const url = () => (urlOnce ??= refs().then((r) => serverAppUrl(db, base, server.id, r.projectId ?? null)));
    // Ancore risolte al massimo UNA volta per server (e solo se si notifica).
    const refs = lazyServerRefs(db, server.id);
    // Stato host (offline + soglie): isolato dai check, isolato dagli altri server.
    try {
      await evaluateServerStatus(db, publish, refs, server, url, now);
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
          await evaluateCheck(db, publish, refs, server.name, server.id, check, url, now);
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
    // Episodio (area 8, F4a): dallo stato degli allarmi DOPO questo giro.
    try {
      await syncEpisode(db, server.id, now);
    } catch (err) {
      console.error(`[stubwise-worker] monitor-alerts: episodio del server ${server.id} fallito: ${errText(err)}`);
    }
  }
}

type EpisodeReason = { kind: string; valuePct?: number; thresholdPct?: number; checkId?: string; since?: string };

/**
 * Riflette lo stato degli allarmi del server in `server_episodes` (vedi il
 * docblock del modulo): apre, aggiorna (motivi e gravità) o chiude l'episodio.
 */
async function syncEpisode(db: Db, serverId: string, now: Date): Promise<void> {
  const [server] = await db.select().from(servers).where(eq(servers.id, serverId));
  if (!server) return;
  const thresholds = parseThresholds(server.alertThresholds);
  const reasons: EpisodeReason[] = [];
  const active = server.activeAlerts ?? {};
  if (active.offline) reasons.push({ kind: "agent_silent", since: server.lastSeenAt?.toISOString() ?? active.offline.since });
  const metric: Record<ThresholdKey, ["cpu" | "memory" | "disk", number | null]> = {
    cpu: ["cpu", thresholds.cpuPct],
    mem: ["memory", thresholds.memPct],
    disk: ["disk", thresholds.diskPct],
  };
  // Il valore dell'ultimo campione (review F4a: senza, l'app mostrava «CPU al NaN%»).
  const [last] = await db.select().from(serverMetrics).where(eq(serverMetrics.serverId, serverId)).orderBy(desc(serverMetrics.ts)).limit(1);
  const share = (used: number, total: number) => (total > 0 ? Math.round((used / total) * 1000) / 10 : undefined);
  const lastValue: Record<ThresholdKey, number | undefined> = {
    cpu: last ? Math.round(last.cpuPct * 10) / 10 : undefined,
    mem: last ? share(last.memUsedBytes, last.memTotalBytes) : undefined,
    disk: last ? share(last.diskUsedBytes, last.diskTotalBytes) : undefined,
  };
  for (const key of ["cpu", "mem", "disk"] as const) {
    if (!active[key]) continue;
    const [kind, threshold] = metric[key];
    const value = lastValue[key];
    reasons.push({ kind, ...(value !== undefined ? { valuePct: value } : {}), ...(threshold !== null ? { thresholdPct: threshold } : {}), since: active[key].since });
  }
  // I check notificati giù (lo scrive solo questo evaluator, `evaluateCheck`).
  const notified = await db
    .select({ id: serviceChecks.id, downSince: serviceChecks.downSince, downNotifiedAt: serviceChecks.downNotifiedAt })
    .from(serviceChecks)
    .where(and(eq(serviceChecks.serverId, serverId), eq(serviceChecks.enabled, true), isNotNull(serviceChecks.downNotifiedAt)));
  for (const c of notified) reasons.push({ kind: "check", checkId: c.id, since: (c.downSince ?? c.downNotifiedAt!).toISOString() });

  const [open] = await db
    .select()
    .from(serverEpisodes)
    .where(and(eq(serverEpisodes.serverId, serverId), isNull(serverEpisodes.recoveredAt)));
  if (reasons.length === 0) {
    if (open) await db.update(serverEpisodes).set({ recoveredAt: now }).where(eq(serverEpisodes.id, open.id));
    return;
  }
  // La gravità dice com'è ADESSO (review F4a): `down` finché l'agente tace,
  // `trouble` quando risponde di nuovo ma qualcosa resta in allarme.
  const severity = active.offline ? "down" : "trouble";
  if (!open) {
    // L'episodio parte da quando è cominciato il problema (l'ultimo segnale,
    // il primo superamento, il controllo giù), non dall'ora del giro: al primo
    // giro dopo un deploy un server in allarme da ore non «comincia adesso».
    const starts = reasons.map((r) => r.since).filter((x): x is string => typeof x === "string" && !Number.isNaN(Date.parse(x)));
    const startedAt = starts.length > 0 ? new Date(Math.min(...starts.map((x) => Date.parse(x)))) : now;
    await db.insert(serverEpisodes).values({ serverId, severity, reasons, startedAt }).onConflictDoNothing();
    return;
  }
  // Un allarme in più si AGGIUNGE ai motivi (quelli rientrati restano: è la
  // storia dell'episodio).
  const key = (r: EpisodeReason) => `${r.kind}:${r.checkId ?? ""}`;
  // Un motivo ancora attivo prende l'ultimo valore letto (additivo: `since` resta il suo).
  const merged = open.reasons.map((m) => {
    const current = reasons.find((r) => key(r) === key(m));
    return current?.valuePct !== undefined ? { ...m, valuePct: current.valuePct } : m;
  });
  for (const r of reasons) if (!merged.some((m) => key(m) === key(r))) merged.push(r);
  const nextSeverity = severity;
  if (JSON.stringify(merged) !== JSON.stringify(open.reasons) || nextSeverity !== open.severity) {
    await db.update(serverEpisodes).set({ reasons: merged, severity: nextSeverity }).where(eq(serverEpisodes.id, open.id));
  }
}

/** Valuta offline + soglie sostenute per un server, aggiornando `activeAlerts`. */
async function evaluateServerStatus(
  db: Db,
  publish: PublishFn,
  refs: () => Promise<PublishOpts>,
  server: typeof servers.$inferSelect,
  url: () => Promise<string>,
  now: Date,
): Promise<void> {
  const nowIso = now.toISOString();
  // Copia mutabile dello stato anti-spam; a fine giro si riscrive se cambiato.
  const active: Record<string, { since: string; notifiedAt: string | null }> = {
    ...(server.activeAlerts ?? {}),
  };
  const pending: Omit<Extract<NotificationEvent, { kind: "monitor.alert" | "monitor.recovered" }>, "url">[] = [];
  let changed = false;

  /** Entra in allarme (una volta sola) o resta silente (anti-spam). */
  const enter = (key: string, condition: MonitorCondition, detail: string): void => {
    // Chiave presente = già notificato: questo evaluator (unico scrittore di
    // activeAlerts) scrive SEMPRE since e notifiedAt insieme, quindi non
    // esiste lo stato "attivo ma non notificato" (notifiedAt null resta nel
    // tipo jsonb solo come possibilità futura).
    if (active[key]) return;
    active[key] = { since: nowIso, notifiedAt: nowIso };
    changed = true;
    pending.push({ kind: "monitor.alert", serverName: server.name, serverId: server.id, condition, detail });
  };
  /** Esce dall'allarme (recovered) se una chiave era attiva. */
  const exit = (key: string, condition: MonitorCondition, detail: string): void => {
    if (!active[key]) return;
    delete active[key];
    changed = true;
    pending.push({ kind: "monitor.recovered", serverName: server.name, serverId: server.id, condition, detail });
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
      // Soglia null = condizione disattivata: non allarma e non risolve. Una
      // chiave attiva lasciata da quando la soglia era abilitata va però
      // rimossa SILENZIOSAMENTE (nessun recovered: disattivare una soglia non
      // è un rientro), altrimenti resta orfana per sempre e il suo anti-spam
      // sopprimerebbe la ri-notifica alla riabilitazione.
      if (cond.threshold === null) {
        if (active[cond.key]) {
          delete active[cond.key];
          changed = true;
        }
        continue;
      }
      const threshold = cond.threshold;
      const enough = window.length > 0 && window.length >= minSamples;
      // NOTA: confronto STRICT (>): con soglia 100 la condizione non scatta mai
      // (cpuPct è clampato a 100 dallo schema di ingest). Vale anche per la UI
      // (E4): una soglia a 100 equivale di fatto a disattivare l'alert.
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
      } else if (enough) {
        // Si esce SOLO con evidenza (stesso principio dell'offline): con
        // campioni radi (enough=false) non sappiamo se la condizione è
        // rientrata — un recovered per pura assenza di dati sarebbe spurio e
        // farebbe flapping alla riconnessione. La chiave resta.
        exit(cond.key, cond.key, `${cond.label} rientrata sotto la soglia (${threshold}%)`);
      }
    }
  }

  // Persisti lo stato anti-spam PRIMA di notificare: l'anti-spam deve riflettere
  // realtà committata (una notifica persa è meglio di un doppio alert).
  if (changed) {
    await db.update(servers).set({ activeAlerts: active }).where(eq(servers.id, server.id));
  }
  if (pending.length > 0) {
    const opts = await refs();
    const link = await url();
    for (const event of pending) {
      await safePublish(publish, db, { ...event, url: link } as NotificationEvent, opts);
    }
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
 *
 * SCELTA DELIBERATA: un check DISABILITATO mentre era down+notificato non
 * genera recovered finché resta disabilitato (lastStatus rimane "down": nessuna
 * evidenza di risalita). Alla riabilitazione, il primo esito up dell'agente
 * farà scattare il recovered; se invece torna down, l'anti-spam (downNotifiedAt
 * ancora valorizzato) evita un secondo alert.
 */
async function evaluateCheck(
  db: Db,
  publish: PublishFn,
  refs: () => Promise<PublishOpts>,
  serverName: string,
  serverId: string,
  check: typeof serviceChecks.$inferSelect,
  url: () => Promise<string>,
  now: Date,
): Promise<void> {
  if (check.enabled && check.lastStatus === "down" && check.downNotifiedAt === null) {
    await db.update(serviceChecks).set({ downNotifiedAt: now }).where(eq(serviceChecks.id, check.id));
    const detail = check.lastError
      ? `Check "${check.name}" non raggiungibile: ${check.lastError}`
      : `Check "${check.name}" non raggiungibile`;
    await safePublish(
      publish,
      db,
      { kind: "monitor.alert", serverName, serverId, condition: "check_down", detail, url: await url() },
      await refs(),
    );
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
    await safePublish(
      publish,
      db,
      {
        kind: "monitor.recovered",
        serverName,
        condition: "check_down",
        serverId,
        detail: `Check "${check.name}" di nuovo raggiungibile`,
        url: await url(),
      },
      await refs(),
    );
  }
}

export interface StartMonitorAlertPollerOptions {
  db: Db;
  publish?: PublishFn;
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
        publish: opts.publish,
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
