import { nip04, nip19, nip44 } from "nostr-tools";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";

import { bytesToHex, hexToBytes } from "./utils.js";

const STORAGE_KEY = "apps.nostr:passkey-identity";

const PRF_SALT = new Uint8Array([
  84, 12, 201, 9, 144, 233, 71, 188, 5, 99, 142, 60, 219, 31, 7, 250,
  128, 33, 176, 92, 14, 201, 88, 47, 163, 200, 19, 102, 58, 240, 6, 177,
]);

export function isPasskeySupported() {
  return (
    typeof window !== "undefined" &&
    Boolean(window.PublicKeyCredential) &&
    typeof navigator?.credentials?.create === "function" &&
    typeof navigator?.credentials?.get === "function"
  );
}

export function hasStoredPasskeyIdentity() {
  return readStoredRecord() !== null;
}

export function parseImportedSecretKey(input) {
  const cleaned = String(input || "").trim();
  if (!cleaned) {
    throw new Error("Please provide a Nostr secret key.");
  }
  if (/^[0-9a-fA-F]{64}$/.test(cleaned)) {
    return hexToBytes(cleaned);
  }

  const decoded = nip19.decode(cleaned);
  if (decoded.type === "nsec") {
    return decoded.data;
  }

  throw new Error("Please provide a valid nsec or 64-character hex secret key.");
}

export function clearPasskeyIdentity() {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}

export function clearPasskeySession() {
  // The unlocked secret key stays in memory only.
}

export function restorePasskeySession() {
  return null;
}

export async function registerPasskeyIdentity() {
  const { credentialId, prfKey } = await enrollPasskeyCredential();
  const secretKey = generateSecretKey();
  const pubkey = getPublicKey(secretKey);
  persistPasskeyIdentity({ credentialId, prfKey, secretKey, pubkey });
  return { secretKey, pubkey };
}

export async function importPasskeyIdentityFromNsec(nsec) {
  const secretKey = parseImportedSecretKey(nsec);
  const { credentialId, prfKey } = await enrollPasskeyCredential();
  const pubkey = getPublicKey(secretKey);
  persistPasskeyIdentity({ credentialId, prfKey, secretKey, pubkey });
  return { secretKey, pubkey };
}

export async function unlockPasskeyIdentity() {
  const record = readStoredRecord();
  if (!record) {
    throw new Error("No passkey identity found on this device.");
  }

  const credential = (await navigator.credentials.get({
    publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      allowCredentials: [{ id: base64UrlToArrayBuffer(record.credentialId), type: "public-key" }],
      userVerification: "required",
      extensions: { prf: { eval: { first: PRF_SALT } } },
    },
  })) || null;

  if (!credential) {
    throw new Error("Passkey unlock was cancelled.");
  }

  const prfResult = extractPrfResult(credential);
  if (!prfResult) {
    throw new Error("Passkey unlock failed: PRF extension result unavailable.");
  }

  const prfKey = await normalizePrfKey(prfResult);
  const nsecHex = nip44.decrypt(record.encryptedNsec, prfKey);
  const secretKey = hexToBytes(nsecHex);
  return { secretKey, pubkey: record.pubkey };
}

export async function completePasskeySession(secretKey, pubkey) {
  return {
    secretKey,
    pubkey,
    signer: buildPasskeySignerShim(secretKey),
  };
}

export function buildPasskeySignerShim(secretKey) {
  return {
    getPublicKey: async () => getPublicKey(secretKey),
    signEvent: async (template) => finalizeEvent(template, secretKey),
    nip04: {
      encrypt: async (pubkey, plaintext) => nip04.encrypt(secretKey, pubkey, plaintext),
      decrypt: async (pubkey, ciphertext) => nip04.decrypt(secretKey, pubkey, ciphertext),
    },
    nip44: {
      encrypt: async (pubkey, plaintext) => nip44.encrypt(secretKey, pubkey, plaintext),
      decrypt: async (pubkey, ciphertext) => nip44.decrypt(secretKey, pubkey, ciphertext),
    },
    __appsNostrPasskey: true,
  };
}

function readStoredRecord() {
  if (typeof window === "undefined") return null;
  let stored = null;
  try {
    stored = localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
  if (!stored) return null;
  try {
    const parsed = JSON.parse(stored);
    return isValidRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function persistPasskeyIdentity({ credentialId, prfKey, secretKey, pubkey }) {
  const encryptedNsec = nip44.encrypt(bytesToHex(secretKey), prfKey);
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        version: 1,
        credentialId,
        encryptedNsec,
        pubkey,
      }),
    );
  } catch {
    throw new Error("Passkey storage is unavailable in this browser.");
  }
}

function isValidRecord(value) {
  if (!value || typeof value !== "object") return false;
  const record = value;
  return (
    record.version === 1 &&
    typeof record.credentialId === "string" &&
    typeof record.encryptedNsec === "string" &&
    typeof record.pubkey === "string"
  );
}

async function enrollPasskeyCredential() {
  if (!isPasskeySupported()) {
    throw new Error("Passkeys are not supported in this browser.");
  }

  const credential = (await navigator.credentials.create({
    publicKey: {
      rp: { name: "Nostr App Store", id: location.hostname },
      user: {
        id: crypto.getRandomValues(new Uint8Array(16)),
        name: "apps.nostr-passkey",
        displayName: "Nostr App Store Identity",
      },
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      pubKeyCredParams: [
        { type: "public-key", alg: -7 },
        { type: "public-key", alg: -257 },
      ],
      authenticatorSelection: {
        residentKey: "preferred",
        userVerification: "required",
      },
      extensions: { prf: { eval: { first: PRF_SALT } } },
    },
  })) || null;

  if (!credential) {
    throw new Error("Passkey registration was cancelled.");
  }

  let prfResult = extractPrfResult(credential);
  if (!prfResult) {
    const assertion = (await navigator.credentials.get({
      publicKey: {
        challenge: crypto.getRandomValues(new Uint8Array(32)),
        allowCredentials: [{ id: credential.rawId, type: "public-key" }],
        userVerification: "required",
        extensions: { prf: { eval: { first: PRF_SALT } } },
      },
    })) || null;
    prfResult = assertion ? extractPrfResult(assertion) : undefined;
  }

  if (!prfResult) {
    throw new Error("This device does not support passkey-based encryption (PRF extension required).");
  }

  return {
    credentialId: arrayBufferToBase64Url(credential.rawId),
    prfKey: await normalizePrfKey(prfResult),
  };
}

async function normalizePrfKey(prfResult) {
  if (prfResult.byteLength === 32) {
    return new Uint8Array(prfResult);
  }
  const digest = await crypto.subtle.digest("SHA-256", prfResult);
  return new Uint8Array(digest);
}

function extractPrfResult(credential) {
  const extensions = credential.getClientExtensionResults();
  return extensions?.prf?.results?.first;
}

function arrayBufferToBase64Url(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return toBase64(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlToArrayBuffer(value) {
  const padded = String(value || "").replace(/-/g, "+").replace(/_/g, "/");
  const padding = padded.length % 4 === 0 ? "" : "=".repeat(4 - (padded.length % 4));
  const binary = fromBase64(padded + padding);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

function toBase64(binary) {
  if (typeof btoa === "function") {
    return btoa(binary);
  }
  return Buffer.from(binary, "binary").toString("base64");
}

function fromBase64(base64) {
  if (typeof atob === "function") {
    return atob(base64);
  }
  return Buffer.from(base64, "base64").toString("binary");
}
