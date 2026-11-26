import { ApiError } from "@stubwise/api-client";
import type { ProviderView } from "../../instance/providers";
import type { AiProvider, TestOutcome } from "../../instance/state";
import type { InstanceResult } from "../../instance/types";
import { appClient } from "./client";

// Amministrazione → AI → Providers nella build app (area 9, F3) sulle rotte di
// 72 (`/api/ai-providers`, Task 8c) e sulla quota (`aiUsage.snapshots`). Il
// server decide l'unico account acceso (`lastEnabled`, 409
// `last_enabled_provider`), la banda della quota (`quotaBand`) e la
// riconferma (crea, sostituisce, elimina): qui si leggono.
//
// Differenze dichiarate (parità):
// - la prova la fa il worker: si chiede, poi si rilegge finché non è più
//   `pending` (al più ~60 s); `failed` non distingue la credenziale sbagliata
//   dalla rete, quindi si dice «credenziale non valida»;
// - le credenziali salvate prima della 0190 non hanno le ultime 4: «••••»;
// - la quota la legge chi ha `usage.view`; senza, la riga della quota non c'è.

/* eslint-disable @typescript-eslint/no-explicit-any -- forme del server lette dai Reader */
type Any = any;

const POLL_MS = 1500;
const POLL_TIMES = 40;

/** Le rotte (sul client vero: `client.aiProviders`, `client.aiUsage`), più l'attesa fra due letture. */
export interface ProvidersApi {
  list(): Promise<Any[]>;
  snapshots(): Promise<Any[]>;
  create(input: { kind: "account" | "api_key"; label: string; secret: string }): Promise<Any>;
  update(id: string, patch: { label?: string; enabled?: boolean; secret?: string }): Promise<Any>;
  reorder(orderedIds: string[]): Promise<Any>;
  test(id: string): Promise<Any>;
  remove(id: string): Promise<void>;
  wait(ms: number): Promise<void>;
}

const kindOf = (k: string): AiProvider["kind"] => (k === "account" ? "subscription" : "api_key");
const serverKind = (k: AiProvider["kind"]) => (k === "subscription" ? "account" : "api_key");

function refusalOf(error: unknown): Extract<InstanceResult, { ok: false }> {
  if (!(error instanceof ApiError)) throw error;
  const code = error.code ?? "";
  if (code === "reauth_required") return { ok: false, error: "reauth_required" };
  if (error.status === 404) return { ok: false, error: "not_found" };
  if (error.status === 403) return { ok: false, error: "forbidden" };
  if (error.status === 409 && (code === "conflict" || code === "label_taken" || code === ""))
    return { ok: false, error: "conflict" };
  if (code) return { ok: false, error: "invalid", reason: code };
  throw error;
}

/**
 * L'esito della prova. Rimandi, lotto 5, voce 6 (72, 8e1c90426): un fallimento
 * dice se era la rete o la credenziale (`testFailure`, derivato dal server);
 * un server di prima non lo dice, e resta «credenziale», come prima.
 */
const outcomeOf = (p: { testStatus: string; testFailure?: string | null }): TestOutcome | null =>
  p.testStatus === "passed"
    ? "ok"
    : p.testStatus === "failed"
      ? p.testFailure === "unreachable"
        ? "unreachable"
        : "invalid_credentials"
      : null;

