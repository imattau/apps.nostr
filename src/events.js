import { clampText, getTagValue, getTagValues, safeJsonParse, slugify } from "./utils.js";

export const APP_STORE_TAG = "apps.nostr";

export function isExpiredEvent(event, now = Math.floor(Date.now() / 1000)) {
  const expiration = Number(getTagValue(event.tags || [], "expiration"));
  return Number.isFinite(expiration) && expiration > 0 && expiration <= now;
}

export function eventKey(event) {
  const d = getTagValue(event.tags || [], "d");
  return `${event.pubkey}:${d || ""}`;
}

export function shouldReplaceCatalogEvent(current, incoming) {
  if (!current) return true;
  if (!incoming) return false;
  if (current.id && incoming.id && current.id === incoming.id) return true;
  const currentCreated = Number(current.created_at || current.publishedAt || 0);
  const incomingCreated = Number(incoming.created_at || incoming.publishedAt || 0);
  return incomingCreated >= currentCreated;
}

export function deletionReferencesForEvent(event) {
  const refs = [];
  const d = getTagValue(event.tags || [], "d");
  if (d) refs.push(`31922:${event.pubkey}:${d}`);
  if (event.id) refs.push(event.id);
  return refs;
}

export function parseNip89Event(event) {
  const tags = event.tags || [];
  const content = safeJsonParse(event.content, {});
  const categories = getTagValues(tags, "t");
  const buildTypes = getTagValues(tags, "build");

  return {
    ...event,
    d: getTagValue(tags, "d") || "",
    name: getTagValue(tags, "name") || "Untitled app",
    description: getTagValue(tags, "description") || "",
    web: getTagValue(tags, "web") || "",
    image: getTagValue(tags, "image") || "",
    thumbnail: getTagValue(tags, "thumbnail") || "",
    publishedAt: Number(getTagValue(tags, "published_at") || event.created_at || 0),
    categories,
    buildTypes,
    version: getTagValue(tags, "version") || "",
    repository: getTagValue(tags, "repository") || "",
    license: getTagValue(tags, "license") || "",
    lightningAddress: getTagValue(tags, "lightning_address") || "",
    authorName: content.authorName || "",
    authorWebsite: content.authorWebsite || "",
    longDescription: content.longDescription || "",
    screenshots: Array.isArray(content.screenshots) ? content.screenshots.filter(Boolean) : [],
    imageSources: Array.isArray(content.imageSources) ? content.imageSources.filter(Boolean) : [],
    screenshotSources: Array.isArray(content.screenshotSources) ? content.screenshotSources.filter(Boolean) : [],
    price: content.price || null,
    rawContent: content,
    summary: clampText(getTagValue(tags, "description") || "", 160),
  };
}

export function isAppStoreListingEvent(event) {
  return getTagValues(event.tags || [], "t").includes(APP_STORE_TAG);
}

export function parseBlossomServerListEvent(event) {
  const tags = event.tags || [];
  return {
    ...event,
    servers: getTagValues(tags, "server").map((server) => String(server || "").trim()).filter(Boolean),
  };
}

export function parseMuteListEvent(event) {
  const tags = event.tags || [];
  return {
    ...event,
    pubkeys: getTagValues(tags, "p").map((pubkey) => String(pubkey || "").trim()).filter(Boolean),
    eventIds: getTagValues(tags, "e").map((eventId) => String(eventId || "").trim()).filter(Boolean),
    addressRefs: getTagValues(tags, "a").map((addressRef) => String(addressRef || "").trim()).filter(Boolean),
  };
}

export function parseProfileMetadataEvent(event) {
  const content = safeJsonParse(event?.content, {});
  return {
    ...event,
    profileName: String(content?.displayName || content?.name || "").trim(),
    profileImageUrl: String(content?.picture || content?.image || "").trim(),
    lightningAddress: String(content?.lud16 || "").trim(),
  };
}

export function buildMuteListEvent({
  signerPubkey,
  existingEvent = null,
  addPubkeys = [],
  removePubkeys = [],
  now = Math.floor(Date.now() / 1000),
}) {
  const removeSet = new Set(removePubkeys.map((pubkey) => String(pubkey || "").trim()).filter(Boolean));
  const nextPubkeys = [
    ...getTagValues(existingEvent?.tags || [], "p").map((pubkey) => String(pubkey || "").trim()).filter(Boolean).filter((pubkey) => !removeSet.has(pubkey)),
    ...addPubkeys.map((pubkey) => String(pubkey || "").trim()).filter(Boolean).filter((pubkey) => !removeSet.has(pubkey)),
  ];
  const tags = (existingEvent?.tags || []).filter((tag) => tag[0] !== "p");
  for (const pubkey of [...new Set(nextPubkeys)]) {
    tags.push(["p", pubkey]);
  }

  return {
    kind: 10000,
    pubkey: signerPubkey,
    created_at: now,
    tags,
    content: existingEvent?.content || "",
  };
}

export function buildNip89Event(form, pubkey, existing = null, now = Math.floor(Date.now() / 1000)) {
  const d = existing?.d || slugify(form.name);
  const tags = [
    ["d", d],
    ["name", form.name.trim()],
    ["description", form.description.trim()],
    ["web", form.web.trim()],
    ["published_at", String(now)],
  ];

  for (const category of form.categories || []) {
    tags.push(["t", category]);
  }

  for (const buildType of form.buildTypes || []) {
    tags.push(["build", buildType]);
  }

  tags.push(["t", APP_STORE_TAG]);

  if (form.image) tags.push(["image", form.image.trim()]);
  if (form.thumbnail) tags.push(["thumbnail", form.thumbnail.trim()]);
  if (form.version) tags.push(["version", form.version.trim()]);
  if (form.repository) tags.push(["repository", form.repository.trim()]);
  if (form.license) tags.push(["license", form.license.trim()]);
  if (form.lightningAddress) tags.push(["lightning_address", form.lightningAddress.trim()]);

  const content = {
    longDescription: form.longDescription.trim(),
    screenshots: (form.screenshots || []).map((value) => value.trim()).filter(Boolean),
    imageSources: (form.imageSources || []).map((value) => value.trim()).filter(Boolean),
    screenshotSources: (form.screenshotSources || []).map((values) => (Array.isArray(values) ? values.map((value) => String(value || "").trim()).filter(Boolean) : [])).filter((values) => values.length),
    authorName: form.authorName.trim(),
    authorWebsite: form.authorWebsite.trim(),
    price: form.price || undefined,
  };

  return {
    kind: 31922,
    pubkey,
    created_at: now,
    tags,
    content: JSON.stringify(content),
  };
}

export function buildReportEvent({ app, signerPubkey, note = "", reportType = "other", now = Math.floor(Date.now() / 1000) }) {
  return {
    kind: 1984,
    pubkey: signerPubkey,
    created_at: now,
    tags: [
      ["p", app.pubkey, reportType],
      ["e", app.id, reportType],
    ],
    content: String(note || "").trim(),
  };
}
