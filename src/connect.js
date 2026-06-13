import { BunkerSigner, createNostrConnectURI } from "nostr-tools/nip46";
import { SimplePool } from "nostr-tools/pool";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";

import { DEFAULT_RELAYS } from "./config.js";
import { unique } from "./utils.js";

export function buildNostrConnectSession({
  relays = DEFAULT_RELAYS,
  name = "Nostr App Store",
  url = "",
  image = "",
  secret = createConnectSecret(),
} = {}) {
  const localSecretKey = generateSecretKey();
  const clientPubkey = getPublicKey(localSecretKey);
  const relayList = unique((relays || []).map((relay) => String(relay).trim()).filter(Boolean));
  const connectionUri = createNostrConnectURI({
    clientPubkey,
    relays: relayList.length ? relayList : DEFAULT_RELAYS,
    secret,
    name,
    url,
    image,
  });

  return {
    localSecretKey,
    clientPubkey,
    connectionUri,
    relays: relayList.length ? relayList : DEFAULT_RELAYS,
    pool: new SimplePool({ enablePing: true, enableReconnect: true }),
  };
}

export async function connectNostrConnectSigner(session, maxWaitMs = 120000) {
  if (!session?.localSecretKey || !session?.connectionUri || !session?.pool) {
    throw new Error("Missing Nostr Connect session.");
  }

  return BunkerSigner.fromURI(session.localSecretKey, session.connectionUri, { pool: session.pool }, maxWaitMs);
}

export function disposeNostrConnectSession(session) {
  try {
    session?.pool?.destroy?.();
  } catch {
    // ignore
  }
}

function createConnectSecret() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID().replace(/-/g, "");
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
