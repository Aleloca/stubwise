import { liveSectionHolds, productPages, productSectionHolds, releaseSections, takeSection, users, type Db } from "@stubwise/db";
import { instancePermissionsOfUser, projectPermissionsByProject } from "@stubwise/notifications";
import type { ProductCursor, ProductPresence, ProductSectionHold } from "@stubwise/shared";
import { and, eq, inArray, ne } from "drizzle-orm";
import { readsDocs } from "../auth/access.js";
import { personName } from "./people.js";
import { visiblePersonIds } from "./people-visibility.js";
import { PRODUCT_HOLD_TTL_MS } from "./product-live-notify.js";
import type { ProductRevisionEvent } from "./product-live-notify.js";

export type { ProductRevisionEvent };

/**
 * Area 11, F4 — la scrittura dal vivo: il canale delle pagine di prodotto,
 * nella memoria del processo server (un solo processo oggi, dietro caddy: la
 * voce del deploy-log lo dice).
 *
 * - Presenza e cursori stanno QUI, con scadenza (15 s, il battito è ogni 5 s),
 *   per persona E sessione (una scheda), mai in tabella. Le prese delle sezioni
 *   stanno in tabella (`product_section_holds`), perché le vede anche il
 *   worker (F5); qui se ne tiene l'ultima vista per mandare `hold`/`release`.
 * - Le revisioni arrivano in due modi, una volta sola (per `seq`): dalla rotta,
 *   dopo il commit, con le operazioni; e dalla NOTIFY `product_page_events`
 *   (scritta dentro la transazione), per le scritture di un altro processo,
 *   senza operazioni: il client rilegge la pagina.
 * - I permessi di chi guarda (e che la pagina ci sia ancora) si rileggono a
 *   ogni evento, con una validità di pochi secondi, e da un giro a tempo: un
 *   accesso tolto manda `gone` e chiude lo stream.
 * - Nessun nome di una persona che chi guarda non vede (R-G5).
 * - Review di F4: tutto ciò che si manda agli stream di una pagina passa da UNA
 *   coda per pagina (i frame in ordine, le prese senza sfarfallii); il posto di
 *   uno stream nei tetti si prende PRIMA di ogni attesa; lo stato di una pagina
 *   (seq visto, prese viste) c'è solo finché qualcuno la guarda.
 */

export const PRODUCT_PRESENCE_TTL_MS = 15_000;
export const PRODUCT_LIVE_PERMS_TTL_MS = 5_000;
export const PRODUCT_LIVE_STREAMS_PER_PAGE = 50;
export const PRODUCT_LIVE_STREAMS_PER_PERSON = 10;
/** Quanto si aspetta una NOTIFY prima di consegnarla: la rotta dello stesso processo arriva prima, con le operazioni. */
const NOTIFY_GRACE_MS = 200;

type Frame = Record<string, unknown> & { type: string };

interface Subscriber {
  pageId: string;
  projectId: string;
  userId: string;
  send: (frame: Frame) => void;
  close: () => void;
  checkedAt: number;
  /** Le persone che vede (R-G5), riletto insieme ai permessi. */
  people: "all" | ReadonlySet<string>;
  /** Pronto: ha ricevuto `state` (prima no, gli eventi aspettano). */
  ready: boolean;
}

interface Presence {
  userId: string;
  cursor: ProductCursor | null;
  sectionId: string | null;
  expiresAt: number;
}

export class ProductLiveError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const presenceKey = (userId: string, sessionId: string | null | undefined) => `${userId}\u0000${sessionId ?? ""}`;

