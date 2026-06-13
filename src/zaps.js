const BECH32_CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";

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
  return encodeBech32("lnurl", new TextEncoder().encode(String(url || "")));
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

function encodeBech32(hrp, data) {
  const words = convertBits(data, 8, 5, true);
  const checksum = createChecksum(hrp, words);
  const combined = [...words, ...checksum];
  return `${hrp}1${combined.map((value) => BECH32_CHARSET[value]).join("")}`;
}

function createChecksum(hrp, data) {
  const values = [...hrpExpand(hrp), ...data, 0, 0, 0, 0, 0, 0];
  const mod = polymod(values) ^ 1;
  const checksum = [];
  for (let i = 0; i < 6; i += 1) {
    checksum.push((mod >> (5 * (5 - i))) & 31);
  }
  return checksum;
}

function hrpExpand(hrp) {
  const values = [];
  for (let i = 0; i < hrp.length; i += 1) {
    values.push(hrp.charCodeAt(i) >> 5);
  }
  values.push(0);
  for (let i = 0; i < hrp.length; i += 1) {
    values.push(hrp.charCodeAt(i) & 31);
  }
  return values;
}

function polymod(values) {
  let chk = 1;
  for (const value of values) {
    const top = chk >> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ value;
    if (top & 1) chk ^= 0x3b6a57b2;
    if (top & 2) chk ^= 0x26508e6d;
    if (top & 4) chk ^= 0x1ea119fa;
    if (top & 8) chk ^= 0x3d4233dd;
    if (top & 16) chk ^= 0x2a1462b3;
  }
  return chk;
}

function convertBits(data, fromBits, toBits, pad = true) {
  let acc = 0;
  let bits = 0;
  const result = [];
  const maxValue = (1 << toBits) - 1;
  for (const value of data) {
    if (value < 0 || value >> fromBits !== 0) {
      throw new Error("Invalid value when converting bech32 data.");
    }
    acc = (acc << fromBits) | value;
    bits += fromBits;
    while (bits >= toBits) {
      bits -= toBits;
      result.push((acc >> bits) & maxValue);
    }
  }
  if (pad) {
    if (bits > 0) {
      result.push((acc << (toBits - bits)) & maxValue);
    }
  } else if (bits >= fromBits || ((acc << (toBits - bits)) & maxValue)) {
    throw new Error("Invalid incomplete group in bech32 data.");
  }
  return result;
}
