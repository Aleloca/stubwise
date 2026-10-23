import { describe, expect, it } from "vitest";
import * as vault from "./index.js";

describe("@stubwise/vault-crypto", () => {
  it("espone esattamente l'API pubblica della cassaforte", () => {
    expect(Object.keys(vault).sort()).toEqual([
      "PRF_INPUT",
      "decryptPassword",
      "encryptForInsert",
      "encryptPassword",
      "generatePersonKeyPair",
      "generateRecoveryKit",
      "keyFingerprint",
      "openPrivateKey",
      "openRecoveryChallenge",
      "parseRecoveryKit",
      "resealPrivateKey",
      "sealPrivateKey",
      "unwrapItemKey",
      "wrapItemKey",
      "wrapRecoveryChallenge",
    ]);
  });
});
