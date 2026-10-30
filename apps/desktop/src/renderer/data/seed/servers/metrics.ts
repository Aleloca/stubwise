import type { CheckSample, MetricPoint, ServerCheck } from "../../types";
import { TODAY } from "../dates";
import { SERVER_EPISODES, SRV1_MEMORY_EPISODE } from "./episodes";
import { SERVERS, SERVER_CHECKS } from "./servers";

// Le metriche del seme: 90 giorni di campioni per server (28 128: 30 s negli ultimi 7 giorni,
// 15 minuti prima), e i campioni dei controlli (7 giorni) ogni `intervalSeconds` con la latenza
// (R-L1, il grafico «Response time»). Deterministiche: un generatore con
// seme per serie, nessuna casualità vera. Le serie raccontano gli episodi:
// il picco di memoria di SRV-1, il disco di SRV-2 che si riempie, il
// silenzio dell'agente di SRV-3, la replica di SRV-2 giù.
//
// I punti sono congelati: lo stato li condivide fra un ripristino e l'altro
// e copia solo gli array (`freshState`).

// Area 9b: i grafici arrivano a 90 giorni. Gli ultimi `METRIC_FINE_DAYS`
// restano a passo di 30 s (come l'agente li manda), prima il passo è largo
// (`METRIC_COARSE_STEP_SECONDS`): 90 giorni a 30 s sarebbero 259 200 punti per
// server, e a un grafico da 300 punti ne basta uno ogni quarto d'ora.
export const METRIC_STEP_SECONDS = 30;
export const METRIC_COARSE_STEP_SECONDS = 900;
/** Quanto indietro arrivano le serie del seme. */
export const METRIC_DAYS = 90;
/** Quanto indietro, da adesso, il passo è quello fine (e arrivano i campioni dei controlli). */
export const METRIC_FINE_DAYS = 7;

const NOW_MS = Date.parse(`${TODAY}T12:00:00Z`);
const FINE_POINTS = (METRIC_FINE_DAYS * 86_400) / METRIC_STEP_SECONDS;
const COARSE_POINTS = ((METRIC_DAYS - METRIC_FINE_DAYS) * 86_400) / METRIC_COARSE_STEP_SECONDS;
const FINE_START_MS = NOW_MS - (FINE_POINTS - 1) * METRIC_STEP_SECONDS * 1000;

/** Gli istanti delle serie, dal più vecchio: prima il passo largo, poi quello fine fino ad adesso. */
function metricTimes(): { t: number; stepSeconds: number }[] {
  const times: { t: number; stepSeconds: number }[] = [];
  for (let k = COARSE_POINTS; k >= 1; k--)
    times.push({
      t: FINE_START_MS - k * METRIC_COARSE_STEP_SECONDS * 1000,
      stepSeconds: METRIC_COARSE_STEP_SECONDS,
    });
  for (let i = 0; i < FINE_POINTS; i++)
    times.push({
      t: FINE_START_MS + i * METRIC_STEP_SECONDS * 1000,
      stepSeconds: METRIC_STEP_SECONDS,
    });
  return times;
}

