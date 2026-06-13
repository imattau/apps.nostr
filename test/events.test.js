import test from "node:test";
import assert from "node:assert/strict";

import { nip19 } from "nostr-tools";
import { parseNostrConnectURI } from "nostr-tools/nip46";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";

import { APP_STORE_TAG, buildMuteListEvent, buildNip89Event, buildReportEvent, isAppStoreListingEvent, isExpiredEvent, parseBlossomServerListEvent, parseMuteListEvent, parseNip89Event, parseProfileMetadataEvent, shouldReplaceCatalogEvent } from "../src/events.js";
import { compareBrowseApps, normalizeGridSize, normalizeSortOrder } from "../src/browse.js";
import { mergeSelectedFiles } from "../src/attachments.js";
import { toggleChoiceValue } from "../src/choices.js";
import { normalizeListingChoices, normalizeListingFormValues } from "../src/listing-form.js";
import { buildNostrConnectSession } from "../src/connect.js";
import { buildPasskeySignerShim, completePasskeySession, importPasskeyIdentityFromNsec, parseImportedSecretKey, restorePasskeySession } from "../src/passkey.js";
import { parseWalletConnection } from "../src/wallet.js";
import { buildZapRequestEvent, encodeLnurl, fetchLightningAddressMetadata, parseLightningAddress, requestZapInvoice } from "../src/zaps.js";

test("buildNip89Event maps the form into tags and content", () => {
  const event = buildNip89Event(
    {
      name: "My App",
      description: "Short summary",
      longDescription: "Long text",
      categories: ["tools", "social"],
      buildTypes: ["ios", "web"],
      image: "https://example.com/icon.png",
      thumbnail: "",
      web: "https://example.com",
      screenshots: ["https://example.com/1.png"],
      repository: "",
      license: "MIT",
      version: "1.0.0",
      authorName: "Alice",
      authorWebsite: "https://alice.example",
      lightningAddress: "alice@example.com",
    },
    "pubkey",
  );

  assert.equal(event.kind, 31922);
  assert.equal(event.tags.find((tag) => tag[0] === "name")[1], "My App");
  assert.equal(event.tags.find((tag) => tag[0] === "d")[1], "my-app");
  assert.ok(event.tags.some((tag) => tag[0] === "t" && tag[1] === APP_STORE_TAG));
  assert.deepEqual(
    event.tags.filter((tag) => tag[0] === "build").map((tag) => tag[1]),
    ["ios", "web"],
  );
  assert.match(event.content, /"authorName":"Alice"/);
});

test("buildNip89Event preserves existing screenshot sources", () => {
  const event = buildNip89Event(
    {
      name: "My App",
      description: "Short summary",
      longDescription: "Long text",
      categories: [],
      buildTypes: [],
      image: "https://example.com/icon.png",
      thumbnail: "",
      web: "https://example.com",
      screenshots: ["https://example.com/1.png"],
      screenshotSources: [["https://cdn1.example/1.png", "https://cdn2.example/1.png"]],
      imageSources: [],
      repository: "",
      license: "",
      version: "",
      authorName: "",
      authorWebsite: "",
      lightningAddress: "",
    },
    "pubkey",
  );

  assert.match(event.content, /"screenshotSources":\[\["https:\/\/cdn1\.example\/1\.png","https:\/\/cdn2\.example\/1\.png"\]\]/);
});

test("isAppStoreListingEvent only accepts scoped app listings", () => {
  assert.equal(isAppStoreListingEvent({ tags: [["t", APP_STORE_TAG]] }), true);
  assert.equal(isAppStoreListingEvent({ tags: [["t", "other"]] }), false);
});

test("parseNip89Event exposes structured fields", () => {
  const parsed = parseNip89Event({
    pubkey: "pub",
    created_at: 10,
    tags: [
      ["d", "slug"],
      ["name", "App"],
      ["description", "Summary"],
      ["t", "tools"],
      ["build", "android"],
    ],
    content: JSON.stringify({ longDescription: "Long", screenshots: ["https://x"], authorName: "Alice" }),
  });

  assert.equal(parsed.name, "App");
  assert.equal(parsed.longDescription, "Long");
  assert.deepEqual(parsed.screenshots, ["https://x"]);
  assert.deepEqual(parsed.categories, ["tools"]);
  assert.deepEqual(parsed.buildTypes, ["android"]);
});

test("isExpiredEvent respects expiration tags", () => {
  assert.equal(isExpiredEvent({ tags: [["expiration", "10"]] }, 20), true);
  assert.equal(isExpiredEvent({ tags: [["expiration", "30"]] }, 20), false);
});

