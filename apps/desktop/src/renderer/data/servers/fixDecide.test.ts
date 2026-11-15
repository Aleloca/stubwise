import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fixCommandsBeforeApproval } from "../../domain/servers/fixGate";
import { getConversation, resetApi, servers, setLatency } from "../api";
import { setSessionPersonId } from "../session";
import { eventsOf, state } from "../store";
import { whenFixesIdle } from "./fix";

// Area 8, F4b (decisione del maintainer, 15 nov 2026): il piano di una
// correzione si decide nella sezione Server della task, dalla vista della
// correzione, come sul server (`/api/tasks/:id/server-fix/approve|reject|stop`):
// Approva col digest del piano MOSTRATO (`plan_changed` se nel frattempo è
// cambiato), Rifiuta con la nota, Stop. La sessione resta solo da leggere.

const TASK = "t-acq-srv-1"; // ACQ-6, la task della diagnosis di SRV-1 (seme)
const as = (personId: string) => setSessionPersonId(personId);
const message = (p: Promise<unknown>) =>
  p.then(
    () => "ok",
    (e: Error) => e.message,
  );
const info = async () => (await servers.getServerTaskInfo(TASK))!;
const fixCommands = () =>
  state.conversations
    .filter((c) => c.serverFix)
    .flatMap((c) =>
      eventsOf(c.id).filter((e) => e.type === "action" && e.serverCommand?.kind === "change"),
    );

beforeEach(() => {
  resetApi();
  setLatency(0);
});
afterEach(async () => {
  await whenFixesIdle();
  resetApi();
});

async function planned() {
  as("p-roberta");
  await servers.startServerFix(TASK);
  await whenFixesIdle();
  return info();
}

describe("la correzione si decide dalla task (decisione 3)", () => {
  it("la vista porta il digest del piano e la sessione; Approva col digest mostrato fa partire i passi", async () => {
    const before = await planned();
    expect(before.state).toBe("plan_awaiting");
    expect(before.fix!.planDigest).toMatch(/^[0-9a-f]{8,}$/);
    expect(before.fix!.sessionId).toBe(before.fixConversationId);
    expect(fixCommands()).toEqual([]);
    await servers.approveServerFix(TASK, before.fix!.planDigest!);
    await whenFixesIdle();
    expect(fixCommands().length).toBeGreaterThan(0);
    const after = await info();
    expect(after.fix!.approval).toMatchObject({ byId: "p-roberta" });
    for (const c of state.conversations) expect(fixCommandsBeforeApproval(eventsOf(c.id))).toBe(0);
  });

  it("un digest che non è quello del piano di adesso: `invalid: plan_changed`, nessun comando", async () => {
    await planned();
    expect(await message(servers.approveServerFix(TASK, "deadbeef00"))).toBe(
      "invalid: plan_changed",
    );
    expect(fixCommands()).toEqual([]);
  });

  it("Rifiuta con la nota: il piano rifiutato con le indicazioni, nessun comando", async () => {
    await planned();
    await servers.rejectServerFix(TASK, "Restart the API, not the database");
    await whenFixesIdle();
    // Il piano rifiutato resta con le indicazioni; Claude ne scrive uno nuovo, da approvare.
    const run = state.conversations.find((c) => c.serverFix)!;
    const rejected = eventsOf(run.id).find((e) => e.type === "plan" && e.status === "rejected");
    expect(rejected).toMatchObject({
      decidedById: "p-roberta",
      instructions: "Restart the API, not the database",
    });
    expect(fixCommands()).toEqual([]);
  });

  it("chi non ha plans.approve non approva; senza un piano che aspetta: `invalid: not_awaiting_approval`", async () => {
    const before = await planned();
    as("p-marco");
    expect(await message(servers.approveServerFix(TASK, before.fix!.planDigest!))).toBe(
      "forbidden",
    );
    as("p-roberta");
    await servers.approveServerFix(TASK, before.fix!.planDigest!);
    expect(await message(servers.approveServerFix(TASK, before.fix!.planDigest!))).toBe(
      "invalid: not_awaiting_approval",
    );
  });

  it("Stop dalla task ferma la correzione", async () => {
    const before = await planned();
    await servers.approveServerFix(TASK, before.fix!.planDigest!);
    await servers.stopServerFix(TASK);
    await whenFixesIdle();
    expect((await info()).state).toBe("stopped");
    expect(await message(servers.stopServerFix(TASK))).toBe("invalid: not_running");
  });

  it("la sessione della correzione si legge: niente Stop né «Ferma e scrivi» lì", async () => {
    const before = await planned();
    await servers.approveServerFix(TASK, before.fix!.planDigest!);
    const detail = await getConversation(before.fixConversationId!);
    expect(detail?.canInterrupt).toBe(false);
    // La correzione si ferma comunque dalla task.
    expect((await info()).fix!.canStop).toBe(true);
  });
});
