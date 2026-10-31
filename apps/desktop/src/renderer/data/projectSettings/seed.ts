import { seedInstanceState } from "../instance/seed";
import type { EnvFile } from "../model";
import { PROJECT_PLUGINS } from "../seed/commands";
import { daysFromToday } from "../seed/dates";
import { PROJECTS } from "../seed/projects";
import { hashOf } from "../seed/servers/metrics";
import type { ProjectSettings, ProjectSwitch } from "./state";

// Il seme delle impostazioni di progetto (area 9c, Task 1). Lo legge
// `freshState` di `store.ts`, quindi qui non si importa né lo store né il
// caveau dei segreti: lo store lo raggiungerebbe, e con lui le letture del
// registro (`architecture.secrets.test.ts`, ruling del controller
// (pre-flight), P6). La chiave d'ingestione e le variabili d'ambiente del
// seme non hanno un valore nel caveau (`secretId: null`): nessuno le ha mai
// viste in questa sessione, come i segreti del seme 9b.
//
// - Interruttori: i progetti `software` hanno Docs notturni e report del
//   giorno; tutti la discovery del backlog, il pulse ogni 7 giorni e il
//   brief. MKX ha il brief spento, CBV il pulse spento.
// - AUD lavora solo con «Backup Max» (vicino alla soglia della settimana:
//   l'effetto si vede); gli altri sono su «Automatic».
// - Plugin, per sottrazione (ruling del controller (pre-flight), P3): il
//   riferimento è il registro dell'istanza (superpowers, 9 skill). I progetti
//   che fino al 9b non avevano superpowers (i non software e ZNC) nascono con
//   tutte le sue skill e i suoi gruppi di hook spenti; AUD con
//   `test-driven-development` spenta. Così «/» non cambia per nessuno. Il
//   plugin base `stubwise` non sta fra le scelte: vale per tutti.

/** Le ultime 4 cifre esadecimali, sempre le stesse per la stessa chiave. */
const last4Of = (seed: string): string =>
  (hashOf(seed) >>> 0).toString(16).padStart(8, "0").slice(-4);

const at = (days: number, hm: string): string => `${daysFromToday(days)}T${hm}:00Z`;

function switchesOf(code: string, software: boolean): Record<ProjectSwitch, boolean> {
  return {
    docsNightly: software,
    dailyReport: software,
    backlogDiscovery: true,
    pulse: code !== "CBV",
    weeklyBrief: code !== "MKX",
  };
}

/** Le scelte dei plugin del seme, dal registro (P3). */
function pluginChoicesOf(projectId: string): ProjectSettings["plugins"] {
  const superpowers = seedInstanceState().plugins.find((p) => p.name === "superpowers")!;
  const inventory = superpowers.inventory!;
  const chosen = (PROJECT_PLUGINS[projectId] ?? []).find((e) => e.pluginId === superpowers.id);
  if (!chosen)
    return {
      version: 1,
      disabled: [
        {
          plugin: superpowers.name,
          skills: inventory.skills.map((s) => s.name),
          hookGroups: inventory.hooks.map((h) => h.key),
        },
      ],
    };
  return {
    version: 1,
    disabled:
      chosen.disabledSkills.length > 0
        ? [{ plugin: superpowers.name, skills: [...chosen.disabledSkills], hookGroups: [] }]
        : [],
  };
}

/**
 * Le impostazioni di un progetto nato dall'app (`createProject`), che il seme
 * non conosce: gli interruttori di un progetto del seme dello stesso
 * modello, «Automatic», nessun plugin spento (per sottrazione). Le scrive
 * chi le legge per primo (`reads.ts`, `settingsOf`).
 */
export function defaultProjectSettings(p: { id: string; template: string }): ProjectSettings {
  return {
    projectId: p.id,
    aiProviderId: null,
    aiProviderExclusive: false,
    switches: switchesOf("", p.template === "software"),
    pulseEveryDays: 7,
    ingestion: {
      secretId: null,
      last4: last4Of(`ingestion|${p.id}`),
      createdAt: at(0, "00:00"),
      createdById: null,
    },
    plugins: { version: 1, disabled: [] },
  };
}

/** Le impostazioni di ogni progetto del seme, nuove a ogni chiamata. */
export function seedProjectSettings(): Map<string, ProjectSettings> {
  return new Map(
    PROJECTS.map((p): [string, ProjectSettings] => {
      const aud = p.code === "AUD";
      return [
        p.id,
        {
          projectId: p.id,
          aiProviderId: aud ? "prv-backup-max" : null,
          aiProviderExclusive: aud,
          switches: switchesOf(p.code, p.template === "software"),
          pulseEveryDays: 7,
          ingestion: {
            secretId: null,
            last4: last4Of(`ingestion|${p.id}`),
            createdAt: at(-90, "10:00"),
            createdById: null,
          },
          plugins: pluginChoicesOf(p.id),
        },
      ];
    }),
  );
}

const variable = (key: string, days: number): EnvFile["vars"][number] => ({
  key,
  secretId: null,
  setAt: at(-days, "15:00"),
});

/**
 * I file d'ambiente del seme: `stubwise` (STW) in `test` (3 variabili) e in
 * `production` (2); `shop-frontend` (RNC) in `production`. ACQ non ne ha.
 * Solo quello di `test` arriva a Claude.
 */
export function seedEnvFiles(): EnvFile[] {
  return [
    {
      id: "envf-stw-test",
      repositoryId: "repo-stw",
      environmentId: "env-stw-test",
      path: ".env",
      vars: [
        variable("DATABASE_URL", 30),
        variable("REDIS_URL", 30),
        variable("STUBWISE_TEST_TOKEN", 12),
      ],
    },
    {
      id: "envf-stw-prod",
      repositoryId: "repo-stw",
      environmentId: "env-stw-prod",
      path: ".env",
      vars: [variable("DATABASE_URL", 60), variable("SENTRY_DSN", 45)],
    },
    {
      id: "envf-rnc-prod",
      repositoryId: "repo-shop",
      environmentId: "env-rnc-prod",
      path: ".env",
      vars: [variable("PAYMENTS_SECRET_KEY", 70), variable("MAILER_API_KEY", 70)],
    },
  ];
}
