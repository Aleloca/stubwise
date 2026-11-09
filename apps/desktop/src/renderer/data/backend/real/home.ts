import type { DepartmentHomeView, MeHomeView } from "@stubwise/shared";
import type * as Fake from "../../api";
import { withHiddenBlocks } from "../../../domain/home";
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

type RawBlock = { kind: string; filterId?: string };

const isUnknown = (b: RawBlock) => !Object.hasOwn(KNOWN_KINDS, b.kind);

/**
 * I blocchi come li ha dati il server, compresi i tipi che questa app non
 * conosce: salvando, quelli tornano al loro posto (`withHiddenBlocks`), così
 * un'app più vecchia del server non li cancella. Si svuotano solo con
 * «Ripristina» (la Home personale) o con una lettura nuova.
 */
let rawPersonal: RawBlock[] = [];
const rawDepartment = new Map<string, RawBlock[]>();

function knownBlocks(blocks: RawBlock[]): HomeBlockRef[] {
  return blocks.flatMap((b) =>
    !isUnknown(b)
      ? [{ kind: b.kind as HomeBlockKind, ...(b.filterId !== undefined ? { filterId: b.filterId } : {}) }]
      : [],
  );
}

function personalOf(view: MeHomeView): PersonalHome | null {
  // Senza Home personale si parte dalla risolta: anche lì un tipo ignoto va tenuto.
  rawPersonal = view.personal?.blocks ?? view.blocks;
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
    rawDepartment.set(home.departmentId, home.blocks);
    return home.updatedAt === null
      ? []
      : [{ departmentId: home.departmentId, blocks: knownBlocks(home.blocks), updatedAt: home.updatedAt }];
  });
};

export const getPersonalHome: typeof Fake.getPersonalHome = async () =>
  personalOf((await appClient().home.get()) as MeHomeView);

export const setPersonalHome: typeof Fake.setPersonalHome = async (blocks) => {
  const view = (await appClient().home.set(withHiddenBlocks<RawBlock>(blocks, rawPersonal, isUnknown))) as MeHomeView;
  return personalOf(view) ?? { personId: session.personId ?? "", blocks: [], seenDepartmentUpdates: {} };
};

/** «Ripristina»: l'unico modo di togliere anche i blocchi che l'app non mostra. */
export const resetPersonalHome: typeof Fake.resetPersonalHome = async () => {
  await appClient().home.reset();
  rawPersonal = [];
};

/** Full admin o `department.home.manage` nel reparto; un filtro privato → 400 `filter_not_public`. */
export const setDepartmentHome: typeof Fake.setDepartmentHome = async (departmentId, blocks) => {
  await appClient().departments.setHome(
    departmentId,
    withHiddenBlocks<RawBlock>(blocks, rawDepartment.get(departmentId) ?? [], isUnknown),
  );
};

/** «Vista» è la Home del reparto mostrata (`updatedAt`); il server tiene il minimo con l'attuale. */
export const markDepartmentHomeSeen: typeof Fake.markDepartmentHomeSeen = async (departmentId, updatedAt) => {
  const shown = updatedAt ?? (await appClient().departments.home(departmentId)).updatedAt;
  if (shown) await appClient().home.markSeen(departmentId, shown);
};

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