/** Un intero a 32 bit da una stringa (FNV-1a): il seme di una serie. */
export function hashOf(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Un generatore deterministico (mulberry32) in [0, 1). */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const ms = (iso: string) => Date.parse(iso);
const iso = (t: number) => new Date(t).toISOString().replace(".000Z", "Z");
const clamp = (v: number) => Math.min(100, Math.max(0, v));
const round1 = (v: number) => Math.round(v * 10) / 10;

/** Il traffico del giorno: 0 di notte, 1 a metà giornata (UTC). */
function daily(t: number): number {
  const hour = (t / 3_600_000) % 24;
  return Math.max(0, Math.sin(((hour - 6) / 24) * 2 * Math.PI));
}

/** L'agente tace durante un episodio `agent_silent`: nessun campione. */
function silent(code: string, t: number): boolean {
  return SERVER_EPISODES.some(
    (e) =>
      e.serverCode === code &&
      e.reasons.some((r) => r.kind === "agent_silent") &&
      t >= ms(e.startedAt) &&
      t < ms(e.recoveredAt ?? `${TODAY}T23:59:59Z`),
  );
}

interface Profile {
  cpu: number;
  mem: number;
  disk: (t: number) => number;
  net: number;
}

const PROFILES: Record<string, Profile> = {
  "SRV-1": { cpu: 18, mem: 58, disk: () => 51, net: 180_000 },
  // Il disco di SRV-2 cresce dall'84% di una settimana fa al 93% di adesso.
  "SRV-2": {
    cpu: 22,
    mem: 64,
    // (Resta 84% fino a una settimana fa: la crescita è dell'ultima settimana.)
    disk: (t) =>
      84 +
      9 *
        Math.max(
          0,
          (t - (NOW_MS - METRIC_FINE_DAYS * 86_400_000)) / (METRIC_FINE_DAYS * 86_400_000),
        ),
    net: 90_000,
  },
  "SRV-3": { cpu: 26, mem: 47, disk: () => 36, net: 240_000 },
  "SRV-4": { cpu: 7, mem: 33, disk: () => 24, net: 30_000 },
};

/**
 * La memoria di SRV-1 intorno all'episodio: sale nei 40 minuti prima (fino
 * all'89%, sotto la soglia), resta sopra il 90% per tutto l'episodio con il
 * picco del 94%, e torna giù nei 20 minuti dopo il rientro.
 */
function srv1Memory(t: number, base: number): number {
  const start = ms(SRV1_MEMORY_EPISODE.startedAt);
  const end = ms(SRV1_MEMORY_EPISODE.recoveredAt!);
  const ramp = 40 * 60_000;
  const fall = 20 * 60_000;
  if (t >= start - ramp && t < start) return base + (89 - base) * ((t - (start - ramp)) / ramp);
  if (t >= start && t < end) {
    const x = (t - start) / (end - start);
    return 91 + 3 * Math.sin(Math.PI * Math.min(1, x * 1.6));
  }
  if (t >= end && t < end + fall) return 72 - (72 - base) * ((t - end) / fall);
  return base;
}

/**
 * Quanto lavora un giorno rispetto a un altro: un fattore fra 0,75 e 1,25
 * per giorno (UTC), dal seme della serie. Senza, a 30d e 90d ogni giorno è
 * la copia del precedente e la serie si legge come generata (Impeccable 4).
 */
function dayFactor(code: string, t: number): number {
  const day = Math.floor(t / 86_400_000);
  return 0.75 + 0.5 * seededRandom(hashOf(`day|${code}|${day}`))();
}

/**
 * Una deriva lenta, non periodica: una passeggiata che torna verso lo zero
 * (Ornstein-Uhlenbeck a passi), in punti percentuali. Il passo conta: a 15
 * minuti si muove più che a 30 secondi, così la deriva ha lo stesso ritmo
 * nelle due parti della serie.
 */
function drift(rnd: () => number, size: number): (stepSeconds: number) => number {
  let value = 0;
  return (stepSeconds) => {
    const k = Math.sqrt(stepSeconds / 900);
    value += (rnd() - 0.5) * size * k - value * 0.003 * k * k;
    return value;
  };
}

/** I campioni di un server, sempre gli stessi. */
export function metricsOf(code: string): MetricPoint[] {
  const p = PROFILES[code]!;
  const rnd = seededRandom(hashOf(`metrics|${code}`));
  // Un generatore a parte per derive e giorni: il rumore di sempre resta uguale.
  const walk = seededRandom(hashOf(`drift|${code}`));
  const cpuDrift = drift(walk, 0.8);
  const memDrift = drift(walk, 0.6);
  const points: MetricPoint[] = [];
  for (const { t, stepSeconds } of metricTimes()) {
    const d = daily(t) * dayFactor(code, t);
    const noise = () => rnd() - 0.5;
    const cpu = clamp(p.cpu * (0.6 + 0.8 * d) + 6 * noise() + cpuDrift(stepSeconds));
    let mem = clamp(p.mem + 4 * d + 3 * noise() + memDrift(stepSeconds));
    if (code === "SRV-1") mem = clamp(srv1Memory(t, mem));
    const disk = clamp(p.disk(t) + 0.1 * noise());
    const net = p.net * stepSeconds * (0.3 + 1.4 * d) * (1 + 0.4 * noise());
    if (silent(code, t)) continue;
    points.push(
      Object.freeze({
        ts: iso(t),
        cpuPct: round1(cpu),
        memPct: round1(mem),
        diskPct: round1(disk),
        load1m: round1(Math.max(0, (cpu / 25) * (1 + 0.3 * noise()))),
        netRxBytes: Math.round(Math.max(0, net)),
        netTxBytes: Math.round(Math.max(0, net * 0.35)),
      }),
    );
  }
  return points;
}

/** Da quando un controllo è giù: l'inizio dell'episodio che lo nomina. */
function downSince(check: ServerCheck): number | null {
  if (check.status !== "down") return null;
  const ep = SERVER_EPISODES.find((e) =>
    e.reasons.some((r) => r.kind === "check" && r.checkId === check.id),
  );
  return ep ? ms(ep.startedAt) : null;
}

const BASE_LATENCY: Record<ServerCheck["type"], number | null> = {
  http: 130,
  tcp: 2,
  postgres: 5,
  mysql: 5,
  process: null,
};

/**
 * I campioni di un controllo, sempre gli stessi; l'ultimo è lo stato e la
 * latenza del controllo. Un processo non ha latenza; un controllo giù
 * nemmeno. Durante l'episodio di memoria di SRV-1 la sua API rallenta.
 */
export function checkSamplesOf(checkId: string): CheckSample[] {
  const check = SERVER_CHECKS.find((c) => c.id === checkId)!;
  const rnd = seededRandom(hashOf(`check|${checkId}`));
  const step = check.intervalSeconds * 1000;
  // I campioni dei controlli restano a 7 giorni: a 90 sarebbero centinaia di migliaia.
  const count = Math.floor((METRIC_FINE_DAYS * 86_400_000) / step);
  const since = downSince(check);
  const base = BASE_LATENCY[check.type];
  const slowFrom = ms(SRV1_MEMORY_EPISODE.startedAt);
  const slowTo = ms(SRV1_MEMORY_EPISODE.recoveredAt!);
  const samples: CheckSample[] = [];
  for (let i = 0; i < count; i++) {
    const t = NOW_MS - (count - 1 - i) * step;
    const jitter = 0.75 + 0.5 * rnd();
    if (silent(check.serverCode, t)) continue;
    const down = since !== null && t >= since;
    const slow = check.serverCode === "SRV-1" && t >= slowFrom && t < slowTo ? 4 : 1;
    const latency = down || base === null ? null : Math.max(1, Math.round(base * jitter * slow));
    samples.push(Object.freeze({ ts: iso(t), status: down ? "down" : "up", latencyMs: latency }));
  }
  // L'ultimo campione è quello che il controllo mostra.
  const last = samples.at(-1)!;
  samples[samples.length - 1] = Object.freeze({ ...last, latencyMs: check.latencyMs });
  return samples;
}

/** Le serie del seme, per codice del server. */
export const SERVER_METRICS: ReadonlyMap<string, readonly MetricPoint[]> = new Map(
  SERVERS.map((s) => [s.code, metricsOf(s.code)]),
);

/** I campioni dei controlli del seme, per id del controllo. */
export const CHECK_SAMPLES: ReadonlyMap<string, readonly CheckSample[]> = new Map(
  SERVER_CHECKS.map((c) => [c.id, checkSamplesOf(c.id)]),
);