test("buildReportEvent emits a NIP-56 report event", () => {
  const event = buildReportEvent({
    app: { name: "App", pubkey: "owner", id: "event-id", d: "slug" },
    signerPubkey: "signer",
    note: "bad content",
  });

  assert.equal(event.kind, 1984);
  assert.deepEqual(event.tags, [
    ["p", "owner", "other"],
    ["e", "event-id", "other"],
  ]);
  assert.equal(event.content, "bad content");
});

test("buildMuteListEvent merges new pubkeys and preserves other tags", () => {
  const event = buildMuteListEvent({
    signerPubkey: "signer",
    existingEvent: {
      content: "encrypted",
      tags: [
        ["t", "spam"],
        ["p", "old"],
        ["e", "thread"],
      ],
    },
    addPubkeys: ["new", "old"],
    removePubkeys: ["old"],
  });

  assert.equal(event.kind, 10000);
  assert.equal(event.content, "encrypted");
  assert.deepEqual(event.tags, [
    ["t", "spam"],
    ["e", "thread"],
    ["p", "new"],
  ]);
});

test("parseBlossomServerListEvent extracts server tags", () => {
  const parsed = parseBlossomServerListEvent({
    tags: [
      ["server", "https://one.example"],
      ["server", "https://two.example"],
    ],
  });

  assert.deepEqual(parsed.servers, ["https://one.example", "https://two.example"]);
});

test("parseMuteListEvent extracts blocked pubkeys", () => {
  const parsed = parseMuteListEvent({
    tags: [
      ["p", "pubkey-1"],
      ["p", "pubkey-2"],
      ["e", "event-id"],
      ["a", "31922:pubkey-3:slug"],
    ],
  });

  assert.deepEqual(parsed.pubkeys, ["pubkey-1", "pubkey-2"]);
  assert.deepEqual(parsed.eventIds, ["event-id"]);
  assert.deepEqual(parsed.addressRefs, ["31922:pubkey-3:slug"]);
});

test("parseProfileMetadataEvent extracts lud16 lightning addresses", () => {
  const parsed = parseProfileMetadataEvent({
    content: JSON.stringify({ name: "Alice", picture: "https://example.com/avatar.png", lud16: "alice@example.com" }),
  });

  assert.equal(parsed.lightningAddress, "alice@example.com");
  assert.equal(parsed.profileImageUrl, "https://example.com/avatar.png");
  assert.equal(parsed.profileName, "Alice");
});

test("parseLightningAddress resolves lightning addresses to lnurl pay URLs", () => {
  const parsed = parseLightningAddress("alice@example.com");

  assert.equal(parsed?.lnurlPayUrl, "https://example.com/.well-known/lnurlp/alice");
  assert.equal(encodeLnurl(parsed.lnurlPayUrl).startsWith("lnurl1"), true);
});

test("buildZapRequestEvent includes the target event and recipient", () => {
  const event = buildZapRequestEvent({
    senderPubkey: "sender",
    recipientPubkey: "recipient",
    recipientLnurl: "https://example.com/.well-known/lnurlp/alice",
    recipientRelays: ["wss://relay.example", "wss://relay.example"],
    event: { kind: 31922, pubkey: "recipient", id: "event-id", d: "slug" },
    amountMsats: 21000,
    content: "Nice app",
    now: 123,
  });

  assert.equal(event.kind, 9734);
  assert.equal(event.pubkey, "sender");
  assert.deepEqual(event.tags, [
    ["relays", "wss://relay.example"],
    ["amount", "21000"],
    ["lnurl", encodeLnurl("https://example.com/.well-known/lnurlp/alice")],
    ["p", "recipient"],
    ["e", "event-id"],
    ["a", "31922:recipient:slug"],
    ["k", "31922"],
  ]);
  assert.equal(event.content, "Nice app");
});

