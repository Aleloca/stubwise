import type { DepartmentHomeView, MeHomeView } from "@stubwise/shared";
import type * as Fake from "../../api";
import type { DepartmentPermission, HomeBlockKind, HomeBlockRef, PersonalHome } from "../../types";
import { appClient, session } from "./client";

// La Home a blocchi della build app (integrazione area 2, fetta 3). Le Home dei
// reparti e quella personale vengono dal server, che le normalizza (fissi
// sempre presenti, niente doppi) e valida i filtri; `useHome` le risolve con la
// stessa `resolveHome` di `@stubwise/shared` che usa il server, e coi reparti
// nello stesso ordine (`/api/people` e `/api/me/home` ordinano per posizione).
// Un filtro eliminato o reso privato resta come blocco: «non disponibile» lo
// decide il client, come nel prototipo.

/** I tipi di blocco che questa app conosce: un tipo nuovo del server si ignora. */
const KNOWN_KINDS: Record<HomeBlockKind, true> = {
  decide: true,
  myWeek: true,
  myTasks: true,
  claudeForMe: true,
  stalledInMyProjects: true,
  newRequests: true,
  upcomingMilestones: true,
  upcomingEvents: true,
  importantMail: true,
  automations: true,
  releases: true,
  waitingCustomers: true,
  filter: true,
};

function knownBlocks(blocks: { kind: string; filterId?: string }[]): HomeBlockRef[] {
  return blocks.flatMap((b) =>
    Object.hasOwn(KNOWN_KINDS, b.kind)
      ? [{ kind: b.kind as HomeBlockKind, ...(b.filterId !== undefined ? { filterId: b.filterId } : {}) }]
      : [],
  );
}

function personalOf(view: MeHomeView): PersonalHome | null {
  if (!view.personal) return null;
  return {
    personId: session.personId ?? "",
    blocks: knownBlocks(view.personal.blocks),
    seenDepartmentUpdates: view.personal.seenDepartmentUpdates,
  };
}

/**
 * Le Home di tutti i reparti (le legge chiunque: sono disposizioni, non dati):
 * servono a quella di chi guarda e all'editor della Home di un reparto. Un
 * reparto senza una Home sua (`updatedAt` null) non c'è, come nel prototipo:
 * la sua Home sono i soli fissi.
 */
export const listDepartmentHomes: typeof Fake.listDepartmentHomes = async () => {
  const client = appClient();
  const departments = await client.departments.list();
  const homes = await Promise.all(departments.map((d) => client.departments.home(d.id)));
  return homes.flatMap((h) => {
    const home = h as DepartmentHomeView;
    return home.updatedAt === null
      ? []
      : [{ departmentId: home.departmentId, blocks: knownBlocks(home.blocks), updatedAt: home.updatedAt }];
  });
};

export const getPersonalHome: typeof Fake.getPersonalHome = async () =>
  personalOf((await appClient().home.get()) as MeHomeView);

export const setPersonalHome: typeof Fake.setPersonalHome = async (blocks) => {
  const view = (await appClient().home.set(blocks)) as MeHomeView;
  return personalOf(view) ?? { personId: session.personId ?? "", blocks: [], seenDepartmentUpdates: {} };
};

export const resetPersonalHome: typeof Fake.resetPersonalHome = () => appClient().home.reset();

/** Full admin o `department.home.manage` nel reparto; un filtro privato → 400 `filter_not_public`. */
export const setDepartmentHome: typeof Fake.setDepartmentHome = async (departmentId, blocks) => {
  await appClient().departments.setHome(departmentId, blocks);
};

export const markDepartmentHomeSeen: typeof Fake.markDepartmentHomeSeen = (departmentId) =>
  appClient().home.markSeen(departmentId);

/** I ruoli di reparto (chi dispone la Home di quale reparto), di tutti o di una persona. */
export const listDepartmentRoles: typeof Fake.listDepartmentRoles = async (personId) => {
  const rows = await appClient().departments.roles();
  return rows
    .filter((r) => personId === undefined || r.userId === personId)
    .map((r) => ({
      personId: r.userId,
      departmentId: r.departmentId,
      permissions: r.permissions as DepartmentPermission[],
    }));
};
