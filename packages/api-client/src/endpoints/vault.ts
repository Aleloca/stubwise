import {
  credentialAccessLogResponseSchema,
  credentialItemSchema,
  credentialListResponseSchema,
  credentialProjectListResponseSchema,
  credentialReadersResponseSchema,
  vaultStatusResponseSchema,
} from "@stubwise/shared";
import type {
  CredentialAccessLogResponse,
  CredentialItem,
  CredentialListResponse,
  CredentialProjectListResponse,
  CredentialReadersResponse,
  CredentialUpdateBody,
  Reader,
  VaultStatusResponse,
} from "@stubwise/shared";
import type { ApiRequest } from "../client.js";
import { seg, toQuery } from "../query.js";

/**
 * La cassaforte vista dal client (25 nov 2026, il desktop): SOLO le letture
 * senza cifrati e le scritture in chiaro. Creare una credenziale, cambiarne
 * la password, `reveal`, condividere e confermare vogliono la chiave di
 * persona aperta, quindi stanno nel main del desktop (e nel browser), non
 * qui — chi le aggiunge a questo gruppo porta la chiave dove non deve stare.
 */
export function createVaultEndpoints(request: ApiRequest) {
  return {
    /**
     * `GET /api/vault/status`: attiva o no, e la propria chiave. Dal PAT
     * desktop anche senza sigillo (`desktopRead`): sigilli e passkey vuoti.
     * `myKey.publicKey` manca da un server di prima del 25 nov 2026.
     */
    status(): Promise<Reader<VaultStatusResponse>> {
      return request("GET", "/api/vault/status", undefined, vaultStatusResponseSchema);
    },
  };
}

/** Le credenziali: righe con `access`, `canEdit`, `canShare` calcolati dal SERVER. */
export function createCredentialsEndpoints(request: ApiRequest) {
  return {
    /** «Le mie»: lette o in attesa, in tutti i progetti visibili. */
    mine(): Promise<Reader<CredentialListResponse>> {
      return request("GET", "/api/vault/credentials", undefined, credentialListResponseSchema);
    },
    /**
     * Le credenziali di un progetto che chi guarda legge o gestisce, più
     * `canSeeLog` della sezione (l'entrata del registro, anche a elenco vuoto).
     */
    ofProject(projectId: string): Promise<Reader<CredentialProjectListResponse>> {
      return request("GET", `/api/projects/${seg(projectId)}/credentials`, undefined, credentialProjectListResponseSchema);
    },
    /** Il registro delle letture del progetto (`credentials.edit`/`share`), o di UNA credenziale. */
    log(projectId: string, options: { credentialId?: string; limit?: number } = {}): Promise<Reader<CredentialAccessLogResponse>> {
      return request(
        "GET",
        `/api/projects/${seg(projectId)}/credentials/log${toQuery({ credentialId: options.credentialId, limit: options.limit })}`,
        undefined,
        credentialAccessLogResponseSchema,
      );
    },
    /** Lettori diretti e stato dei lettori effettivi: nessuna copia della chiave. */
    readers(id: string): Promise<Reader<CredentialReadersResponse>> {
      return request("GET", `/api/credentials/${seg(id)}/readers`, undefined, credentialReadersResponseSchema);
    },
    /** I campi in chiaro; gli assenti restano, `null` svuota. */
    update(id: string, body: CredentialUpdateBody): Promise<Reader<CredentialItem>> {
      return request("PATCH", `/api/credentials/${seg(id)}`, body, credentialItemSchema);
    },
    /** Elimina la credenziale (il registro resta, con la fotografia in testo). */
    remove(id: string): Promise<void> {
      return request("DELETE", `/api/credentials/${seg(id)}`);
    },
  };
}
