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
//                  all'interfaccia dell'app). Seconda revisione, I1: è una voce
//                  PERMANENTE del Keychain di data protection, col `tag` dato
//                  dal main e l'access group `<Team ID>.dev.aleloca.stubwise.vault`
//                  — la usano solo i binari firmati dal team con quel gruppo
//                  negli entitlements (prima era un `dataRepresentation` che
//                  qualunque binario poteva dare all'enclave). Risponde la
//                  pubblica x9.63 (65 byte).
// - `ecdh`       → il segreto condiviso con una pubblica x9.63 (la coordinata
//                  x, 32 byte, senza HKDF: HKDF e AES-GCM restano in
//                  `@stubwise/vault-crypto`, `openDeviceSeal` con `deriveBits`).
//                  Chiede il Touch ID ogni volta, con una frase FISSATA qui:
//                  la richiesta non la porta (chi lancia l'helper non sceglie
//                  il testo del prompt).
// - `delete`     → toglie la voce del `tag`.
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
  let tag: String?
  let peer: String?
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

/// Il Team ID dalla firma di QUESTO binario (mai dalla richiesta): senza, niente Keychain.
func teamID() -> String? {
  var code: SecCode?
  guard SecCodeCopySelf([], &code) == errSecSuccess, let code else { return nil }
  var staticCode: SecStaticCode?
  guard SecCodeCopyStaticCode(code, [], &staticCode) == errSecSuccess, let staticCode else {
    return nil
  }
  var info: CFDictionary?
  guard
    SecCodeCopySigningInformation(
      staticCode, SecCSFlags(rawValue: kSecCSSigningInformation), &info) == errSecSuccess,
    let dict = info as? [String: Any],
    let team = dict[kSecCodeInfoTeamIdentifier as String] as? String, !team.isEmpty
  else { return nil }
  return team
}

func accessGroup() -> String? { teamID().map { "\($0).dev.aleloca.stubwise.vault" } }

/// Il tag di una voce: quello che genera il main (`stubwise.vault.<32 hex>`).
func validTag(_ tag: String?) -> Data? {
  guard let tag, tag.range(of: "^stubwise\\.vault\\.[0-9a-f]{32}$", options: .regularExpression) != nil
  else { return nil }
  return Data(tag.utf8)
}

/// La frase del prompt del Touch ID: fissata qui, nella lingua del sistema.
func touchReason() -> String {
  let lang = Locale.preferredLanguages.first?.lowercased() ?? "en"
  return lang.hasPrefix("it") ? "aprire la cassaforte di Stubwise" : "open the Stubwise vault"
}

/// La query della voce: tag, gruppo, Keychain di data protection, nell'enclave.
func keyQuery(_ tag: Data, _ group: String) -> [String: Any] {
  [
    kSecClass as String: kSecClassKey,
    kSecAttrKeyClass as String: kSecAttrKeyClassPrivate,
    kSecAttrApplicationTag as String: tag,
    kSecAttrAccessGroup as String: group,
    kSecAttrTokenID as String: kSecAttrTokenIDSecureEnclave,
    kSecUseDataProtectionKeychain as String: true,
  ]
}

func errorOf(_ cfError: Unmanaged<CFError>?) -> Error {
  cfError?.takeRetainedValue() as Error? ?? NSError(domain: "stubwise", code: -1)
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
  guard let tag = validTag(request.tag) else { fail("invalid_request") }
  guard let group = accessGroup() else { fail("unsigned") }
  var cfError: Unmanaged<CFError>?
  guard
    let access = SecAccessControlCreateWithFlags(
      nil,
      kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
      [.privateKeyUsage, .biometryCurrentSet],
      &cfError
    )
  else { fail("access_control") }
  let attributes: [String: Any] = [
    kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
    kSecAttrKeySizeInBits as String: 256,
    kSecAttrTokenID as String: kSecAttrTokenIDSecureEnclave,
    kSecAttrAccessGroup as String: group,
    kSecUseDataProtectionKeychain as String: true,
    kSecPrivateKeyAttrs as String: [
      kSecAttrIsPermanent as String: true,
      kSecAttrApplicationTag as String: tag,
      kSecAttrAccessGroup as String: group,
      kSecAttrAccessControl as String: access,
    ] as [String: Any],
  ]
  guard let privateKey = SecKeyCreateRandomKey(attributes as CFDictionary, &cfError) else {
    fail(codeOf(errorOf(cfError)))
  }
  guard
    let publicKey = SecKeyCopyPublicKey(privateKey),
    let raw = SecKeyCopyExternalRepresentation(publicKey, &cfError) as Data?, raw.count == 65
  else { fail("public_key") }
  reply(["ok": true, "publicKey": raw.base64EncodedString()])

case "ecdh":
  guard SecureEnclave.isAvailable else { fail("no_secure_enclave") }
  guard
    let tag = validTag(request.tag),
    let peerData = request.peer.flatMap({ Data(base64Encoded: $0) }),
    peerData.count == 65
  else { fail("invalid_request") }
  guard let group = accessGroup() else { fail("unsigned") }
  let context = LAContext()
  context.localizedReason = touchReason()
  // Ogni uso chiede il tocco: nessun riuso di un'autenticazione recente.
  context.touchIDAuthenticationAllowableReuseDuration = 0
  var query = keyQuery(tag, group)
  query[kSecReturnRef as String] = true
  query[kSecUseAuthenticationContext as String] = context
  var found: CFTypeRef?
  let status = SecItemCopyMatching(query as CFDictionary, &found)
  if status == errSecItemNotFound { fail("key_not_found") }
  guard status == errSecSuccess, let found, CFGetTypeID(found) == SecKeyGetTypeID() else {
    fail("keychain")
  }
  let privateKey = found as! SecKey
  var cfError: Unmanaged<CFError>?
  guard
    let peer = SecKeyCreateWithData(
      peerData as CFData,
      [
        kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
        kSecAttrKeyClass as String: kSecAttrKeyClassPublic,
      ] as CFDictionary, &cfError)
  else { fail("invalid_request") }
  // `ecdhKeyExchangeStandard`: il segreto grezzo (la x), senza KDF.
  guard
    let secret = SecKeyCopyKeyExchangeResult(
      privateKey, .ecdhKeyExchangeStandard, peer, [:] as CFDictionary, &cfError) as Data?
  else { fail(codeOf(errorOf(cfError))) }
  guard secret.count == 32 else { fail("failed") }
  reply(["ok": true, "secret": secret.base64EncodedString()])

case "delete":
  guard let tag = validTag(request.tag) else { fail("invalid_request") }
  guard let group = accessGroup() else { fail("unsigned") }
  let status = SecItemDelete(keyQuery(tag, group) as CFDictionary)
  guard status == errSecSuccess || status == errSecItemNotFound else { fail("keychain") }
  reply(["ok": true])

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