export class ProductLiveHub {
  private readonly subs = new Map<string, Set<Subscriber>>();
  /** Per pagina: persona+sessione → presenza. */
  private readonly presence = new Map<string, Map<string, Presence>>();
  /** Solo per le pagine con almeno uno stream (review di F4, M8). */
  private readonly lastSeq = new Map<string, number>();
  private readonly lastHolds = new Map<string, Map<string, { userId: string; expiresAt: Date }>>();
  /** Una coda per pagina (M1). */
  private readonly chains = new Map<string, Promise<void>>();
  private readonly timer: NodeJS.Timeout;
  private readonly permsTtlMs: number;
  private readonly presenceTtlMs: number;
  private sweeping = false;

  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now,
    private readonly log: { warn: (obj: unknown, msg?: string) => void } = { warn: () => undefined },
    /** Solo i test li accorciano; in produzione 5 s e 15 s. */
    opts: { permsTtlMs?: number; presenceTtlMs?: number } = {},
  ) {
    this.permsTtlMs = opts.permsTtlMs ?? PRODUCT_LIVE_PERMS_TTL_MS;
    this.presenceTtlMs = opts.presenceTtlMs ?? PRODUCT_PRESENCE_TTL_MS;
    // Il giro a tempo: permessi scaduti, presenze scadute, prese cambiate (anche dal worker).
    this.timer = setInterval(() => void this.sweep(), this.permsTtlMs);
    this.timer.unref();
  }

  stop(): void {
    clearInterval(this.timer);
    for (const set of this.subs.values()) for (const s of set) s.close();
    this.subs.clear();
  }

  /** Quanti stream aperti (per i test e i tetti). */
  count(pageId?: string): number {
    if (pageId) return this.subs.get(pageId)?.size ?? 0;
    return [...this.subs.values()].reduce((n, s) => n + s.size, 0);
  }

  /** Il lavoro di una pagina, in fila dietro al precedente (un errore non ferma la coda). */
  private serial(pageId: string, fn: () => Promise<void>): Promise<void> {
    const next = (this.chains.get(pageId) ?? Promise.resolve()).then(fn).catch((error: unknown) => this.log.warn({ err: error, pageId }, "canale dal vivo: lavoro della pagina non riuscito"));
    this.chains.set(pageId, next);
    void next.then(() => {
      if (this.chains.get(pageId) === next) this.chains.delete(pageId);
    });
    return next;
  }

  // --- i permessi ----------------------------------------------------------------

  /**
   * Chi guarda legge ancora i Docs del progetto, la pagina c'è ancora (review di
   * F4, I6: un full admin ha i permessi anche su un progetto eliminato), e le
   * persone che vede; con una validità di `permsTtlMs`.
   */
  private async allowed(sub: Subscriber, force = false): Promise<boolean> {
    if (!force && this.now() - sub.checkedAt < this.permsTtlMs) return true;
    const [page] = await this.db.select({ id: productPages.id }).from(productPages).where(eq(productPages.id, sub.pageId));
    if (!page) return false;
    const perms = await projectPermissionsByProject(this.db, sub.userId, [sub.projectId]);
    // Anche il modulo Docs (revisione del lotto 1): spento a pagina aperta, lo stream si chiude al prossimo controllo.
    if (!(await readsDocs(this.db, sub.projectId, perms.get(sub.projectId)))) return false;
    const people = await visiblePersonIds(this.db, { id: sub.userId, instancePermissions: await instancePermissionsOfUser(this.db, sub.userId) });
    sub.people = people === "all" ? "all" : new Set(people);
    sub.checkedAt = this.now();
    return true;
  }

  private drop(sub: Subscriber, gone: boolean): void {
    const set = this.subs.get(sub.pageId);
    if (!set?.has(sub)) return;
    set.delete(sub);
    if (set.size === 0) {
      this.subs.delete(sub.pageId);
      this.lastSeq.delete(sub.pageId);
      this.lastHolds.delete(sub.pageId);
    }
    if (gone) {
      try {
        sub.send({ type: "gone" });
      } catch {
        // lo stream è già andato
      }
    }
    sub.close();
  }

  /** Manda a ogni stream PRONTO della pagina il frame che `make` costruisce per lui, dopo aver riletto i permessi. */
  private async broadcast(pageId: string, make: (sub: Subscriber) => Promise<Frame | null> | Frame | null): Promise<void> {
    for (const sub of [...(this.subs.get(pageId) ?? [])]) {
      if (!sub.ready) continue;
      // Review di F4 (M2): un errore di uno stream non toglie il frame agli altri.
      try {
        if (!(await this.allowed(sub))) {
          this.drop(sub, true);
          continue;
        }
        const frame = await make(sub);
        if (frame) sub.send(frame);
      } catch (error) {
        this.log.warn({ err: error, pageId }, "canale dal vivo: frame non mandato a uno stream");
      }
    }
  }

  // --- i nomi --------------------------------------------------------------------

  private async names(ids: readonly string[]): Promise<Map<string, string>> {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return new Map();
    const rows = await this.db.select({ id: users.id, email: users.email, displayName: users.displayName }).from(users).where(inArray(users.id, unique));
    return new Map(rows.map((r) => [r.id, personName(r)]));
  }

  private sees(sub: Subscriber, userId: string): boolean {
    return sub.people === "all" || sub.people.has(userId);
  }

  // --- la presenza ---------------------------------------------------------------

  /** Le presenze vive di una pagina, UNA per persona (la sessione più recente; se una scrive in una sezione, quella). */
  private livePresence(pageId: string): Presence[] {
    const now = this.now();
    const byUser = new Map<string, Presence>();
    for (const p of (this.presence.get(pageId) ?? new Map<string, Presence>()).values()) {
      if (p.expiresAt <= now) continue;
      const seen = byUser.get(p.userId);
      if (!seen || (p.sectionId !== null && seen.sectionId === null) || (Boolean(p.sectionId) === Boolean(seen.sectionId) && p.expiresAt > seen.expiresAt)) byUser.set(p.userId, p);
    }
    return [...byUser.values()];
  }

  /** La presenza come la vede `sub`: gli ALTRI presenti che vede (R-G5). */
  private presenceFor(sub: Subscriber, names: Map<string, string>): ProductPresence[] {
    return this.livePresence(sub.pageId)
      .filter((p) => p.userId !== sub.userId && this.sees(sub, p.userId) && names.has(p.userId))
      .map((p) => ({ userId: p.userId, name: names.get(p.userId)!, cursor: p.cursor, sectionId: p.sectionId }));
  }

  private async broadcastPresence(pageId: string): Promise<void> {
    const names = await this.names(this.livePresence(pageId).map((p) => p.userId));
    await this.broadcast(pageId, (sub) => ({ type: "presence", presence: this.presenceFor(sub, names) }));
  }

  // --- le prese ------------------------------------------------------------------

  private holdFor(sub: Subscriber, sectionId: string, h: { userId: string; expiresAt: Date }, names: Map<string, string>): ProductSectionHold {
    return { sectionId, by: { id: h.userId, name: this.sees(sub, h.userId) ? (names.get(h.userId) ?? null) : null }, expiresAt: h.expiresAt.toISOString() };
  }

  /**
   * Rilegge le prese vive della pagina e manda `hold` per le nuove o cambiate di
   * mano, `release` per le sparite. Il rinnovo della stessa persona non manda
   * niente (M3): `expiresAt` è indicativo, il client non fa scadere le prese da sé.
   */
  private async refreshHoldsNow(pageId: string): Promise<void> {
    if (!this.subs.has(pageId)) return;
    const live = await liveSectionHolds(this.db, pageId, new Date(this.now()));
    const before = this.lastHolds.get(pageId) ?? new Map<string, { userId: string; expiresAt: Date }>();
    const after = new Map(live.map((h) => [h.sectionId, { userId: h.userId, expiresAt: h.expiresAt }]));
    this.lastHolds.set(pageId, after);
    const changed = [...after.entries()].filter(([s, h]) => before.get(s)?.userId !== h.userId);
    const released = [...before.keys()].filter((s) => !after.has(s));
    if (changed.length === 0 && released.length === 0) return;
    const names = await this.names(changed.map(([, h]) => h.userId));
    for (const [sectionId, h] of changed) await this.broadcast(pageId, (sub) => ({ type: "hold", hold: this.holdFor(sub, sectionId, h, names) }));
    for (const sectionId of released) await this.broadcast(pageId, () => ({ type: "release", sectionId }));
  }

  refreshHolds(pageId: string): Promise<void> {
    return this.serial(pageId, () => this.refreshHoldsNow(pageId));
  }

  // --- aprire e chiudere uno stream ---------------------------------------------

  /**
   * Apre lo stream di `userId` sulla pagina (la rotta ha già chiesto
   * `docs.view`): i tetti, il frame `state`, poi gli eventi. Restituisce chi lo
   * chiude. Review di F4 (I2, I3): il posto nei tetti si prende SUBITO, prima di
   * ogni attesa, e si libera se l'apertura fallisce.
   */
  async open(input: { pageId: string; projectId: string; userId: string; seq: number; send: (frame: Frame) => void; close: () => void }): Promise<() => void> {
    if (this.count(input.pageId) >= PRODUCT_LIVE_STREAMS_PER_PAGE) throw new ProductLiveError(429, "too_many_streams", `A page has at most ${PRODUCT_LIVE_STREAMS_PER_PAGE} live streams`);
    const mine = [...this.subs.values()].reduce((n, set) => n + [...set].filter((s) => s.userId === input.userId).length, 0);
    if (mine >= PRODUCT_LIVE_STREAMS_PER_PERSON) throw new ProductLiveError(429, "too_many_streams", `A person has at most ${PRODUCT_LIVE_STREAMS_PER_PERSON} live streams`);
    const sub: Subscriber = { pageId: input.pageId, projectId: input.projectId, userId: input.userId, send: input.send, close: input.close, checkedAt: 0, people: new Set(), ready: false };
    const set = this.subs.get(input.pageId) ?? new Set<Subscriber>();
    set.add(sub);
    this.subs.set(input.pageId, set);
    try {
      if (!(await this.allowed(sub, true))) throw new ProductLiveError(404, "not_found", "Not found");
      await this.serial(input.pageId, async () => {
        if (!set.has(sub)) return;
        const live = await liveSectionHolds(this.db, input.pageId, new Date(this.now()));
        if (!this.lastHolds.has(input.pageId)) this.lastHolds.set(input.pageId, new Map(live.map((h) => [h.sectionId, { userId: h.userId, expiresAt: h.expiresAt }])));
        const names = await this.names([...this.livePresence(input.pageId).map((p) => p.userId), ...live.map((h) => h.userId)]);
        sub.send({
          type: "state",
          seq: Math.max(input.seq, this.lastSeq.get(input.pageId) ?? 0),
          presence: this.presenceFor(sub, names),
          holds: live.map((h) => this.holdFor(sub, h.sectionId, { userId: h.userId, expiresAt: h.expiresAt }, names)),
        });
        sub.ready = true;
      });
      if (!sub.ready) throw new ProductLiveError(404, "not_found", "Not found");
    } catch (error) {
      const now = this.subs.get(input.pageId);
      now?.delete(sub);
      if (now && now.size === 0) this.subs.delete(input.pageId);
      throw error;
    }
    return () => this.drop(sub, false);
  }

  /** Review di F4 (M11): dopo una riconnessione della LISTEN, le NOTIFY perse: a ogni stream uno `state` nuovo (il client confronta il seq e rilegge). */
  async resyncAll(seqOf: (pageId: string) => Promise<number | null>): Promise<void> {
    for (const pageId of [...this.subs.keys()]) {
      const seq = await seqOf(pageId);
      await this.serial(pageId, async () => {
        if (seq === null) {
          for (const sub of [...(this.subs.get(pageId) ?? [])]) this.drop(sub, true);
          return;
        }
        this.lastSeq.set(pageId, Math.max(seq, this.lastSeq.get(pageId) ?? 0));
        const live = await liveSectionHolds(this.db, pageId, new Date(this.now()));
        const names = await this.names([...this.livePresence(pageId).map((p) => p.userId), ...live.map((h) => h.userId)]);
        await this.broadcast(pageId, (sub) => ({
          type: "state",
          seq,
          presence: this.presenceFor(sub, names),
          holds: live.map((h) => this.holdFor(sub, h.sectionId, { userId: h.userId, expiresAt: h.expiresAt }, names)),
        }));
      });
    }
  }

  // --- gli eventi ----------------------------------------------------------------

  /** Una revisione salvata: una volta sola per `seq`. Con le operazioni se le ha (la rotta), senza dalla NOTIFY. */
  revision(event: ProductRevisionEvent): Promise<void> {
    return this.serial(event.pageId, async () => {
      // Nessuno guarda: niente da mandare e niente da ricordare (M8).
      if (!this.subs.has(event.pageId)) return;
      if (event.seq <= (this.lastSeq.get(event.pageId) ?? 0)) return;
      this.lastSeq.set(event.pageId, event.seq);
      await this.broadcast(event.pageId, () => ({
        type: "revision",
        seq: event.seq,
        kind: event.kind,
        actorId: event.actorId,
        sessionId: event.sessionId,
        ops: event.ops ?? [],
        title: event.title ?? null,
        parentId: event.parentId ?? null,
      }));
      await this.refreshHoldsNow(event.pageId);
    });
  }

  /** La pagina non c'è più: `gone` a tutti, e via. */
  gone(pageId: string): void {
    for (const sub of [...(this.subs.get(pageId) ?? [])]) this.drop(sub, true);
    this.presence.delete(pageId);
    this.lastHolds.delete(pageId);
    this.lastSeq.delete(pageId);
  }

  /** Una NOTIFY di `product_page_events` (un altro processo, o questo prima della rotta). */
  handleNotify(payload: string): void {
    let msg: { type?: unknown; pageId?: unknown };
    try {
      msg = JSON.parse(payload) as typeof msg;
    } catch {
      return;
    }
    if (typeof msg.pageId !== "string") return;
    if (msg.type === "gone") return this.gone(msg.pageId);
    // F6: una bozza di schermata è cambiata (disegnata, una variante nuova, fallita): il client rilegge la pagina.
    if (msg.type === "wireframe") {
      const w = msg as { wireframeId?: unknown; status?: unknown };
      if (typeof w.wireframeId !== "string" || typeof w.status !== "string") return;
      void this.broadcast(msg.pageId, () => ({ type: "wireframe", wireframeId: w.wireframeId as string, status: w.status as string }));
      return;
    }
    if (msg.type !== "revision") return;
    const event = msg as unknown as ProductRevisionEvent;
    // La rotta dello stesso processo arriva subito dopo il commit con le operazioni: le si dà un attimo.
    setTimeout(() => void this.revision({ ...event, ops: [] }), NOTIFY_GRACE_MS).unref();
  }

  /**
   * Il battito di una sessione (una scheda) di chi guarda: la presenza (e il
   * cursore) per 15 s. La sezione (la rotta l'ha già validata e ha chiesto
   * `docs.edit`):
   * - `sectionId` dato: la prende o la rinnova, e lascia le ALTRE sezioni della
   *   persona nella pagina (al più una per persona, review di F4 I4 e M4); se la
   *   tiene un altro, `busy` e la presenza non dice che scrive lì (M6);
   * - assente: tiene la sezione di prima, RINNOVANDONE la presa (M6);
   * - `null`: non scrive più; le sue prese si lasciano se nessun'altra sua
   *   sessione sta scrivendo nella pagina (M4).
   */
  beat(input: { pageId: string; userId: string; sessionId?: string | null; viewerSees: (userId: string) => boolean; cursor?: ProductCursor | null; sectionId?: string | null }): Promise<{ hold: ProductSectionHold | null; busy: ProductSectionHold | null }> {
    let result: { hold: ProductSectionHold | null; busy: ProductSectionHold | null } = { hold: null, busy: null };
    return this.serial(input.pageId, async () => {
      const page = this.presence.get(input.pageId) ?? new Map<string, Presence>();
      const key = presenceKey(input.userId, input.sessionId);
      const before = page.get(key);
      const now = this.now();
      const wanted = input.sectionId !== undefined ? input.sectionId : (before?.sectionId ?? null);
      let sectionId: string | null = null;
      if (wanted) {
        const got = await takeSection(this.db, { pageId: input.pageId, sectionId: wanted, userId: input.userId, ttlMs: PRODUCT_HOLD_TTL_MS, now: new Date(now) });
        const names = await this.names([got.taken ? input.userId : got.by]);
        if (got.taken) {
          sectionId = wanted;
          result = { hold: { sectionId: wanted, by: { id: input.userId, name: names.get(input.userId) ?? null }, expiresAt: got.expiresAt.toISOString() }, busy: null };
          // Al più UNA sezione presa per persona e pagina.
          await this.db.delete(productSectionHolds).where(and(eq(productSectionHolds.pageId, input.pageId), eq(productSectionHolds.userId, input.userId), ne(productSectionHolds.sectionId, wanted)));
          for (const [k, p] of page) if (k !== key && p.userId === input.userId && p.sectionId !== null && p.sectionId !== wanted) p.sectionId = null;
        } else {
          result = { hold: null, busy: { sectionId: wanted, by: { id: got.by, name: input.viewerSees(got.by) ? (names.get(got.by) ?? null) : null }, expiresAt: got.expiresAt.toISOString() } };
        }
      } else if (input.sectionId === null) {
        const othersWriting = [...page.entries()].some(([k, p]) => k !== key && p.userId === input.userId && p.sectionId !== null && p.expiresAt > now);
        if (!othersWriting) await releaseSections(this.db, input.pageId, input.userId);
      }
      const next: Presence = { userId: input.userId, cursor: input.cursor !== undefined ? input.cursor : (before?.cursor ?? null), sectionId, expiresAt: now + this.presenceTtlMs };
      page.set(key, next);
      this.presence.set(input.pageId, page);
      if (!before || before.sectionId !== next.sectionId) await this.broadcastPresence(input.pageId);
      else if (JSON.stringify(before.cursor) !== JSON.stringify(next.cursor)) {
        await this.broadcast(input.pageId, (sub) => (sub.userId !== input.userId && this.sees(sub, input.userId) ? { type: "cursor", userId: input.userId, cursor: next.cursor } : null));
      }
      await this.refreshHoldsNow(input.pageId);
    }).then(() => result);
  }

  /**
   * Il giro a tempo: permessi da rileggere, presenze scadute (e le loro prese),
   * presenze di chi non legge più i Docs (M5), prese cambiate. Uno alla volta (M8).
   */
  async sweep(): Promise<void> {
    if (this.sweeping) return;
    this.sweeping = true;
    try {
      const now = this.now();
      for (const [pageId, page] of [...this.presence.entries()]) {
        await this.serial(pageId, async () => {
          const expired = [...page.entries()].filter(([, p]) => p.expiresAt <= now);
          // M5: chi non legge più i Docs del progetto della pagina esce dalla presenza (col suo nome).
          const [row] = await this.db.select({ projectId: productPages.projectId }).from(productPages).where(eq(productPages.id, pageId));
          const lost: [string, Presence][] = [];
          const checked = new Map<string, boolean>();
          for (const [k, p] of page.entries()) {
            if (p.expiresAt <= now) continue;
            if (!checked.has(p.userId)) {
              const perms = row ? await projectPermissionsByProject(this.db, p.userId, [row.projectId]) : new Map();
              checked.set(p.userId, row !== undefined && (await readsDocs(this.db, row.projectId, perms.get(row.projectId))));
            }
            if (!checked.get(p.userId)) lost.push([k, p]);
          }
          if (expired.length === 0 && lost.length === 0) return;
          const leaving = new Set<string>();
          for (const [k, p] of [...expired, ...lost]) {
            page.delete(k);
            leaving.add(p.userId);
          }
          for (const userId of leaving) {
            const stillHere = [...page.values()].some((p) => p.userId === userId && p.sectionId !== null && p.expiresAt > now);
            if (!stillHere) await releaseSections(this.db, pageId, userId);
          }
          if (page.size === 0) this.presence.delete(pageId);
          await this.broadcastPresence(pageId);
        });
      }
      for (const [pageId, set] of [...this.subs.entries()]) {
        await this.serial(pageId, async () => {
          for (const sub of [...set]) {
            if (!sub.ready) continue;
            try {
              if (!(await this.allowed(sub))) this.drop(sub, true);
            } catch (error) {
              this.log.warn({ err: error, pageId }, "canale dal vivo: permessi non riletti");
            }
          }
          await this.refreshHoldsNow(pageId);
        });
      }
    } catch (error) {
      this.log.warn({ err: error }, "canale dal vivo: giro non riuscito");
    } finally {
      this.sweeping = false;
    }
  }
}