export function createRealProviders(api: ProvidersApi) {
  async function attempt<T extends object>(call: () => Promise<T>): Promise<InstanceResult<T>> {
    try {
      return { ok: true, ...(await call()) } as InstanceResult<T>;
    } catch (error) {
      return refusalOf(error);
    }
  }

  const viewOf = (p: Any, snapshot: Any | undefined): ProviderView => {
    const kind = kindOf(p.kind);
    const outcome = outcomeOf(p);
    const band = p.quotaBand === "near" || p.quotaBand === "limited" ? p.quotaBand : "ok";
    const quota =
      kind === "subscription" && (snapshot || p.limitedUntil)
        ? {
            fiveHourPct: snapshot?.sessionRemaining?.percentUsed ?? 0,
            weeklyPct: snapshot?.weeklyRemaining?.percentUsed ?? 0,
            readAt: snapshot?.capturedAt ?? p.limitedUntil,
            band,
            limitedUntil: p.limitedUntil ?? null,
          }
        : null;
    return {
      id: p.id,
      name: p.label,
      kind,
      enabled: !!p.enabled,
      last4: p.last4 ?? "",
      createdAt: p.createdAt,
      lastTest: outcome && p.testCheckedAt ? { at: p.testCheckedAt, outcome } : null,
      position: p.position,
      quota,
      lastEnabled: !!p.lastEnabled,
    } as ProviderView;
  };

  async function list(): Promise<ProviderView[]> {
    const [rows, snapshots] = await Promise.all([
      api.list(),
      // La quota la legge chi ha `usage.view`: senza, niente riga della quota.
      api.snapshots().catch((error: unknown) => {
        if (error instanceof ApiError && error.status === 403) return [] as Any[];
        throw error;
      }),
    ]);
    return [...rows]
      .sort((a, b) => a.position - b.position)
      .map((p) =>
        viewOf(
          p,
          snapshots.find((s: Any) => s.providerId === p.id),
        ),
      );
  }

  return {
    listProviders: list,

    createProvider: (input: { name: string; kind: AiProvider["kind"]; credential: string }) =>
      attempt(async () => {
        const r = await api.create({
          kind: serverKind(input.kind),
          label: input.name.trim(),
          secret: input.credential.trim(),
        });
        return { providerId: r.id as string };
      }),

    renameProvider: (id: string, name: string) =>
      attempt(async () => {
        await api.update(id, { label: name.trim() });
        return {};
      }),

    setProviderEnabled: (id: string, enabled: boolean) =>
      attempt(async () => {
        await api.update(id, { enabled });
        return {};
      }),

    replaceProviderCredential: (id: string, credential: string) =>
      attempt(async () => {
        await api.update(id, { secret: credential.trim() });
        return {};
      }),

    /** Sposta un account al posto `toIndex` (da 0): il server vuole TUTTI gli id nel nuovo ordine. */
    moveProvider: (id: string, toIndex: number) =>
      attempt(async () => {
        const ids = (await list()).map((p) => p.id);
        const from = ids.indexOf(id);
        if (from < 0) throw new ApiError(404, "not_found", "not_found");
        ids.splice(from, 1);
        ids.splice(Math.max(0, Math.min(toIndex, ids.length)), 0, id);
        await api.reorder(ids);
        return {};
      }),

    deleteProvider: (id: string) =>
      attempt(async () => {
        await api.remove(id);
        return {};
      }),

    /** Chiede la prova e la rilegge finché il worker non l'ha fatta. */
    async testProvider(id: string): Promise<InstanceResult<{ outcome: TestOutcome }>> {
      try {
        await api.test(id);
        for (let i = 0; i < POLL_TIMES; i++) {
          const row = (await api.list()).find((p) => p.id === id);
          if (!row) return { ok: false, error: "not_found" };
          const outcome = outcomeOf(row);
          if (outcome) return { ok: true, outcome };
          await api.wait(POLL_MS);
        }
        return { ok: false, error: "invalid", reason: "test_pending" };
      } catch (error) {
        return refusalOf(error);
      }
    },
  };
}

/** Sul client vero (il client si legge a ogni chiamata). */
const liveApi: ProvidersApi = {
  list: () => appClient().aiProviders.list() as Promise<Any[]>,
  snapshots: () => appClient().aiUsage.snapshots() as Promise<Any[]>,
  create: (input) => appClient().aiProviders.create(input as Any),
  update: (id, patch) => appClient().aiProviders.update(id, patch as Any),
  reorder: (ids) => appClient().aiProviders.reorder(ids),
  test: (id) => appClient().aiProviders.test(id),
  remove: (id) => appClient().aiProviders.remove(id),
  wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/** SOLO TEST: le rotte vere. */
export const liveProvidersApiForTest = liveApi;

export const liveProviders = createRealProviders(liveApi);
