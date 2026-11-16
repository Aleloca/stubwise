import type { Reader, WaitingCustomersResponse } from "@stubwise/shared";
import type { WaitingCustomer } from "../../mail";
import { inPrototypeWords } from "./automationRefs";
import { appClient } from "./client";
import { threadKey } from "./mailKeys";

// «Clienti in attesa» della build app (area 8, piano di 72): `GET
// /api/me/waiting-customers` (`client.mail.waitingCustomers()`) nelle forme
// del prototipo (`mail.listWaitingCustomers`). Chi, quali caselle e il
// giudizio li decide il server; qui: un giudizio che l'app non conosce vale
// «da valutare» (e allora nessun motivo), il motivo di Claude solo con `yes`
// (testo NON fidato, il blocco lo mostra come testo).

export interface WaitingApi {
  waitingCustomers(): Promise<Reader<WaitingCustomersResponse>>;
}

const IMPORTANCE = new Set(["high", "normal", "low"]);

export function createRealWaiting(api: WaitingApi) {
  return {
    async listWaitingCustomers(): Promise<{ items: WaitingCustomer[]; total: number }> {
      const r = await inPrototypeWords(() => api.waitingCustomers());
      return {
        total: r.total ?? 0,
        items: r.items.map((x) => {
          const yes = x.judgment === "yes";
          return {
            // La Posta dell'app apre un thread per casella: `<accountId>_<gmailThreadId>`
            // (review C1: il threadId nudo apriva «not found»).
            threadId: threadKey(x.accountId, x.threadId),
            accountId: x.accountId,
            accountEmail: x.accountEmail,
            customer: { name: x.customer.name ?? null, email: x.customer.email },
            subject: x.subject ?? null,
            project: { id: x.project.id, code: x.project.code, name: x.project.name },
            waitingSince: x.waitingSince,
            signal: x.signal ?? null,
            importance:
              x.importance && IMPORTANCE.has(x.importance)
                ? (x.importance as WaitingCustomer["importance"])
                : null,
            judgment: yes ? "yes" : "pending",
            reason: yes ? (x.reason ?? null) : null,
          };
        }),
      };
    },
  };
}

export const mailWaitingFunctions = createRealWaiting({
  waitingCustomers: () => appClient().mail.waitingCustomers(),
});
