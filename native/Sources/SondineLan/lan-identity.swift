import CryptoKit
import Foundation
import Security

public struct LanIdentityError: Error, CustomStringConvertible {
    public let description: String
    init(_ description: String) { self.description = description }
}

/// The Mac's TLS identity (ADR 008, « Transport »): a P-256 key and a
/// self-signed certificate core made with `/usr/bin/openssl`, given as a
/// PKCS #12 file. It is imported into this process's memory only, never into
/// a keychain.
public struct LanIdentity: @unchecked Sendable {
    public let identity: SecIdentity
    /// SHA-256 of the public key's SubjectPublicKeyInfo (DER), lowercase hex:
    /// what the phone pins.
    public let pin: String

    /// The first 8 hex digits of the pin, advertised in the TXT record.
    public var pin8: String { String(pin.prefix(8)) }

    public static func load(p12 url: URL, passwordFile: URL) throws -> LanIdentity {
        let data: Data
        let passwordData: Data
        do {
            data = try Data(contentsOf: url)
            passwordData = try Data(contentsOf: passwordFile)
        } catch {
            throw LanIdentityError("cannot read the identity or its password file")
        }
        var password = String(decoding: passwordData, as: UTF8.self)
        while password.hasSuffix("\n") || password.hasSuffix("\r") { password.removeLast() }
        return try load(p12: data, password: password)
    }

    public static func load(p12 data: Data, password: String) throws -> LanIdentity {
        let options: [String: Any] = [
            kSecImportExportPassphrase as String: password,
            kSecImportToMemoryOnly as String: true,
        ]
        var items: CFArray?
        let status = SecPKCS12Import(data as CFData, options as CFDictionary, &items)
        guard status == errSecSuccess else {
            throw LanIdentityError(status == errSecAuthFailed ? "the identity's password is wrong" : "the identity cannot be read (OSStatus \(status))")
        }
        guard let entries = items as? [[String: Any]], let first = entries.first,
              let value = first[kSecImportItemIdentity as String],
              CFGetTypeID(value as CFTypeRef) == SecIdentityGetTypeID()
        else {
            // macOS pairs no key with the certificate when the P-256 key is
            // written in fewer than 32 bytes, as /usr/bin/openssl writes about
            // one key in 256: whoever makes the identity makes another then.
            throw LanIdentityError("the identity file holds no key paired with its certificate (a P-256 key written in fewer than 32 bytes is refused by macOS): make a new identity")
        }
        let identity = value as! SecIdentity
        var certificate: SecCertificate?
        guard SecIdentityCopyCertificate(identity, &certificate) == errSecSuccess, let certificate else {
            throw LanIdentityError("the identity has no certificate")
        }
        return LanIdentity(identity: identity, pin: try pin(of: certificate))
    }

    /// The pin of a certificate's public key: SHA-256 of its P-256
    /// SubjectPublicKeyInfo.
    public static func pin(of certificate: SecCertificate) throws -> String {
        guard let key = SecCertificateCopyKey(certificate),
              let attributes = SecKeyCopyAttributes(key) as? [String: Any],
              attributes[kSecAttrKeyType as String] as? String == kSecAttrKeyTypeECSECPrimeRandom as String,
              (attributes[kSecAttrKeySizeInBits as String] as? Int) == 256,
              let point = SecKeyCopyExternalRepresentation(key, nil) as Data?,
              point.count == 65
        else {
            throw LanIdentityError("the identity's key is not P-256")
        }
        return SHA256.hash(data: p256SpkiPrefix + point).map { String(format: "%02x", $0) }.joined()
    }

    /// SEQUENCE { SEQUENCE { id-ecPublicKey, prime256v1 }, BIT STRING (66 bytes) },
    /// followed by the uncompressed point.
    static let p256SpkiPrefix = Data([
        0x30, 0x59, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01,
        0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07, 0x03, 0x42, 0x00,
    ])
}
