import type { VaultState } from "../vault/types";
import { at } from "./mail/helpers";

// Il seme della Cassaforte (lotto 10, shape `vault.md`). ACQ ha quattro
// credenziali, MKX una. Le persone del seme:
// - Laura (Project Lead in ACQ): chiave confermata, due Mac, questo
//   associato e chiuso; legge Aruba e Cloudflare (le ha create), gestisce
//   Mailgun senza leggerlo; aspetta la copia di Stripe (lettrice diretta);
// - Matteo (Project Lead in ACQ e MKX): ha creato Mailgun e Stripe, può
//   passare a Laura la copia di Stripe; un Mac, non questo;
// - Marco (Developer in ACQ): ha creato la chiave ieri, in attesa; legge
//   Aruba col ruolo Developer quando qualcuno lo conferma;
// - Sara (Contributor in ACQ): confermata, legge Cloudflare (lettrice diretta);
// - Giulia (Project Lead in MKX): confermata, legge Figma, nessun Mac;
// - Roberta (full admin): confermata, legge tutto, nessun Mac.

const ARUBA = "cred-acq-aruba";
const CLOUDFLARE = "cred-acq-cloudflare";
const MAILGUN = "cred-acq-mailgun";
const STRIPE = "cred-acq-stripe";
const FIGMA = "cred-mkx-figma";

export const VAULT_IDS = {
  ARUBA,
  CLOUDFLARE,
  MAILGUN,
  STRIPE,
  FIGMA,
  LAURA_MAC: "mac-laura-mbp",
} as const;

const credential = (
  id: string,
  projectId: string,
  service: string,
  username: string,
  password: string,
  createdById: string,
  extra: { label?: string; url?: string; notes?: string } = {},
) => ({
  id,
  projectId,
  service,
  label: extra.label ?? null,
  url: extra.url ?? null,
  username,
  notes: extra.notes ?? null,
  password,
  createdById,
  createdAt: at(30, "09:00"),
  updatedAt: at(12, "10:00"),
});

export function seedVault(): VaultState {
  return {
    active: true,
    credentials: [
      credential(ARUBA, "prj-acq", "Aruba hosting", "admin@acquedotto", "Kx4!pa-77Wq", "p-laura", {
        url: "https://admin.aruba.it",
        notes: "Panel for the production server.",
      }),
      credential(CLOUDFLARE, "prj-acq", "Cloudflare", "ops@acquedotto", "Gq7#v2-LmpZ", "p-laura", {
        label: "DNS and CDN",
        url: "https://dash.cloudflare.com",
      }),
      credential(MAILGUN, "prj-acq", "Mailgun", "postmaster", "mg-Tr9#e4Lq", "p-matteo"),
      credential(STRIPE, "prj-acq", "Stripe", "laura.costa", "sk-Wd2$b8Nf", "p-matteo", {
        label: "Test mode",
      }),
      credential(FIGMA, "prj-mkx", "Figma", "design@markex", "Fg5&k1-Mzo", "p-giulia"),
    ],
    readers: [
      // Il ruolo Developer di ACQ legge Aruba (Marco, Federico).
      {
        id: "rd-1",
        credentialId: ARUBA,
        personId: null,
        roleId: "role-developer",
        addedById: "p-laura",
        addedAt: at(20, "11:00"),
      },
      {
        id: "rd-2",
        credentialId: CLOUDFLARE,
        personId: "p-sara",
        roleId: null,
        addedById: "p-laura",
        addedAt: at(18, "15:30"),
      },
      {
        id: "rd-3",
        credentialId: STRIPE,
        personId: "p-laura",
        roleId: null,
        addedById: "p-matteo",
        addedAt: at(2, "09:40"),
      },
      {
        id: "rd-4",
        credentialId: FIGMA,
        personId: null,
        roleId: "role-contributor",
        addedById: "p-giulia",
        addedAt: at(9, "10:10"),
      },
    ],
    keys: [
      {
        personId: "p-laura",
        status: "confirmed",
        createdAt: at(40, "09:00"),
        device: "Safari on macOS",
        fingerprint: "3f9a 1c2e 07d4 91be",
        copies: [ARUBA, CLOUDFLARE],
      },
      {
        personId: "p-matteo",
        status: "confirmed",
        createdAt: at(40, "10:00"),
        device: "Chrome on macOS",
        fingerprint: "a41c 9e07 52bd 03f8",
        copies: [MAILGUN, STRIPE],
      },
      {
        personId: "p-marco",
        status: "pending",
        createdAt: at(1, "16:20"),
        device: "Chrome on macOS",
        fingerprint: "7d20 e5a9 c31f 6b84",
        copies: [],
      },
      {
        personId: "p-sara",
        status: "confirmed",
        createdAt: at(25, "12:00"),
        device: "Firefox on Windows",
        fingerprint: "c8e2 41fa 9d06 2b7c",
        copies: [CLOUDFLARE],
      },
      {
        personId: "p-giulia",
        status: "confirmed",
        createdAt: at(35, "08:30"),
        device: "Safari on macOS",
        fingerprint: "5b19 d04e a7c3 f812",
        copies: [FIGMA],
      },
      {
        personId: "p-roberta",
        status: "confirmed",
        createdAt: at(45, "08:00"),
        device: "Chrome on macOS",
        fingerprint: "e03d 7a5c 18b9 4f21",
        copies: [ARUBA, CLOUDFLARE, MAILGUN, STRIPE, FIGMA],
      },
    ],
    macs: [
      {
        id: "mac-laura-mbp",
        personId: "p-laura",
        name: "MacBook Pro di Laura",
        pairedAt: at(14, "09:05"),
        lastUsedAt: at(1, "17:40"),
        fingerprint: "91be 4c07 2a3f d6e5",
      },
      {
        id: "mac-laura-imac",
        personId: "p-laura",
        name: "iMac in ufficio",
        pairedAt: at(10, "08:50"),
        lastUsedAt: at(6, "11:20"),
        fingerprint: "0c6d b28e 73a1 5f94",
      },
      {
        id: "mac-matteo-mba",
        personId: "p-matteo",
        name: "MacBook Air di Matteo",
        pairedAt: at(8, "18:00"),
        lastUsedAt: at(3, "09:15"),
        fingerprint: "6e4a 13f0 c9b2 87d5",
      },
    ],
    log: [
      {
        id: "al-1",
        credentialId: ARUBA,
        projectId: "prj-acq",
        service: "Aruba hosting",
        personId: "p-laura",
        action: "shown",
        via: "mac",
        at: at(1, "17:40"),
      },
      {
        id: "al-2",
        credentialId: CLOUDFLARE,
        projectId: "prj-acq",
        service: "Cloudflare",
        personId: "p-sara",
        action: "copied",
        via: "browser",
        at: at(2, "10:05"),
      },
      {
        id: "al-3",
        credentialId: MAILGUN,
        projectId: "prj-acq",
        service: "Mailgun",
        personId: "p-matteo",
        action: "copied",
        via: "mac",
        at: at(3, "09:15"),
      },
    ],
    // Il Mac del prototipo: per Laura è il suo MacBook Pro, associato e chiuso.
    thisMac: new Map([
      [
        "p-laura",
        {
          macId: "mac-laura-mbp",
          open: false,
          freshlyPaired: false,
          revoked: false,
          pairing: null,
          unreachable: false,
        },
      ],
    ]),
    simulation: { touchId: "works", opening: "works" },
  };
}
