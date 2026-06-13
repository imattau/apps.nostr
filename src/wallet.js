import { kinds, nip04, nip47 } from "nostr-tools";
import { SimplePool } from "nostr-tools/pool";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";

import { bytesToHex } from "./utils.js";

export function parseWalletConnection(connectionString) {
  const cleaned = String(connectionString || "").trim();
  if (!cleaned) {
    throw new Error("Please provide a Nostr Wallet Connect string.");
  }
  return nip47.parseConnectionString(cleaned);
}

export async function payInvoiceWithNwc(connectionString, invoice, { timeoutMs = 15000 } = {}) {
  const connection = parseWalletConnection(connectionString);
  const clientSecretKey = generateSecretKey();
  const clientPubkey = getPublicKey(clientSecretKey);
  const requestEvent = await nip47.makeNwcRequestEvent(connection.pubkey, clientSecretKey, invoice);
  const pool = new SimplePool({ enablePing: true, enableReconnect: false });
  let subscription = null;

  try {
    const response = await new Promise((resolve, reject) => {
      let settled = false;
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        subscription?.close("wallet response timed out");
        pool.destroy();
        reject(new Error("The wallet did not respond in time."));
      }, timeoutMs);

      const finish = (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        subscription?.close("wallet response received");
        pool.destroy();
        resolve(value);
      };

      const fail = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        subscription?.close("wallet response failed");
        pool.destroy();
        reject(error);
      };

      subscription = pool.subscribe([connection.relay], {
        kinds: [kinds.NWCWalletResponse],
        "#p": [clientPubkey],
        since: Math.max(0, requestEvent.created_at - 5),
      }, {
        onevent: (event) => {
          try {
            if (!isNwcResponseForRequest(event, requestEvent.id)) return;
            const decoded = nip04.decrypt(bytesToHex(clientSecretKey), connection.pubkey, event.content);
            const payload = JSON.parse(decoded);
            if (isNwcErrorPayload(payload)) {
              throw new Error(payload.error.message || payload.error.reason || "The wallet rejected the payment.");
            }
            finish({ event, payload, requestEvent, clientPubkey, walletPubkey: connection.pubkey, relay: connection.relay });
          } catch (error) {
            fail(error instanceof Error ? error : new Error("Failed to decode the wallet response."));
          }
        },
        onclose: (reason) => {
          if (settled) return;
          fail(new Error(reason || "The wallet relay closed the request."));
        },
      });

      Promise.all(pool.publish([connection.relay], requestEvent)).catch((error) => {
        fail(error instanceof Error ? error : new Error("Failed to send the wallet request."));
      });
    });

    return response;
  } finally {
    subscription?.close("wallet request finished");
    pool.destroy();
  }
}

function isNwcResponseForRequest(event, requestId) {
  if (!event || event.kind !== kinds.NWCWalletResponse) return false;
  const responseTo = event.tags?.find((tag) => tag[0] === "e")?.[1];
  return !responseTo || responseTo === requestId;
}

function isNwcErrorPayload(payload) {
  if (!payload || typeof payload !== "object") return false;
  if (payload.error) return true;
  if (payload.result?.error) return true;
  if (payload.status && String(payload.status).toLowerCase() === "error") return true;
  return false;
}
