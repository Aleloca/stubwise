// stubwise-keyhelper — la chiave del Mac nel Secure Enclave (revisione di
// sicurezza della cassaforte, I1; piano approvato da 46, 25 nov 2026).
//
// Un comando per esecuzione: una richiesta JSON su stdin, una risposta JSON
// su stdout. Lo chiama SOLO il processo main dell'app (`src/main/keyHelper.ts`),
// ed è firmato insieme all'app.
//
// - `available`  → c'è il Secure Enclave? c'è la biometria?
// - `create`     → una chiave P-256 di accordo NEL Secure Enclave, con il
//                  controllo d'accesso `privateKeyUsage` + `biometryCurrentSet`:
//                  non si esporta, e ogni uso chiede il Touch ID AL SISTEMA (non
//                  all'interfaccia dell'app). Risponde `dataRepresentation` (un
//                  blob opaco che solo l'enclave di questo Mac sa usare: il main
//                  lo tiene in `safeStorage`) e la pubblica x9.63 (65 byte).
// - `ecdh`       → il segreto condiviso con una pubblica x9.63 (la coordinata
//                  x, 32 byte, senza HKDF: HKDF e AES-GCM restano in
//                  `@stubwise/vault-crypto`, `openDeviceSeal` con `deriveBits`).
//                  Chiede il Touch ID con la frase `reason`, ogni volta.
// - `copy`       → la password negli appunti col tipo `org.nspasteboard.ConcealedType`
//                  e `TransientType` (M4: i gestori di appunti non la tengono).
// - `clear-if`   → svuota gli appunti SOLO se nessuno li ha cambiati dopo `copy`.
//
// Nessun segreto passa per argomenti o variabili d'ambiente: solo stdin.

import AppKit
import CryptoKit
import Foundation
import LocalAuthentication
import Security

struct Request: Decodable {
  let cmd: String
  let key: String?
  let peer: String?
  let reason: String?
  let text: String?
  let changeCount: Int?
}

func reply(_ object: [String: Any]) -> Never {
  let data = try! JSONSerialization.data(withJSONObject: object, options: [])
  FileHandle.standardOutput.write(data)
  exit(0)
}

func fail(_ code: String) -> Never { reply(["ok": false, "code": code]) }

/// Un errore della LocalAuthentication come codice stabile per il main.
func codeOf(_ error: Error) -> String {
  if let la = error as? LAError {
    switch la.code {
    case .userCancel, .appCancel, .systemCancel, .userFallback: return "cancelled"
    case .biometryNotAvailable, .biometryNotEnrolled: return "no_biometry"
    case .biometryLockout: return "lockout"
    default: return "auth_failed"
    }
  }
  let ns = error as NSError
  if ns.domain == LAErrorDomain { return "auth_failed" }
  return "failed"
}

let input = FileHandle.standardInput.readDataToEndOfFile()
guard let request = try? JSONDecoder().decode(Request.self, from: input) else { fail("invalid_request") }

switch request.cmd {
case "available":
  let context = LAContext()
  var error: NSError?
  let biometry = context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &error)
  reply(["ok": true, "secureEnclave": SecureEnclave.isAvailable, "biometry": biometry])

case "create":
  guard SecureEnclave.isAvailable else { fail("no_secure_enclave") }
  var cfError: Unmanaged<CFError>?
  guard
    let access = SecAccessControlCreateWithFlags(
      nil,
      kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
      [.privateKeyUsage, .biometryCurrentSet],
      &cfError
    )
  else { fail("access_control") }
  do {
    let key = try SecureEnclave.P256.KeyAgreement.PrivateKey(accessControl: access)
    reply([
      "ok": true,
      "key": key.dataRepresentation.base64EncodedString(),
      "publicKey": key.publicKey.x963Representation.base64EncodedString(),
    ])
  } catch {
    fail(codeOf(error))
  }

case "ecdh":
  guard SecureEnclave.isAvailable else { fail("no_secure_enclave") }
  guard
    let keyData = request.key.flatMap({ Data(base64Encoded: $0) }),
    let peerData = request.peer.flatMap({ Data(base64Encoded: $0) }),
    peerData.count == 65
  else { fail("invalid_request") }
  let context = LAContext()
  context.localizedReason = request.reason ?? "open the vault"
  // Ogni uso chiede il tocco: nessun riuso di un'autenticazione recente.
  context.touchIDAuthenticationAllowableReuseDuration = 0
  do {
    let key = try SecureEnclave.P256.KeyAgreement.PrivateKey(
      dataRepresentation: keyData, authenticationContext: context)
    let peer = try P256.KeyAgreement.PublicKey(x963Representation: peerData)
    let secret = try key.sharedSecretFromKeyAgreement(with: peer)
    let bytes = secret.withUnsafeBytes { Data($0) }
    reply(["ok": true, "secret": bytes.base64EncodedString()])
  } catch {
    fail(codeOf(error))
  }

case "copy":
  guard let text = request.text else { fail("invalid_request") }
  let board = NSPasteboard.general
  board.clearContents()
  let concealed = NSPasteboard.PasteboardType("org.nspasteboard.ConcealedType")
  let transient = NSPasteboard.PasteboardType("org.nspasteboard.TransientType")
  board.declareTypes([.string, concealed, transient], owner: nil)
  board.setString(text, forType: .string)
  board.setData(Data(), forType: concealed)
  board.setData(Data(), forType: transient)
  reply(["ok": true, "changeCount": board.changeCount])

case "clear-if":
  guard let expected = request.changeCount else { fail("invalid_request") }
  let board = NSPasteboard.general
  if board.changeCount == expected {
    board.clearContents()
    reply(["ok": true, "cleared": true])
  }
  reply(["ok": true, "cleared": false])

default:
  fail("unknown_command")
}
