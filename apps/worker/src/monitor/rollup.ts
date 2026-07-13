import { checkSamples, checkSamplesRollup, serverMetrics, serverMetricsRollup, type Db } from "@stubwise/db";
import { lt, sql } from "drizzle-orm";

/**
 * ROLLUP + RETENTION delle metriche di monitoraggio.
 *
 * Politica dati (design monitor): i campioni fini (server_metrics,
 * check_samples) si tengono 48 ore; oltre, vengono aggregati in bucket da 5
 * minuti nelle tabelle *_rollup, tenute 90 giorni. Gli indici solo-ts sulle
 * quattro tabelle esistono apposta per i predicati `ts < cutoff` qui sotto.
 */

const FINE_RETENTION_MS = 48 * 60 * 60_000; // 48h di campioni fini
const ROLLUP_RETENTION_MS = 90 * 24 * 60 * 60_000; // 90 giorni di rollup
const BUCKET_SECONDS = 300; // bucket da 5 minuti

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Un giro di rollup + retention. Cutoff derivati da `now` (iniettabile nei
 * test). Tutto in UNA transazione: l'INSERT…SELECT dell'aggregato e il DELETE
 * dei fini committano insieme, così un errore in qualsiasi punto fa rollback
 * e non si perde MAI un campione non ancora aggregato.
 *
 * Idempotente: i bucket sono upsert `on conflict do nothing` sulla unique
 * (server_id|check_id, ts) — un bucket già scritto non viene né duplicato né
 * riscritto (un campione arrivato in ritardo su un bucket già aggregato viene
 * scartato con il DELETE: accettabile, l'ingest è quasi-realtime).
 */
export async function rollupMonitorOnce(db: Db, now: Date = new Date()): Promise<void> {
  // Cutoff fine ALLINEATO al confine di bucket (floor): si aggregano/cancellano
  // solo bucket COMPLETI. Con il cutoff grezzo il bucket a cavallo delle 48h
  // verrebbe aggregato in modo parziale al primo run e i campioni rimanenti
  // cancellati al run successivo senza contribuire (on conflict do nothing) →
  // avg/max distorti e somme/conteggi sottostimati. Il costo è tenere i fini
  // fino a 48h + max 5 minuti: irrilevante.
  const bucketMs = BUCKET_SECONDS * 1000;
  const fineCutoff = new Date(Math.floor((now.getTime() - FINE_RETENTION_MS) / bucketMs) * bucketMs);
  const rollupCutoff = new Date(now.getTime() - ROLLUP_RETENTION_MS);

  await db.transaction(async (tx) => {
    // Metriche host → server_metrics_rollup. Cast espliciti: avg() su real dà
    // double precision (→ ::real), avg()/sum() su bigint danno numeric
    // (→ ::bigint, arrotondamento di Postgres al più vicino: per byte medi la
    // differenza di ±1 è irrilevante). mem/disk_total = MAX del bucket (un
    // resize a metà bucket mostra il totale più recente/grande).
    await tx.execute(sql`
      insert into server_metrics_rollup
        (server_id, ts, cpu_pct_avg, cpu_pct_max, load_1m_avg, load_1m_max,
         mem_used_bytes_avg, mem_used_bytes_max, mem_total_bytes,
         disk_used_bytes_avg, disk_used_bytes_max, disk_total_bytes,
         net_rx_bytes_sum, net_tx_bytes_sum)
      select server_id,
             to_timestamp(floor(extract(epoch from ts) / ${BUCKET_SECONDS}) * ${BUCKET_SECONDS}) as bucket,
             avg(cpu_pct)::real, max(cpu_pct),
             avg(load_1m)::real, max(load_1m),
             avg(mem_used_bytes)::bigint, max(mem_used_bytes),
             max(mem_total_bytes),
             avg(disk_used_bytes)::bigint, max(disk_used_bytes),
             max(disk_total_bytes),
             sum(net_rx_bytes)::bigint, sum(net_tx_bytes)::bigint
      from server_metrics
      where ts < ${fineCutoff.toISOString()}::timestamptz
      group by server_id, bucket
      on conflict (server_id, ts) do nothing
    `);
    await tx.delete(serverMetrics).where(lt(serverMetrics.ts, fineCutoff));

    // Esiti dei check → check_samples_rollup. `unknown` non conta né come up
    // né come down (è "non so", non un esito); le latenze aggregano solo i
    // non-null (un bucket di soli null resta null, la colonna è nullable).
    await tx.execute(sql`
      insert into check_samples_rollup
        (check_id, ts, up_count, down_count, latency_ms_avg, latency_ms_max)
      select check_id,
             to_timestamp(floor(extract(epoch from ts) / ${BUCKET_SECONDS}) * ${BUCKET_SECONDS}) as bucket,
             (count(*) filter (where status = 'up'))::int,
             (count(*) filter (where status = 'down'))::int,
             (avg(latency_ms) filter (where latency_ms is not null))::real,
             (max(latency_ms) filter (where latency_ms is not null))::int
      from check_samples
      where ts < ${fineCutoff.toISOString()}::timestamptz
      group by check_id, bucket
      on conflict (check_id, ts) do nothing
    `);
    await tx.delete(checkSamples).where(lt(checkSamples.ts, fineCutoff));

    // Retention dei rollup: oltre i 90 giorni si butta e basta.
    await tx.delete(serverMetricsRollup).where(lt(serverMetricsRollup.ts, rollupCutoff));
    await tx.delete(checkSamplesRollup).where(lt(checkSamplesRollup.ts, rollupCutoff));
  });
}

export interface StartMonitorRollupPollerOptions {
  db: Db;
  /** Intervallo di poll in minuti. ≤ 0 = disabilitato (non avvia nulla). */
  intervalMinutes: number;
  signal: AbortSignal;
}

/**
 * Avvia il rollup su un proprio setInterval, separato dal loop dei job
 * (pattern startLimitResumePoller). Ad ogni tick esegue rollupMonitorOnce; gli
 * errori vengono loggati e MAI propagati. Lo stop avviene sull'AbortSignal del
 * worker. Ritorna una funzione di stop idempotente. intervalMinutes ≤ 0 =
 * disabilitato.
 */
export function startMonitorRollupPoller(opts: StartMonitorRollupPollerOptions): () => void {
  if (opts.intervalMinutes <= 0) {
    return () => {};
  }
  let running = false;

  const tickOnce = async (): Promise<void> => {
    // Evita sovrapposizioni se un giro è più lento dell'intervallo.
    if (running) return;
    running = true;
    try {
      await rollupMonitorOnce(opts.db);
    } catch (err) {
      // La transazione ha fatto rollback: nessun dato perso, si ritenta al
      // prossimo tick. Mai propagare.
      console.error(`[stubwise-worker] monitor-rollup: tick fallito: ${errText(err)}`);
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => {
    void tickOnce();
  }, opts.intervalMinutes * 60_000);
  // Non tenere vivo il processo solo per il poller.
  if (typeof timer.unref === "function") timer.unref();

  const stop = (): void => clearInterval(timer);
  opts.signal.addEventListener("abort", stop, { once: true });
  return stop;
}
