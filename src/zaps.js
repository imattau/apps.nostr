import { bech32 } from "@scure/base";

export function parseLightningAddress(value) {
  const address = String(value || "").trim();
  if (!address) return null;
  if (/^https?:\/\//i.test(address)) {
    return {
      address,
      lnurlPayUrl: address,
    };
  }

  const atIndex = address.indexOf("@");
  if (atIndex <= 0 || atIndex === address.length - 1) return null;
  const localPart = address.slice(0, atIndex).trim();
  const domain = address.slice(atIndex + 1).trim();
  if (!localPart || !domain) return null;

  return {
    address,
    localPart,
    domain,
    lnurlPayUrl: `https://${domain.replace(/^https?:\/\//i, "")}/.well-known/lnurlp/${encodeURIComponent(localPart)}`,
  };
}

export function encodeLnurl(url) {
  return bech32.encode("lnurl", bech32.toWords(new TextEncoder().encode(String(url || ""))));
}

export async function fetchLightningAddressMetadata(lightningAddress, { fetchImpl = fetch } = {}) {
  const parsed = parseLightningAddress(lightningAddress);
  if (!parsed?.lnurlPayUrl) {
    throw new Error("Invalid lightning address.");
  }

  const response = await fetchImpl(parsed.lnurlPayUrl, {
    headers: {
      accept: "application/json",
    },
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(data?.reason || `Failed to load lightning address metadata (${response.status}).`);
  }
  if (data?.status === "ERROR") {
    throw new Error(data.reason || "Lightning address rejected the request.");
  }
  if (!data?.callback) {
    throw new Error("Lightning address metadata is missing a callback URL.");
  }

  return {
    ...data,
    lnurlPayUrl: parsed.lnurlPayUrl,
  };
}

export function buildZapRequestEvent({
  senderPubkey,
  recipientPubkey,
  recipientLnurl,
  recipientRelays = [],
  event,
  amountMsats,
  content = "",
  now = Math.floor(Date.now() / 1000),
}) {
  const msats = Number(amountMsats);
  if (!Number.isFinite(msats) || msats <= 0) {
    throw new Error("Zap amount must be a positive number of millisats.");
  }

  const tags = [];
  const relays = [...new Set((recipientRelays || []).map((relay) => String(relay || "").trim()).filter(Boolean))];
  if (relays.length) {
    tags.push(["relays", ...relays]);
  }
  tags.push(["amount", String(Math.round(msats))]);
  if (recipientLnurl) {
    tags.push(["lnurl", encodeLnurl(recipientLnurl)]);
  }
  tags.push(["p", recipientPubkey]);

  if (event?.id) {
    tags.push(["e", event.id]);
  }
  if (event?.pubkey && event?.d != null) {
    tags.push(["a", `${event.kind}:${event.pubkey}:${event.d}`]);
  }
  if (event?.kind != null) {
    tags.push(["k", String(event.kind)]);
  }

  return {
    kind: 9734,
    pubkey: senderPubkey,
    created_at: now,
    tags,
    content: String(content || "").trim(),
  };
}

export async function requestZapInvoice({
  metadata,
  senderPubkey,
  recipientPubkey,
  event,
  recipientRelays = [],
  amountMsats,
  content = "",
  fetchImpl = fetch,
}) {
  if (!metadata?.callback) {
    throw new Error("Lightning address metadata is missing a callback URL.");
  }

  const zapRequest = buildZapRequestEvent({
    senderPubkey,
    recipientPubkey,
    recipientLnurl: metadata.lnurlPayUrl,
    recipientRelays,
    event,
    amountMsats,
    content,
  });

  const callbackUrl = new URL(metadata.callback);
  callbackUrl.searchParams.set("amount", String(Math.round(Number(amountMsats))));
  callbackUrl.searchParams.set("nostr", JSON.stringify(zapRequest));
  callbackUrl.searchParams.set("lnurl", encodeLnurl(metadata.lnurlPayUrl));

  const response = await fetchImpl(callbackUrl.toString(), {
    headers: {
      accept: "application/json",
    },
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(data?.reason || `Failed to request a zap invoice (${response.status}).`);
  }
  if (!data?.pr) {
    throw new Error(data?.reason || "Lightning address did not return an invoice.");
  }

  return {
    invoice: data.pr,
    zapRequest,
    callbackUrl: callbackUrl.toString(),
    metadata,
  };
}