test("requestZapInvoice requests an invoice from the callback", async () => {
  const fetchCalls = [];
  const fetchImpl = async (url) => {
    fetchCalls.push(url);
    if (fetchCalls.length === 1) {
      return new Response(JSON.stringify({
        callback: "https://wallet.example/callback",
        minSendable: 1000,
        maxSendable: 1000000,
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({ pr: "lnbc1invoice" }), { status: 200, headers: { "content-type": "application/json" } });
  };

  const result = await requestZapInvoice({
    metadata: await fetchLightningAddressMetadata("alice@example.com", { fetchImpl }),
    senderPubkey: "sender",
    recipientPubkey: "recipient",
    event: { kind: 31922, pubkey: "recipient", id: "event-id", d: "slug" },
    recipientRelays: ["wss://relay.example"],
    amountMsats: 21000,
    fetchImpl,
  });

  assert.equal(result.invoice, "lnbc1invoice");
  assert.equal(fetchCalls.length, 2);
  assert.match(fetchCalls[1], /amount=21000/);
  assert.match(fetchCalls[1], /nostr=/);
  assert.match(fetchCalls[1], /lnurl=/);
});

test("buildNostrConnectSession generates a normalized nostrconnect URI", () => {
  const session = buildNostrConnectSession({
    relays: [" wss://relay.one.example ", "wss://relay.one.example", "wss://relay.two.example"],
    name: "Test App",
    url: "https://example.com",
    image: "https://example.com/icon.png",
    secret: "fixed-secret",
  });

  const parsed = parseNostrConnectURI(session.connectionUri);

  assert.equal(parsed.protocol, "nostrconnect");
  assert.deepEqual(parsed.params.relays, ["wss://relay.one.example", "wss://relay.two.example"]);
  assert.equal(parsed.params.secret, "fixed-secret");
  assert.equal(parsed.params.name, "Test App");
  assert.equal(parsed.params.url, "https://example.com");
  assert.equal(parsed.params.image, "https://example.com/icon.png");
  assert.deepEqual(session.relays, ["wss://relay.one.example", "wss://relay.two.example"]);
});

test("buildPasskeySignerShim signs events with the embedded secret key", async () => {
  const secretKey = generateSecretKey();
  const signer = buildPasskeySignerShim(secretKey);
  const pubkey = await signer.getPublicKey();
  const signed = await signer.signEvent({ kind: 1, created_at: 123, tags: [], content: "hello" });

  assert.equal(signer.__appsNostrPasskey, true);
  assert.equal(signed.pubkey, pubkey);
  assert.equal(signed.kind, 1);
  assert.equal(signed.content, "hello");
});

test("completePasskeySession keeps the secret key in memory only", async () => {
  const secretKey = generateSecretKey();
  const sessionStorage = {
    getItem: () => null,
    setItem: () => {
      throw new Error("sessionStorage should not be used");
    },
    removeItem: () => {
      throw new Error("sessionStorage should not be used");
    },
  };
  const original = globalThis.sessionStorage;

  try {
    Object.defineProperty(globalThis, "sessionStorage", {
      configurable: true,
      value: sessionStorage,
    });

    const session = await completePasskeySession(secretKey, getPublicKey(secretKey));

    assert.deepEqual(session.secretKey, secretKey);
    assert.equal(session.pubkey, getPublicKey(secretKey));
    assert.equal(typeof session.signer.signEvent, "function");
  } finally {
    Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: original });
  }
});

test("restorePasskeySession no longer rehydrates a stored secret", () => {
  const original = globalThis.sessionStorage;

  try {
    Object.defineProperty(globalThis, "sessionStorage", {
      configurable: true,
      value: {
        getItem: () => "deadbeef",
        setItem: () => {
          throw new Error("sessionStorage should not be used");
        },
        removeItem: () => {
          throw new Error("sessionStorage should not be used");
        },
      },
    });

    assert.equal(restorePasskeySession(), null);
  } finally {
    Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: original });
  }
});

test("parseImportedSecretKey accepts nsec and hex secret keys", () => {
  const secretKey = generateSecretKey();
  const nsec = nip19.nsecEncode(secretKey);

  assert.deepEqual(parseImportedSecretKey(nsec), secretKey);
  assert.deepEqual(parseImportedSecretKey("  " + Buffer.from(secretKey).toString("hex") + "  "), secretKey);
});

test("importPasskeyIdentityFromNsec stores the imported secret through the passkey enrollment flow", async () => {
  const secretKey = generateSecretKey();
  const nsec = nip19.nsecEncode(secretKey);
  const stored = new Map();
  const fakePrfKey = new Uint8Array(32).fill(7);
  const original = {
    window: globalThis.window,
    navigator: globalThis.navigator,
    localStorage: globalThis.localStorage,
    location: globalThis.location,
  };

  try {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { PublicKeyCredential: function PublicKeyCredential() {} },
    });
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: {
        credentials: {
          create: async () => ({
            rawId: new Uint8Array([1, 2, 3, 4]).buffer,
            getClientExtensionResults: () => ({ prf: { results: { first: fakePrfKey.buffer } } }),
          }),
          get: async () => {
            throw new Error("get() should not be called for import");
          },
        },
      },
    });
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem: (key) => stored.get(key) ?? null,
        setItem: (key, value) => {
          stored.set(key, value);
        },
        removeItem: (key) => {
          stored.delete(key);
        },
      },
    });
    Object.defineProperty(globalThis, "location", {
      configurable: true,
      value: { hostname: "example.com" },
    });

    const result = await importPasskeyIdentityFromNsec(nsec);

    assert.deepEqual(result.secretKey, secretKey);
    assert.equal(result.pubkey.length > 0, true);

    const record = JSON.parse(stored.get("apps.nostr:passkey-identity"));
    assert.equal(record.version, 1);
    assert.equal(record.pubkey, result.pubkey);
    assert.equal(typeof record.encryptedNsec, "string");
    assert.equal(typeof record.credentialId, "string");
  } finally {
    Object.defineProperty(globalThis, "window", { configurable: true, value: original.window });
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: original.navigator });
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: original.localStorage });
    Object.defineProperty(globalThis, "location", { configurable: true, value: original.location });
  }
});

