import { wrapActorChallenge } from "@stubwise/vault-crypto";

/**
 * Doppio di `POST /api/vault/actor-challenge` per i test della web: cifra un
 * segreto VERO per la chiave data (come il server) e ricorda le prove
 * attese, così un test verifica che il browser abbia aperto la sfida con la
 * SUA privata e mandato quella prova — non una qualsiasi.
 */
export function actorChallengeDouble(key: () => { personKeyId: string; publicKey: string }) {
  const issued = new Map<string, string>();

  function toB64Url(bytes: Uint8Array): string {
    return btoa(String.fromCharCode(...bytes))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
  }

  async function respond(): Promise<Response> {
    const { personKeyId, publicKey } = key();
    const challengeId = crypto.randomUUID();
    const secret = crypto.getRandomValues(new Uint8Array(32));
    issued.set(challengeId, toB64Url(secret));
    return new Response(
      JSON.stringify({
        challengeId,
        personKeyId,
        wrapped: await wrapActorChallenge(secret, publicKey, challengeId, personKeyId),
        expiresAt: "2026-10-23T12:05:00.000Z",
      }),
      { status: 201, headers: { "content-type": "application/json" } },
    );
  }

  /** La prova vale: sfida emessa qui, segreto giusto. */
  function valid(proof: unknown): boolean {
    const p = proof as { challengeId?: string; proof?: string } | undefined;
    return !!p?.challengeId && issued.get(p.challengeId) === p.proof;
  }

  return { respond, valid, issued };
}
