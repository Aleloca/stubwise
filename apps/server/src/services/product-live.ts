import { liveSectionHolds, releaseSections, takeSection, users, type Db } from "@stubwise/db";
import { instancePermissionsOfUser, projectPermissionsByProject } from "@stubwise/notifications";
import type { ProductCursor, ProductPresence, ProductSectionHold } from "@stubwise/shared";
import { inArray } from "drizzle-orm";
import { personName } from "./people.js";
import { visiblePersonIds } from "./people-visibility.js";
import { PRODUCT_HOLD_TTL_MS } from "./product-live-notify.js";

/**
 * Area 11, F4 — la scrittura dal vivo: il canale delle pagine di prodotto,
 * nella memoria del processo server (un solo processo oggi, dietro caddy: la
 * voce del deploy-log lo dice).
 *
 * - Presenza e cursori stanno QUI, con scadenza (15 s, il battito è ogni 5 s),
 *   mai in tabella. Le prese delle sezioni invece stanno in tabella
 *   (`product_section_holds`), perché le vede anche il worker (F5); qui se ne
 *   tiene l'ultima vista per mandare `hold` e `release`.
 * - Le revisioni arrivano in due modi, una volta sola (per `seq`): dalla rotta,
 *   dopo il commit, con le operazioni; e dalla NOTIFY `product_page_events`
 *   (scritta dentro la transazione), per le scritture di un altro processo (il
 *   worker, F5), senza operazioni: il client allora rilegge la pagina.
 * - I permessi di chi guarda si rileggono a ogni evento, con una validità di
 *   pochi secondi (`PERMS_TTL_MS`), e da un giro a tempo: un accesso tolto
 *   manda `gone` e chiude lo stream («Il canale dal vivo ricalcola i permessi
 *   a ogni evento»).
 * - Nessun nome di una persona che chi guarda non vede (R-G5): la presenza la
 *   tace, una presa la mostra senza nome.
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
}

interface Presence {
  cursor: ProductCursor | null;
  sectionId: string | null;
  expiresAt: number;
}

import type { ProductRevisionEvent } from "./product-live-notify.js";
export type { ProductRevisionEvent };

export class ProductLiveError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export class ProductLiveHub {
  private readonly subs = new Map<string, Set<Subscriber>>();
  private readonly presence = new Map<string, Map<string, Presence>>();
  private readonly lastSeq = new Map<string, number>();
  /** L'ultima vista delle prese di una pagina: sezione → `utente|scadenza`. */
  private readonly lastHolds = new Map<string, Map<string, { userId: string; expiresAt: Date }>>();
  private readonly timer: NodeJS.Timeout;

  private readonly permsTtlMs: number;
  private readonly presenceTtlMs: number;

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
    this.timer = setInterval(() => void this.sweep().catch((error: unknown) => this.log.warn({ err: error }, "canale dal vivo: giro non riuscito")), this.permsTtlMs);
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

  // --- i permessi ----------------------------------------------------------------

  /** Chi guarda legge ancora i Docs del progetto (e le persone che vede), con una validità di `PERMS_TTL_MS`. */
  private async allowed(sub: Subscriber, force = false): Promise<boolean> {
    if (!force && this.now() - sub.checkedAt < this.permsTtlMs) return true;
    const perms = await projectPermissionsByProject(this.db, sub.userId, [sub.projectId]);
    if (perms.get(sub.projectId)?.has("docs.view") !== true) return false;
    const people = await visiblePersonIds(this.db, { id: sub.userId, instancePermissions: await instancePermissionsOfUser(this.db, sub.userId) });
    sub.people = people === "all" ? "all" : new Set(people);
    sub.checkedAt = this.now();
    return true;
  }

  private drop(sub: Subscriber, gone: boolean): void {
    const set = this.subs.get(sub.pageId);
    if (!set?.has(sub)) return;
    set.delete(sub);
    if (set.size === 0) this.subs.delete(sub.pageId);
    if (gone) sub.send({ type: "gone" });
    sub.close();
  }

  /** Manda a ogni stream della pagina il frame che `make` costruisce per lui, dopo aver riletto i permessi. */
  private async broadcast(pageId: string, make: (sub: Subscriber) => Promise<Frame | null> | Frame | null): Promise<void> {
    for (const sub of [...(this.subs.get(pageId) ?? [])]) {
      if (!(await this.allowed(sub))) {
        this.drop(sub, true);
        continue;
      }
      const frame = await make(sub);
      if (frame) sub.send(frame);
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

  private livePresence(pageId: string): [string, Presence][] {
    const now = this.now();
    return [...(this.presence.get(pageId) ?? new Map<string, Presence>()).entries()].filter(([, p]) => p.expiresAt > now);
  }

  /** La presenza come la vede `sub`: gli ALTRI presenti che vede (R-G5). */
  private presenceFor(sub: Subscriber, names: Map<string, string>): ProductPresence[] {
    return this.livePresence(sub.pageId)
      .filter(([userId]) => userId !== sub.userId && this.sees(sub, userId) && names.has(userId))
      .map(([userId, p]) => ({ userId, name: names.get(userId)!, cursor: p.cursor, sectionId: p.sectionId }));
  }

  private async broadcastPresence(pageId: string): Promise<void> {
    const names = await this.names(this.livePresence(pageId).map(([id]) => id));
    await this.broadcast(pageId, (sub) => ({ type: "presence", presence: this.presenceFor(sub, names) }));
  }

  // --- le prese ------------------------------------------------------------------

  private holdFor(sub: Subscriber, sectionId: string, h: { userId: string; expiresAt: Date }, names: Map<string, string>): ProductSectionHold {
    return { sectionId, by: { id: h.userId, name: this.sees(sub, h.userId) ? (names.get(h.userId) ?? null) : null }, expiresAt: h.expiresAt.toISOString() };
  }

  /** Rilegge le prese vive della pagina e manda `hold` per le nuove o cambiate di mano, `release` per le sparite. */
  async refreshHolds(pageId: string): Promise<void> {
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

  // --- aprire e chiudere uno stream ---------------------------------------------

  /**
   * Apre lo stream di `userId` sulla pagina (la rotta ha già chiesto
   * `docs.view`): i tetti, il frame `state`, poi gli eventi. Restituisce chi lo
   * chiude.
   */
  async open(input: { pageId: string; projectId: string; userId: string; seq: number; send: (frame: Frame) => void; close: () => void }): Promise<() => void> {
    if (this.count(input.pageId) >= PRODUCT_LIVE_STREAMS_PER_PAGE) throw new ProductLiveError(429, "too_many_streams", `A page has at most ${PRODUCT_LIVE_STREAMS_PER_PAGE} live streams`);
    const mine = [...this.subs.values()].reduce((n, set) => n + [...set].filter((s) => s.userId === input.userId).length, 0);
    if (mine >= PRODUCT_LIVE_STREAMS_PER_PERSON) throw new ProductLiveError(429, "too_many_streams", `A person has at most ${PRODUCT_LIVE_STREAMS_PER_PERSON} live streams`);
    const sub: Subscriber = { pageId: input.pageId, projectId: input.projectId, userId: input.userId, send: input.send, close: input.close, checkedAt: 0, people: new Set() };
    if (!(await this.allowed(sub, true))) throw new ProductLiveError(404, "not_found", "Not found");
    const set = this.subs.get(input.pageId) ?? new Set<Subscriber>();
    set.add(sub);
    this.subs.set(input.pageId, set);
    const live = await liveSectionHolds(this.db, input.pageId, new Date(this.now()));
    if (!this.lastHolds.has(input.pageId)) this.lastHolds.set(input.pageId, new Map(live.map((h) => [h.sectionId, { userId: h.userId, expiresAt: h.expiresAt }])));
    const names = await this.names([...this.livePresence(input.pageId).map(([id]) => id), ...live.map((h) => h.userId)]);
    sub.send({
      type: "state",
      seq: Math.max(input.seq, this.lastSeq.get(input.pageId) ?? 0),
      presence: this.presenceFor(sub, names),
      holds: live.map((h) => this.holdFor(sub, h.sectionId, { userId: h.userId, expiresAt: h.expiresAt }, names)),
    });
    return () => this.drop(sub, false);
  }

  // --- gli eventi ----------------------------------------------------------------

  /** Una revisione salvata: una volta sola per `seq`. Con le operazioni se le ha (la rotta), senza dalla NOTIFY. */
  async revision(event: ProductRevisionEvent): Promise<void> {
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
    await this.refreshHolds(event.pageId);
  }

  /** La pagina non c'è più: `gone` a tutti, e via. */
  gone(pageId: string): void {
    for (const sub of [...(this.subs.get(pageId) ?? [])]) this.drop(sub, true);
    this.presence.delete(pageId);
    this.lastHolds.delete(pageId);
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
    if (msg.type !== "revision") return;
    const event = msg as unknown as ProductRevisionEvent;
    // La rotta dello stesso processo arriva subito dopo il commit con le operazioni: le si dà un attimo.
    setTimeout(() => void this.revision({ ...event, ops: [] }).catch((error: unknown) => this.log.warn({ err: error }, "canale dal vivo: revisione non consegnata")), NOTIFY_GRACE_MS).unref();
  }

  /**
   * Il battito di chi guarda: la presenza (e il cursore) per 15 s; con
   * `sectionId` (la rotta ha già chiesto `docs.edit`) la presa della sezione,
   * rinnovata o detta occupata. `sectionId: null` lascia le sue prese.
   */
  async beat(input: { pageId: string; userId: string; viewerSees: (userId: string) => boolean; cursor?: ProductCursor | null; sectionId?: string | null }): Promise<{ hold: ProductSectionHold | null; busy: ProductSectionHold | null }> {
    const page = this.presence.get(input.pageId) ?? new Map<string, Presence>();
    const before = page.get(input.userId);
    const now = this.now();
    const next: Presence = {
      cursor: input.cursor !== undefined ? input.cursor : (before?.cursor ?? null),
      sectionId: input.sectionId !== undefined ? input.sectionId : (before?.sectionId ?? null),
      expiresAt: now + this.presenceTtlMs,
    };
    page.set(input.userId, next);
    this.presence.set(input.pageId, page);
    let hold: ProductSectionHold | null = null;
    let busy: ProductSectionHold | null = null;
    if (input.sectionId) {
      const got = await takeSection(this.db, { pageId: input.pageId, sectionId: input.sectionId, userId: input.userId, ttlMs: PRODUCT_HOLD_TTL_MS, now: new Date(now) });
      const names = await this.names([got.taken ? input.userId : got.by]);
      if (got.taken) hold = { sectionId: input.sectionId, by: { id: input.userId, name: names.get(input.userId) ?? null }, expiresAt: got.expiresAt.toISOString() };
      else busy = { sectionId: input.sectionId, by: { id: got.by, name: input.viewerSees(got.by) ? (names.get(got.by) ?? null) : null }, expiresAt: got.expiresAt.toISOString() };
    } else if (input.sectionId === null) {
      await releaseSections(this.db, input.pageId, input.userId);
    }
    const moved = !before || before.sectionId !== next.sectionId || JSON.stringify(before.cursor) !== JSON.stringify(next.cursor);
    if (!before || before.sectionId !== next.sectionId) await this.broadcastPresence(input.pageId);
    else if (moved) {
      await this.broadcast(input.pageId, (sub) => (sub.userId !== input.userId && this.sees(sub, input.userId) ? { type: "cursor", userId: input.userId, cursor: next.cursor } : null));
    }
    await this.refreshHolds(input.pageId);
    return { hold, busy };
  }

  /** Il giro a tempo: permessi da rileggere, presenze scadute (e le loro prese), prese cambiate. */
  async sweep(): Promise<void> {
    const now = this.now();
    for (const [pageId, page] of [...this.presence.entries()]) {
      const expired = [...page.entries()].filter(([, p]) => p.expiresAt <= now).map(([id]) => id);
      if (expired.length === 0) continue;
      for (const id of expired) {
        page.delete(id);
        await releaseSections(this.db, pageId, id);
      }
      if (page.size === 0) this.presence.delete(pageId);
      await this.broadcastPresence(pageId);
    }
    for (const [pageId, set] of [...this.subs.entries()]) {
      for (const sub of [...set]) if (!(await this.allowed(sub))) this.drop(sub, true);
      if (this.subs.has(pageId)) await this.refreshHolds(pageId);
    }
  }
}