test("parseWalletConnection accepts NWC connection strings", () => {
  const parsed = parseWalletConnection("nostr+walletconnect://walletpubkey?relay=wss%3A%2F%2Frelay.example&secret=wallet-secret");

  assert.equal(parsed.pubkey, "walletpubkey");
  assert.equal(parsed.relay, "wss://relay.example");
  assert.equal(parsed.secret, "wallet-secret");
});

test("toggleChoiceValue preserves multi-select limits for listings", () => {
  const categories = toggleChoiceValue(["tools", "social"], "writing", 3);
  const cappedCategories = toggleChoiceValue(categories, "finance", 3);
  const removedCategory = toggleChoiceValue(cappedCategories, "social", 3);

  const buildTypes = toggleChoiceValue(["web", "ios", "android"], "desktop", 4);
  const cappedBuildTypes = toggleChoiceValue(buildTypes, "tv", 4);
  const removedBuildType = toggleChoiceValue(cappedBuildTypes, "ios", 4);

  assert.deepEqual(categories, ["tools", "social", "writing"]);
  assert.deepEqual(cappedCategories, ["tools", "social", "writing"]);
  assert.deepEqual(removedCategory, ["tools", "writing"]);
  assert.deepEqual(buildTypes, ["web", "ios", "android", "desktop"]);
  assert.deepEqual(cappedBuildTypes, ["web", "ios", "android", "desktop"]);
  assert.deepEqual(removedBuildType, ["web", "android", "desktop"]);
});

test("mergeSelectedFiles appends new screenshot files without dropping existing ones", () => {
  const first = { name: "one.png", size: 1, type: "image/png", lastModified: 10 };
  const second = { name: "two.png", size: 2, type: "image/png", lastModified: 20 };
  const duplicate = { name: "one.png", size: 1, type: "image/png", lastModified: 10 };

  assert.deepEqual(mergeSelectedFiles([first], [second]), [first, second]);
  assert.deepEqual(mergeSelectedFiles([first], [duplicate]), [first]);
});

test("normalizeListingFormValues strips hidden app-store categories and dedupes selections", () => {
  const normalized = normalizeListingFormValues({
    categories: ["social", APP_STORE_TAG, "social", "reading"],
    buildTypes: ["web", "desktop", "web"],
  });

  assert.deepEqual(normalized.categories, ["social", "reading"]);
  assert.deepEqual(normalized.buildTypes, ["web", "desktop"]);
});

test("normalizeListingChoices keeps visible ordering while removing blocked values", () => {
  assert.deepEqual(normalizeListingChoices(["one", "two", "one", "three"], { exclude: ["two"] }), ["one", "three"]);
});

test("shouldReplaceCatalogEvent prefers newer replaceable events", () => {
  const older = { id: "old", created_at: 10 };
  const newer = { id: "new", created_at: 20 };
  const sameId = { id: "old", created_at: 5 };

  assert.equal(shouldReplaceCatalogEvent(older, newer), true);
  assert.equal(shouldReplaceCatalogEvent(newer, older), false);
  assert.equal(shouldReplaceCatalogEvent(older, sameId), true);
});

test("browse helpers normalize sort and grid options", () => {
  assert.equal(normalizeGridSize("small"), "small");
  assert.equal(normalizeGridSize("huge"), "medium");
  assert.equal(normalizeSortOrder("alpha"), "alpha");
  assert.equal(normalizeSortOrder("later"), "newest");
});

test("compareBrowseApps sorts alphabetically and by age", () => {
  const a = { name: "Bravo", publishedAt: 20 };
  const b = { name: "alpha", publishedAt: 10 };

  assert.equal(compareBrowseApps(a, b, "alpha") > 0, true);
  assert.equal(compareBrowseApps(a, b, "newest") < 0, true);
  assert.equal(compareBrowseApps(a, b, "oldest") > 0, true);
});
