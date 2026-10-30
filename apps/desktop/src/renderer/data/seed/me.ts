import { seedAccessState } from "../access/seed";
import type { GoogleWorkspace, Passkey, PersonalSession, PersonalToken } from "../me/types";
import { daysFromToday } from "./dates";

// Il seme delle Preferenze personali (area 9a, Task 5): sessioni aperte,
// passkey, token personali e il Workspace Google dell'istanza. Nessun
// segreto: i token del seme hanno `secretId: null` (il valore si vide una
// volta, quando furono creati).

const at = (days: number, time = "10:00") => `${daysFromToday(days)}T${time}:00Z`;

/** Le sessioni in più (oltre a questa app): il cambio password le chiude. */
const OTHER_SESSIONS: Record<string, PersonalSession["device"][]> = {
  "p-giulia": [
    { kind: "mobile", detail: "iPhone" },
    { kind: "browser", detail: "Chrome on Windows" },
  ],
  "p-roberta": [
    { kind: "mobile", detail: "iPhone" },
    { kind: "browser", detail: "Safari on macOS" },
  ],
  "p-laura": [{ kind: "browser", detail: "Firefox on Linux" }],
  "p-marco": [{ kind: "mobile", detail: "Android" }],
};

/** Ogni persona attiva ha la sessione di questa app; alcune anche il telefono e un browser. */
export function seedSessions(): PersonalSession[] {
  const out: PersonalSession[] = [];
  for (const p of seedAccessState().people) {
    if (p.status !== "active") continue;
    out.push({
      id: `ses-${p.personId}-app`,
      personId: p.personId,
      device: { kind: "desktop", detail: "macOS" },
      createdAt: at(-30),
      lastUsedAt: at(0, "12:00"),
      current: true,
    });
    (OTHER_SESSIONS[p.personId] ?? []).forEach((device, i) =>
      out.push({
        id: `ses-${p.personId}-${i + 1}`,
        personId: p.personId,
        device,
        createdAt: at(-20 + i),
        lastUsedAt: i === 0 ? at(0, "10:00") : at(-3, "18:30"),
        current: false,
      }),
    );
  }
  return out;
}

/** Le passkey, coerenti col conteggio di `secondFactor.passkeys` del seme. */
export function seedPasskeys(): Passkey[] {
  const names = ["MacBook Pro", "YubiKey"];
  const out: Passkey[] = [];
  for (const p of seedAccessState().people) {
    for (let i = 0; i < (p.secondFactor?.passkeys ?? 0); i++)
      out.push({
        id: `pk-${p.personId}-${i + 1}`,
        personId: p.personId,
        name: names[i] ?? `Passkey ${i + 1}`,
        addedAt: at(-57 + i * 6),
        lastUsedAt: i === 0 ? at(0, "09:00") : at(-27),
      });
  }
  return out;
}

/** Due token: quello di Marco per Claude Code, uno di Laura scaduto. */
export function seedTokens(): PersonalToken[] {
  return [
    {
      id: "pat-marco-1",
      personId: "p-marco",
      name: "Claude Code · Sep 12",
      createdAt: at(-47),
      expiresAt: null,
      lastUsedAt: at(0, "11:20"),
      secretId: null,
    },
    {
      id: "pat-laura-1",
      personId: "p-laura",
      name: "ci-release-notes",
      createdAt: at(-120),
      expiresAt: at(-30),
      lastUsedAt: at(-31),
      secretId: null,
    },
  ];
}

/** Il Workspace Google dell'istanza (lo gestisce 9b, Integrazioni). */
export function seedGoogleWorkspaces(): GoogleWorkspace[] {
  return [{ id: "gw-example", name: "Example", domains: ["example.com"] }];
}
