import {
  CATEGORIES,
  DEFAULT_MEDIA_SERVERS,
  DEFAULT_RELAYS,
  BUILD_TYPES,
  STORAGE_KEYS,
} from "./config.js";
import { createEventCache } from "./cache.js";
import { mergeSelectedFiles } from "./attachments.js";
import { toggleChoiceValue } from "./choices.js";
import { normalizeListingFormValues } from "./listing-form.js";
import { GRID_SIZE_OPTIONS, compareBrowseApps, normalizeGridSize, normalizeSortOrder } from "./browse.js";
import { buildNostrConnectSession, connectNostrConnectSigner, disposeNostrConnectSession } from "./connect.js";
import { createNostrServices } from "./applesauce.js";
import { clearPasskeySession, completePasskeySession, hasStoredPasskeyIdentity, importPasskeyIdentityFromNsec, isPasskeySupported, registerPasskeyIdentity, restorePasskeySession, unlockPasskeyIdentity } from "./passkey.js";
import { APP_STORE_TAG, buildDeleteEvent, buildMuteListEvent, buildNip89Event, buildReportEvent, deletionReferencesForEvent, eventKey, isAppStoreListingEvent, isExpiredEvent, parseBlossomServerListEvent, parseMuteListEvent, parseNip89Event, parseProfileMetadataEvent, shouldReplaceCatalogEvent } from "./events.js";
import { isNip07Available, mineNonce, nostrEventHash } from "./nostr.js";
import { buildUploadServerTargets, prepareImageFileForUpload, uploadFileToServers } from "./uploads.js";
import { payInvoiceWithNwc } from "./wallet.js";
import { fetchLightningAddressMetadata, requestZapInvoice } from "./zaps.js";
import {
  clampText,
  escapeHtml,
  formatTimestamp,
  formatBytes,
  getTagValue,
  markdownToHtml,
  safeJsonParse,
  slugify,
  truncatePubkey,
  unique,
  websiteIconUrl,
} from "./utils.js";

const state = {
  route: getRoute(),
  relays: loadJson(STORAGE_KEYS.relays, DEFAULT_RELAYS),
  mediaServers: DEFAULT_MEDIA_SERVERS,
  selectedMediaServer: loadJson(STORAGE_KEYS.mediaServer, DEFAULT_MEDIA_SERVERS[0]),
  walletConnection: loadString(STORAGE_KEYS.walletConnection, ""),
  theme: loadTheme(),
  installAvailable: false,
  gridSize: normalizeGridSize(loadString(STORAGE_KEYS.gridSize, "medium"), "medium"),
  sortOrder: normalizeSortOrder(loadString(STORAGE_KEYS.sortOrder, "newest"), "newest"),
  settingsOpen: false,
  accountMenuOpen: false,
  connectHelpOpen: false,
  connectSession: null,
  connectError: "",
  passkeyImportNsec: "",
  browseFiltersOpen: !isCompactBrowseViewport(),
  buildFiltersOpen: !isCompactBrowseViewport(),
  filterText: "",
  filterCategory: "",
  filterBuildType: "",
  activeTab: "browse",
  apps: new Map(),
  deletions: new Set(),
  mediaServerEvents: new Map(),
  blockListEvents: new Map(),
  userMediaServers: [],
  blockedPubkeys: new Set(),
  profileLightningAddress: "",
  profileImageUrl: "",
  profileName: "",
  catalogWatermark: 0,
  loading: true,
  syncing: false,
  statusText: "Connecting relays…",
  selectedApp: null,
  submitError: "",
  submitSuccess: "",
  submitBusy: false,
  uploadBusy: false,
  uploadProgress: "",
  powBits: 0,
  manualUrls: false,
  lightbox: null,
  form: createEmptyForm(),
  signedJson: "",
  thumbnailAutoValue: "",
  imagePreviewUrl: "",
  screenshotPreviewUrls: [],
  signer: null,
  hasActiveAccount: false,
  accountType: "",
  pubkey: "",
  zapComposer: null,
  passkeyBusy: false,
};

applyTheme(state.theme);

const appRoot = document.getElementById("app");
let pool = null;
const eventCache = createEventCache();
let refreshLoop = null;
let refreshInFlight = null;
let installPromptEvent = null;
let compactHeaderViewport = isCompactBrowseViewport();

const CACHE_REFRESH_OVERLAP_SECONDS = 12 * 60 * 60;
const CACHE_REFRESH_INTERVAL_MS = 5 * 60 * 1000;
const SITE_NAME = "Nostr App Store";
const SITE_DESCRIPTION = "A decentralized Nostr app store for browsing and publishing NIP-89 listings.";
const DEFAULT_OG_IMAGE = new URL("/icon.svg", window.location.origin).href;

window.addEventListener("popstate", () => {
  state.route = getRoute();
  state.accountMenuOpen = false;
  routeSideEffects();
  scheduleRender();
});

window.addEventListener("hashchange", () => {
  state.route = getRoute();
  state.accountMenuOpen = false;
  routeSideEffects();
  scheduleRender();
});

document.addEventListener("click", handleDocumentNavigation, true);

window.addEventListener("storage", (event) => {
  if (event.key === STORAGE_KEYS.relays) {
    state.relays = loadJson(STORAGE_KEYS.relays, DEFAULT_RELAYS);
    pool.setRelays(state.relays);
    scheduleRender();
  }
  if (event.key === STORAGE_KEYS.walletConnection) {
    state.walletConnection = loadString(STORAGE_KEYS.walletConnection, "");
    scheduleRender();
  }
  if (event.key === STORAGE_KEYS.theme) {
    state.theme = loadTheme();
    applyTheme(state.theme);
    scheduleRender();
  }
  if (event.key === STORAGE_KEYS.gridSize) {
    state.gridSize = normalizeGridSize(loadString(STORAGE_KEYS.gridSize, "medium"), "medium");
    scheduleRender();
  }
  if (event.key === STORAGE_KEYS.sortOrder) {
    state.sortOrder = normalizeSortOrder(loadString(STORAGE_KEYS.sortOrder, "newest"), "newest");
    scheduleRender();
  }
});

window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  installPromptEvent = event;
  state.installAvailable = !isStandaloneApp();
  scheduleRender();
});

window.addEventListener("appinstalled", () => {
  installPromptEvent = null;
  state.installAvailable = false;
  scheduleRender();
});

window.addEventListener("resize", () => {
  const nextCompactHeaderViewport = isCompactBrowseViewport();
  if (nextCompactHeaderViewport !== compactHeaderViewport) {
    compactHeaderViewport = nextCompactHeaderViewport;
    scheduleRender();
  }
});

normalizeInitialLocation();

boot();

function boot() {
  restorePasskeyAccount();
  registerServiceWorker();
  normalizeInitialLocation();
  routeSideEffects();
  void initializeServices();
}

function restorePasskeyAccount() {
  const restored = restorePasskeySession();
  if (!restored) return;
  state.signer = restored.signer;
  state.hasActiveAccount = true;
  state.accountType = "passkey";
  state.pubkey = restored.pubkey;
  state.connectHelpOpen = false;
  state.statusText = `Passkey restored for ${truncatePubkey(restored.pubkey)}`;
}

function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  navigator.serviceWorker.register("/sw.js").catch(() => {
    // Ignore registration failures; the app still works without offline support.
  });
}

async function initializeServices() {
  const services = await createNostrServices(state.relays);
  pool = services;
  bindPoolEvents(pool);
  await hydrateCatalogFromCache();
  await connectSigner();
  pool.setRelays(state.relays);
  await pool.start();
  await refreshUploadServers();
  routeSideEffects();
  startBackgroundRefreshLoop();
  void refreshCatalog({ background: true });
  scheduleRender();
}

function bindPoolEvents(activePool) {
  activePool.onStatus(({ relayUrl, state: relayState }) => {
    const label = relayState?.ready ? "Ready" : relayState?.connected ? "Connected" : "Connecting";
    state.statusText = `${label} ${relayUrl}`;
    scheduleRender();
  });

  activePool.onEvent((_relayUrl, message) => {
    const [type, , event] = message;
    if (type !== "EVENT" || !event || event.kind == null) return;
    void ingestEvents([event], { persist: true });
    scheduleRender();
  });
}

async function connectSigner() {
  if (state.hasActiveAccount && state.signer) {
    await refreshProfileMetadata();
    await refreshUploadServers();
    return true;
  }
  if (isNip07Available() && pool?.connectExtensionAccount) {
    try {
      disposeNostrConnectSession(state.connectSession);
      state.connectSession = null;
      await pool.connectExtensionAccount();
      state.signer = pool.signer;
      state.hasActiveAccount = true;
      state.accountType = "extension";
      state.pubkey = await state.signer.getPublicKey();
      state.connectHelpOpen = false;
    } catch {
      state.pubkey = "";
      state.hasActiveAccount = false;
      state.accountType = "";
    }
    await refreshProfileMetadata();
    await refreshUploadServers();
    return state.hasActiveAccount;
  }
  state.signer = null;
  state.hasActiveAccount = false;
  state.mediaServerEvents = new Map();
  state.blockListEvents = new Map();
  state.userMediaServers = [];
  state.blockedPubkeys = new Set();
  state.profileLightningAddress = "";
  state.profileImageUrl = "";
  state.profileName = "";
  state.accountType = "";
  state.connectHelpOpen = true;
  state.statusText = "No Nostr signer detected on this device.";
  scheduleRender();
  return false;
}

async function connectWithNostrConnect() {
  if (state.connectSession?.promise) {
    state.connectHelpOpen = true;
    scheduleRender();
    return state.connectSession.promise;
  }

  if (state.connectSession) {
    disposeNostrConnectSession(state.connectSession);
    state.connectSession = null;
  }

  const session = buildNostrConnectSession({
    relays: state.relays.length ? state.relays : DEFAULT_RELAYS,
    name: "Nostr App Store",
    url: window.location.origin,
    image: window.location.origin ? `${window.location.origin}/favicon.ico` : "",
  });

  state.connectSession = {
    ...session,
    error: "",
    promise: null,
  };
  state.connectHelpOpen = true;
  state.statusText = "Waiting for a signer to approve the connection.";
  scheduleRender();

  const connectionPromise = (async () => {
    try {
      const signer = await connectNostrConnectSigner(session);
      if (state.connectSession?.connectionUri !== session.connectionUri) {
        return false;
      }
      state.signer = signer;
      state.hasActiveAccount = true;
      state.accountType = "nostrconnect";
      state.pubkey = await state.signer.getPublicKey();
      state.connectHelpOpen = false;
      state.connectSession = null;
      await refreshProfileMetadata();
      await refreshUploadServers();
      routeSideEffects();
      state.statusText = `Connected as ${truncatePubkey(state.pubkey)}`;
      scheduleRender();
      return true;
    } catch (error) {
      disposeNostrConnectSession(session);
      if (state.connectSession?.connectionUri === session.connectionUri) {
        state.connectSession = {
          ...session,
          error: error instanceof Error ? error.message : "Failed to connect with Nostr Connect.",
          promise: null,
        };
      }
      state.signer = null;
      state.hasActiveAccount = false;
      state.pubkey = "";
      state.statusText = state.connectSession?.error || "Failed to connect with Nostr Connect.";
      scheduleRender();
      return false;
    }
  })();

  state.connectSession.promise = connectionPromise;
  state.signer = null;
  state.hasActiveAccount = false;
  state.mediaServerEvents = new Map();
  state.blockListEvents = new Map();
  state.userMediaServers = [];
  state.blockedPubkeys = new Set();
  state.profileLightningAddress = "";
  state.profileImageUrl = "";
  state.profileName = "";
  state.connectHelpOpen = true;
  state.statusText = "Waiting for a signer connection.";
  scheduleRender();
  return connectionPromise;
}

async function connectWithPasskey() {
  if (!isPasskeySupported()) {
    state.connectError = "This browser does not support passkeys.";
    state.connectHelpOpen = true;
    scheduleRender();
    return false;
  }

  if (state.passkeyBusy) return false;
  state.passkeyBusy = true;
  state.connectError = "";
  scheduleRender();

  try {
    const importedNsec = state.passkeyImportNsec.trim();
    const credentials = importedNsec
      ? await importPasskeyIdentityFromNsec(importedNsec)
      : hasStoredPasskeyIdentity()
        ? await unlockPasskeyIdentity()
        : await registerPasskeyIdentity();
    const session = await completePasskeySession(credentials.secretKey, credentials.pubkey);
    state.signer = session.signer;
    state.hasActiveAccount = true;
    state.accountType = "passkey";
    state.pubkey = session.pubkey;
    state.connectHelpOpen = false;
    state.passkeyImportNsec = "";
    await refreshProfileMetadata();
    await refreshUploadServers();
    routeSideEffects();
    state.statusText = `Connected as ${truncatePubkey(state.pubkey)}`;
    scheduleRender();
    return true;
  } catch (error) {
    state.signer = null;
    state.hasActiveAccount = false;
    state.accountType = "";
    state.pubkey = "";
    state.connectHelpOpen = true;
    state.connectError = error instanceof Error ? error.message : "Failed to unlock the passkey.";
    state.statusText = state.connectError;
    scheduleRender();
    return false;
  } finally {
    state.passkeyBusy = false;
    scheduleRender();
  }
}

async function disconnectActiveAccount() {
  if (state.accountType === "nostrconnect" && typeof state.signer?.close === "function") {
    try {
      await state.signer.close();
    } catch {
      // ignore
    }
  }
  if (state.accountType === "passkey") {
    clearPasskeySession();
  }
  state.signer = null;
  state.hasActiveAccount = false;
  state.accountType = "";
  state.pubkey = "";
  state.mediaServerEvents = new Map();
  state.blockListEvents = new Map();
  state.userMediaServers = [];
  state.blockedPubkeys = new Set();
  state.profileLightningAddress = "";
  state.profileImageUrl = "";
  state.profileName = "";
  state.connectHelpOpen = true;
  state.connectError = "";
  state.passkeyImportNsec = "";
  state.statusText = "No Nostr signer detected on this device.";
  scheduleRender();
}

async function refreshCatalog({ background = false } = {}) {
  if (!pool || refreshInFlight) return refreshInFlight || Promise.resolve();
  refreshInFlight = (async () => {
    state.syncing = true;
    state.statusText = background ? "Syncing relays in the background…" : "Syncing relays…";
    scheduleRender();
    const since = Math.max(0, state.catalogWatermark - CACHE_REFRESH_OVERLAP_SECONDS);
    try {
      const [listings, deletions] = await Promise.all([
        pool.query({ kinds: [31922], "#t": [APP_STORE_TAG], since, limit: 500 }, 4500),
        pool.query({ kinds: [5], since, limit: 200 }, 2500),
      ]);
      const events = [...listings, ...deletions];
      await ingestEvents(events, { persist: true });
      state.statusText = `Synced ${events.length} relay event${events.length === 1 ? "" : "s"}`;
      await eventCache.saveMeta("catalogWatermark", state.catalogWatermark);
    } catch (error) {
      state.statusText = error instanceof Error ? error.message : "Relay sync failed.";
    } finally {
      state.syncing = false;
      refreshInFlight = null;
      scheduleRender();
    }
  })();
  return refreshInFlight;
}

function routeSideEffects() {
  const route = getRoute();
  state.route = route;
  if (route.name !== "detail") {
    state.zapComposer = null;
  }
  if (!pool) return;
  if (route.name === "submit") {
    loadOwnedApps();
  }
  if (route.name === "detail") {
    ensureDetailLoaded(route);
  }
}

async function loadOwnedApps() {
  if (!pool || !state.hasActiveAccount || !state.signer) return;
  try {
    state.pubkey = await state.signer.getPublicKey();
    await refreshProfileMetadata();
    const [listings, deletions] = await Promise.all([
      pool.query({ kinds: [31922], authors: [state.pubkey], "#t": [APP_STORE_TAG], limit: 100 }, 2500),
      pool.query({ kinds: [5], authors: [state.pubkey], limit: 50 }, 1500),
    ]);
    await ingestEvents([...listings, ...deletions], { persist: true });
    if (!state.form.pubkey && state.pubkey) {
      state.form.pubkey = state.pubkey;
    }
    scheduleRender();
  } catch {
    // ignore
  }
}

async function ensureDetailLoaded(route) {
  if (!pool) return;
  if (isBlockedPubkey(route.pubkey)) return;
  const key = `${route.pubkey}:${route.d}`;
  if (state.apps.has(key)) return;
  const [listings, deletions] = await Promise.all([
    pool.query({ kinds: [31922], authors: [route.pubkey], "#t": [APP_STORE_TAG], limit: 100 }, 2500),
    pool.query({ kinds: [5], authors: [route.pubkey], limit: 50 }, 1500),
  ]);
  await ingestEvents([...listings, ...deletions], { persist: true });
  scheduleRender();
}

async function hydrateCatalogFromCache() {
  try {
    const cachedEvents = await eventCache.loadEvents({ kinds: [31922, 5, 10000] });
    await ingestEvents(cachedEvents, { persist: false });
    const savedWatermark = await eventCache.loadMeta("catalogWatermark", 0);
    state.catalogWatermark = Math.max(state.catalogWatermark, Number(savedWatermark || 0));
    state.loading = false;
    state.statusText = cachedEvents.length
      ? `Loaded ${state.apps.size} cached app${state.apps.size === 1 ? "" : "s"}`
      : "No cached apps yet";
  } catch {
    state.loading = false;
    state.statusText = "Cache unavailable; syncing relays…";
  }
  scheduleRender();
}

async function refreshUploadServers() {
  if (!state.hasActiveAccount || !state.pubkey || !pool) {
    state.userMediaServers = [];
    state.blockListEvents = new Map();
    state.blockedPubkeys = new Set();
    return;
  }

  try {
    const cachedEvents = await eventCache.loadEvents({ kinds: [10063, 10000], authors: [state.pubkey] });
    await ingestEvents(cachedEvents, { persist: false });

    const [mediaServerEvents, muteListEvents] = await Promise.all([
      pool.query({ kinds: [10063], authors: [state.pubkey], limit: 10 }, 2500),
      pool.query({ kinds: [10000], authors: [state.pubkey], limit: 10 }, 2500),
    ]);
    const relayEvents = [...mediaServerEvents, ...muteListEvents];
    await ingestEvents(relayEvents, { persist: true });

    rebuildUserMediaServers();
    rebuildBlockedPubkeys();
    scheduleRender();
  } catch {
    rebuildUserMediaServers();
    rebuildBlockedPubkeys();
    scheduleRender();
  }
}

async function refreshProfileMetadata() {
  if (!pool || !state.hasActiveAccount || !state.pubkey) {
    state.profileLightningAddress = "";
    state.profileImageUrl = "";
    state.profileName = "";
    return;
  }

  try {
    const [cachedMetadata, remoteMetadata] = await Promise.all([
      eventCache.loadEvents({ kinds: [0], authors: [state.pubkey], limit: 1 }),
      pool.query({ kinds: [0], authors: [state.pubkey], limit: 1 }, 2500),
    ]);
    const metadataEvent = [...cachedMetadata, ...remoteMetadata]
      .filter(Boolean)
      .sort((a, b) => Number(b.created_at || 0) - Number(a.created_at || 0))[0];
    const parsed = metadataEvent ? parseProfileMetadataEvent(metadataEvent) : null;
    state.profileLightningAddress = parsed?.lightningAddress || "";
    state.profileImageUrl = parsed?.profileImageUrl || "";
    state.profileName = parsed?.profileName || "";
    if (!state.form.lightningAddress && state.profileLightningAddress) {
      state.form.lightningAddress = state.profileLightningAddress;
    }
    scheduleRender();
  } catch {
    state.profileLightningAddress = "";
    state.profileImageUrl = "";
    state.profileName = "";
  }
}

function startBackgroundRefreshLoop() {
  if (refreshLoop) return;
  refreshLoop = window.setInterval(() => {
    void refreshCatalog({ background: true });
    if (state.hasActiveAccount && state.pubkey) {
      void refreshUploadServers();
    }
  }, CACHE_REFRESH_INTERVAL_MS);
}

async function ingestEvents(events, { persist = false } = {}) {
  const payload = [];
  for (const event of events || []) {
    if (!event || event.kind == null) continue;
    payload.push(event);
    if (event.created_at) {
      state.catalogWatermark = Math.max(state.catalogWatermark, Number(event.created_at) || 0);
    }
    if (event.kind === 31922) {
      if (isExpiredEvent(event)) continue;
      if (!isAppStoreListingEvent(event)) continue;
      const parsed = parseNip89Event(event);
      const key = eventKey(parsed);
      const current = state.apps.get(key);
      if (shouldReplaceCatalogEvent(current, parsed)) {
        state.apps.set(key, parsed);
      }
      continue;
    }
    if (event.kind === 10063 && event.pubkey === state.pubkey) {
      const current = state.mediaServerEvents.get(event.pubkey);
      if (shouldReplaceCatalogEvent(current, event)) {
        state.mediaServerEvents.set(event.pubkey, event);
      }
      continue;
    }
    if (event.kind === 10000 && event.pubkey === state.pubkey) {
      const current = state.blockListEvents.get(event.pubkey);
      if (shouldReplaceCatalogEvent(current, event)) {
        state.blockListEvents.set(event.pubkey, event);
      }
      continue;
    }
    if (event.kind === 5) {
      for (const tag of event.tags || []) {
        if (tag[0] === "e" && tag[1]) state.deletions.add(tag[1]);
        if (tag[0] === "a" && tag[1]) state.deletions.add(tag[1]);
      }
    }
  }
  if (persist && payload.length) {
    await eventCache.upsertEvents(payload);
    await eventCache.saveMeta("catalogWatermark", state.catalogWatermark);
  }
  rebuildUserMediaServers();
  rebuildBlockedPubkeys();
}

function rebuildUserMediaServers() {
  const serverEvent = state.mediaServerEvents.get(state.pubkey);
  const parsed = serverEvent ? parseBlossomServerListEvent(serverEvent) : null;
  state.userMediaServers = (parsed?.servers || []).map((serverUrl) => ({
    name: serverUrl,
    type: "blossom",
    baseUrl: serverUrl,
    uploadUrl: `${serverUrl.replace(/\/+$/, "")}/upload`,
    }));
}

function rebuildBlockedPubkeys() {
  const muteEvent = state.blockListEvents.get(state.pubkey);
  const parsed = muteEvent ? parseMuteListEvent(muteEvent) : null;
  state.blockedPubkeys = new Set(parsed?.pubkeys || []);
}

function isBlockedPubkey(pubkey) {
  return state.blockedPubkeys.has(pubkey);
}

function scheduleRender() {
  window.clearTimeout(scheduleRender.timer);
  scheduleRender.timer = window.setTimeout(render, 16);
}

function render() {
  const focusState = captureFocusState();
  updateSeoMetadata();
  appRoot.innerHTML = `
    <div class="page-shell">
      ${renderHeader()}
      <main class="page-main">
        ${renderMain()}
      </main>
      ${renderLightbox()}
    </div>
  `;
  bindUi();
  restoreFocusState(focusState);
}

function captureFocusState() {
  const activeElement = document.activeElement;
  if (!activeElement || !appRoot.contains(activeElement)) return null;
  const name = activeElement.getAttribute("name");
  if (!name) return null;
  return {
    name,
    value: "value" in activeElement ? activeElement.value : "",
    selectionStart: typeof activeElement.selectionStart === "number" ? activeElement.selectionStart : null,
    selectionEnd: typeof activeElement.selectionEnd === "number" ? activeElement.selectionEnd : null,
  };
}

function restoreFocusState(focusState) {
  if (!focusState?.name) return;
  const nextElement = appRoot.querySelector(`[name="${CSS.escape(focusState.name)}"]`);
  if (!nextElement) return;
  if ("value" in nextElement && nextElement.value !== focusState.value) {
    nextElement.value = focusState.value;
  }
  nextElement.focus({ preventScroll: true });
  if (
    typeof nextElement.setSelectionRange === "function" &&
    focusState.selectionStart != null &&
    focusState.selectionEnd != null
  ) {
    nextElement.setSelectionRange(focusState.selectionStart, focusState.selectionEnd);
  }
}

function renderHeader() {
  const active = state.route.name;
  const compactHeader = isCompactBrowseViewport();
  const storedPasskeyAvailable = hasStoredPasskeyIdentity();
  return `
    <header class="topbar">
      <a class="brand" href="${escapeHtml(routeToPath({ name: "browse" }))}">
        <span class="brand-mark">◌</span>
        <span>
          <strong>Nostr App Store</strong>
          <small>${escapeHtml(state.statusText)}</small>
        </span>
      </a>
      <nav class="nav">
        ${compactHeader
          ? renderAccountMenu({ compact: true, storedPasskeyAvailable })
          : `
            ${renderNavLink(routeToPath({ name: "browse" }), "Browse", renderBrowseIcon(), active === "browse")}
            ${renderNavLink(routeToPath({ name: "submit" }), "Submit", renderSubmitIcon(), active === "submit")}
            ${state.hasActiveAccount ? "" : renderLabeledButton("primary", storedPasskeyAvailable ? "connect-passkey" : "connect-account", storedPasskeyAvailable ? "Unlock passkey" : "Connect", renderConnectIcon())}
            ${state.hasActiveAccount ? renderAccountMenu({ compact: false, storedPasskeyAvailable }) : ""}
            <button
              class="ghost theme-toggle"
              type="button"
              data-action="toggle-theme"
              aria-label="Switch to ${state.theme === "dark" ? "light" : "dark"} theme"
              title="Switch theme"
            >
              ${renderThemeIcon(state.theme)}
            </button>
          `}
      </nav>
    </header>
    ${state.connectHelpOpen && !state.hasActiveAccount ? renderConnectHelpPanel() : ""}
    ${state.settingsOpen ? renderSettingsPanel() : ""}
  `;
}

function renderConnectHelpPanel() {
  const session = state.connectSession;
  const passkeySupported = isPasskeySupported();
  const storedPasskeyAvailable = hasStoredPasskeyIdentity();
  const hasImportValue = Boolean(state.passkeyImportNsec.trim());
  const passkeyLabel = hasImportValue
    ? "Import existing key"
    : storedPasskeyAvailable
      ? "Unlock passkey"
      : "Create passkey";
  return `
    <section class="panel connect-panel">
      <div>
        <p class="eyebrow">Connect signer</p>
        <h2>${session ? "Approve the Nostr Connect request." : storedPasskeyAvailable ? "Unlock your passkey." : "Choose a login method."}</h2>
        <p>
          ${session
            ? "Open the signer app or share the connection link below. The app is waiting for the remote signer to approve the request."
            : storedPasskeyAvailable
              ? "A passkey identity is already stored on this device. Unlock it to continue, or replace it by importing a different nsec."
              : "Use Nostr Connect if you already have a remote signer, or use a passkey to unlock an identity stored on this device."}
        </p>
        ${session ? `
          <div class="connect-status">
            <span>${escapeHtml(session.relays.length)} relay${session.relays.length === 1 ? "" : "s"}</span>
            <span>Waiting for approval</span>
          </div>
        ` : ""}
        ${state.connectError ? `<p class="error">${escapeHtml(state.connectError)}</p>` : ""}
      </div>
      ${session ? `
        <label class="connect-link-field">
          <span>Nostr Connect link</span>
          <input name="connect-uri" type="text" readonly value="${escapeHtml(session.connectionUri)}" />
        </label>
        ${session.error ? `<p class="error">${escapeHtml(session.error)}</p>` : ""}
        <div class="actions connect-actions">
          ${renderLabeledLink("primary", session.connectionUri, "Open signer app", renderOpenIcon())}
          <button class="ghost" type="button" data-action="copy-connect-uri">Copy link</button>
          ${typeof navigator !== "undefined" && typeof navigator.share === "function" ? `<button class="ghost" type="button" data-action="share-connect-uri">Share link</button>` : ""}
          <button class="ghost" type="button" data-action="reset-connect-session">Start over</button>
          <button class="ghost" type="button" data-action="dismiss-connect-help">Close</button>
        </div>
      ` : `
        ${storedPasskeyAvailable
          ? renderStoredPasskeyCard({ passkeySupported, passkeyLabel })
          : renderConnectOptions({ passkeySupported, passkeyLabel })}
        <div class="actions connect-actions connect-footer-actions">
          <button class="ghost" type="button" data-action="dismiss-connect-help">Close</button>
        </div>
      `}
    </section>
  `;
}

function renderStoredPasskeyCard({ passkeySupported, passkeyLabel }) {
  return `
    <section class="connect-method-card">
      <div>
        <p class="eyebrow">Passkey</p>
        <p class="connect-import-copy">Unlock the passkey identity already stored on this device. You can replace it by importing a different nsec if needed.</p>
      </div>
      ${passkeySupported ? `
        <label class="connect-link-field">
          <span>Existing nsec</span>
          <input
            name="passkey-import-nsec"
            type="password"
            autocomplete="off"
            spellcheck="false"
            placeholder="nsec1… or 64 hex chars"
            value="${escapeHtml(state.passkeyImportNsec)}"
          />
        </label>
      ` : `<p class="connect-import-copy">This browser does not support passkeys.</p>`}
      <div class="actions connect-actions">
        ${passkeySupported ? `<button class="ghost" type="button" data-action="connect-passkey" ${state.passkeyBusy ? "disabled" : ""}>${state.passkeyBusy ? "Opening…" : passkeyLabel}</button>` : ""}
      </div>
    </section>
  `;
}

function renderConnectOptions({ passkeySupported, passkeyLabel }) {
  return `
    <div class="connect-options">
      <section class="connect-method-card">
        <div>
          <p class="eyebrow">Nostr Connect</p>
          <p class="connect-import-copy">Connect to a remote signer such as a wallet or extension that approves requests outside this app.</p>
        </div>
        <div class="actions connect-actions">
          <button class="primary" type="button" data-action="connect-account">Start Nostr Connect</button>
        </div>
      </section>
      <section class="connect-method-card">
        <div>
          <p class="eyebrow">Passkey</p>
          <p class="connect-import-copy">Use a passkey stored on this device to unlock your local Nostr identity. You can also import an existing nsec to bind it to a passkey here.</p>
        </div>
        ${passkeySupported ? `
          <label class="connect-link-field">
            <span>Existing nsec</span>
            <input
              name="passkey-import-nsec"
              type="password"
              autocomplete="off"
              spellcheck="false"
              placeholder="nsec1… or 64 hex chars"
              value="${escapeHtml(state.passkeyImportNsec)}"
            />
          </label>
        ` : `<p class="connect-import-copy">This browser does not support passkeys.</p>`}
        <div class="actions connect-actions">
          ${passkeySupported ? `<button class="ghost" type="button" data-action="connect-passkey" ${state.passkeyBusy ? "disabled" : ""}>${state.passkeyBusy ? "Opening…" : passkeyLabel}</button>` : ""}
        </div>
      </section>
    </div>
  `;
}

function renderAccountMenu({ compact = false, storedPasskeyAvailable = false } = {}) {
  const menuOpen = state.accountMenuOpen;
  const avatarLabel = (state.profileName || truncatePubkey(state.pubkey || "account", 8)).slice(0, 2).toUpperCase() || "U";
  const installItem = state.installAvailable && !isStandaloneApp()
    ? `
      <button class="menu-item" type="button" data-action="install-app">
        <span class="menu-item-icon" aria-hidden="true">${renderInstallIcon()}</span>
        <span class="menu-item-label">Install app</span>
      </button>
    `
    : "";
  const connectLabel = storedPasskeyAvailable ? "Unlock passkey" : "Connect";
  const connectAction = storedPasskeyAvailable ? "connect-passkey" : "connect-account";
  const connectIcon = renderConnectIcon();
  const browseItem = compact
    ? `<a class="menu-item" href="${escapeHtml(routeToPath({ name: "browse" }))}"><span class="menu-item-icon" aria-hidden="true">${renderBrowseIcon()}</span><span class="menu-item-label">Browse</span></a>`
    : "";
  const submitItem = compact
    ? `<a class="menu-item" href="${escapeHtml(routeToPath({ name: "submit" }))}"><span class="menu-item-icon" aria-hidden="true">${renderSubmitIcon()}</span><span class="menu-item-label">Submit</span></a>`
    : "";
  const connectItem = compact && !state.hasActiveAccount
    ? `
      <button class="menu-item" type="button" data-action="${connectAction}">
        <span class="menu-item-icon" aria-hidden="true">${connectIcon}</span>
        <span class="menu-item-label">${escapeHtml(connectLabel)}</span>
      </button>
    `
    : "";
  const themeItem = compact
    ? `
      <button class="menu-item" type="button" data-action="toggle-theme">
        <span class="menu-item-icon" aria-hidden="true">${renderThemeIcon(state.theme)}</span>
        <span class="menu-item-label">Theme</span>
      </button>
    `
    : "";
  const settingsItem = compact
    ? `
      <button class="menu-item" type="button" data-action="toggle-settings">
        <span class="menu-item-icon" aria-hidden="true">${renderRelayIcon()}</span>
        <span class="menu-item-label">Relay settings</span>
      </button>
    `
    : "";
  const walletItem = `
    <button class="menu-item" type="button" data-action="open-settings">
      <span class="menu-item-icon" aria-hidden="true">${renderWalletIcon()}</span>
      <span class="menu-item-label">Wallet</span>
    </button>
  `;
  const refreshItem = `
    <button class="menu-item" type="button" data-action="refresh-relays" ${state.syncing ? "disabled" : ""}>
      <span class="menu-item-icon ${state.syncing ? "spinning" : ""}" aria-hidden="true">${renderRefreshIcon()}</span>
      <span class="menu-item-label">${state.syncing ? "Refreshing..." : "Refresh relays"}</span>
    </button>
  `;
  const disconnectItem = compact && state.hasActiveAccount
    ? `<button class="menu-item" type="button" data-action="disconnect-account" aria-label="${state.accountType === "passkey" ? "Lock passkey" : "Log out"}"><span class="menu-item-icon" aria-hidden="true">${renderDisconnectIcon()}</span><span class="menu-item-label">${state.accountType === "passkey" ? "Lock passkey" : "Log out"}</span></button>`
    : "";
  const navSection = compact ? `
    <div class="menu-section">
      <p class="menu-section-label">Navigate</p>
      ${browseItem}
      ${submitItem}
    </div>
  ` : "";
  const accountSection = compact ? `
    <div class="menu-section">
      <p class="menu-section-label">Account</p>
      ${connectItem}
      ${disconnectItem}
    </div>
  ` : "";
  const utilitySection = compact
    ? `
      <div class="menu-section">
        <p class="menu-section-label">Tools</p>
        ${walletItem}
        ${refreshItem}
        ${themeItem}
        ${settingsItem}
        ${installItem}
      </div>
    `
    : "";
  return `
    <div class="account-menu ${compact ? "compact " : ""}${menuOpen ? "open" : ""}">
      <button
        class="account-avatar ${compact ? "header-menu-toggle" : ""}"
        type="button"
        data-action="toggle-account-menu"
        aria-haspopup="menu"
        aria-expanded="${menuOpen ? "true" : "false"}"
        aria-label="${compact ? "Header menu" : "Account menu"}"
        title="${compact ? "Header menu" : "Account menu"}"
      >
        <span class="account-avatar-graphic" aria-hidden="true">
          ${compact && !state.hasActiveAccount
            ? `<span>${renderMenuIcon()}</span>`
            : state.profileImageUrl
            ? `<img src="${escapeHtml(state.profileImageUrl)}" alt="" />`
            : `<span>${escapeHtml(avatarLabel)}</span>`}
        </span>
        <span class="account-avatar-label">${escapeHtml(compact ? (state.hasActiveAccount ? state.profileName || "Account" : "Menu") : state.profileName || "Account")}</span>
      </button>
      <div class="account-menu-panel" role="menu" aria-label="Account actions">
        ${compact ? navSection : browseItem}
        ${compact ? `<div class="menu-divider" aria-hidden="true"></div>` : ""}
        ${compact ? accountSection : connectItem}
        ${compact ? `<div class="menu-divider" aria-hidden="true"></div>` : ""}
        ${compact ? utilitySection : `
          <div class="menu-section">
            ${walletItem}
            ${refreshItem}
            <button class="menu-item" type="button" data-action="toggle-settings">
              <span class="menu-item-icon" aria-hidden="true">${renderRelayIcon()}</span>
              <span class="menu-item-label">Relay settings</span>
            </button>
          </div>
        `}
        ${!compact ? `
          <button class="menu-item" type="button" data-action="disconnect-account" aria-label="${state.accountType === "passkey" ? "Lock passkey" : "Log out"}">
            <span class="menu-item-icon" aria-hidden="true">${renderDisconnectIcon()}</span>
            <span class="menu-item-label">${state.accountType === "passkey" ? "Lock passkey" : "Log out"}</span>
          </button>
          ${installItem}
        ` : ""}
      </div>
    </div>
  `;
}

function renderThemeIcon(theme) {
  if (theme === "dark") {
    return `
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <circle cx="12" cy="12" r="4.5" fill="currentColor"></circle>
        <g stroke="currentColor" stroke-width="1.6" stroke-linecap="square">
          <path d="M12 2.5v2.1"></path>
          <path d="M12 19.4v2.1"></path>
          <path d="M2.5 12h2.1"></path>
          <path d="M19.4 12h2.1"></path>
          <path d="M5.1 5.1l1.5 1.5"></path>
          <path d="M17.4 17.4l1.5 1.5"></path>
          <path d="M5.1 18.9l1.5-1.5"></path>
          <path d="M17.4 6.6l1.5-1.5"></path>
        </g>
      </svg>
    `;
  }

  return `
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path
        d="M14.8 3.2a8.8 8.8 0 1 0 6 16.3 9.7 9.7 0 0 1-6-16.3Z"
        fill="currentColor"
      ></path>
    </svg>
  `;
}

function renderNavLink(href, label, iconMarkup, active = false) {
  return `
    <a class="${active ? "active" : ""}" href="${escapeHtml(href)}" aria-label="${escapeHtml(label)}" title="${escapeHtml(label)}">
      ${renderControlContent(label, iconMarkup)}
    </a>
  `;
}

function renderLabeledButton(className, action, label, iconMarkup, eventId = null) {
  return `
    <button
      class="${className}"
      type="button"
      data-action="${action}"
      ${eventId ? `data-event-id="${escapeHtml(eventId)}"` : ""}
      aria-label="${escapeHtml(label)}"
      title="${escapeHtml(label)}"
    >
      ${renderControlContent(label, iconMarkup)}
    </button>
  `;
}

function renderLabeledLink(className, href, label, iconMarkup, external = false) {
  return `
    <a
      class="${className}"
      href="${escapeHtml(href)}"
      ${external ? `target="_blank" rel="noreferrer noopener"` : ""}
      aria-label="${escapeHtml(label)}"
      title="${escapeHtml(label)}"
    >
      ${renderControlContent(label, iconMarkup)}
    </a>
  `;
}

function renderControlContent(label, iconMarkup) {
  return `
    <span class="control-icon" aria-hidden="true">${iconMarkup}</span>
    <span class="btn-label">${escapeHtml(label)}</span>
  `;
}

function renderIconActionButton(action, eventId, label, iconMarkup) {
  return `
    <button
      class="ghost icon-action"
      type="button"
      data-action="${action}"
      data-event-id="${escapeHtml(eventId)}"
      aria-label="${escapeHtml(label)}"
      title="${escapeHtml(label)}"
    >
      ${iconMarkup}
    </button>
  `;
}

function renderBrowseIcon() {
  return `
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <rect x="4" y="4" width="7" height="7" fill="none" stroke="currentColor" stroke-width="2"></rect>
      <rect x="13" y="4" width="7" height="7" fill="none" stroke="currentColor" stroke-width="2"></rect>
      <rect x="4" y="13" width="7" height="7" fill="none" stroke="currentColor" stroke-width="2"></rect>
      <rect x="13" y="13" width="7" height="7" fill="none" stroke="currentColor" stroke-width="2"></rect>
    </svg>
  `;
}

function renderSubmitIcon() {
  return `
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M12 4v16" stroke="currentColor" stroke-width="2" stroke-linecap="square"></path>
      <path d="M6 10l6-6 6 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="square" stroke-linejoin="miter"></path>
    </svg>
  `;
}

function renderOpenIcon() {
  return `
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M10 6h8v8" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="square" stroke-linejoin="miter"></path>
      <path d="M18 6 7 17" stroke="currentColor" stroke-width="2" stroke-linecap="square"></path>
      <path d="M6 8v10h10" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="square"></path>
    </svg>
  `;
}

function renderEditIcon() {
  return `
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M4 16.5V20h3.5L19 8.5 15.5 5 4 16.5Z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="miter"></path>
      <path d="M13.5 7.5 16.5 10.5" stroke="currentColor" stroke-width="2" stroke-linecap="square"></path>
    </svg>
  `;
}

function renderDeleteIcon() {
  return `
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2M10 11v6M14 11v6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"></path>
    </svg>
  `;
}

function renderRepositoryIcon() {
  return `
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M6 5h12v14H6z" fill="none" stroke="currentColor" stroke-width="2"></path>
      <path d="M9 9h6" stroke="currentColor" stroke-width="2" stroke-linecap="square"></path>
      <path d="M9 13h6" stroke="currentColor" stroke-width="2" stroke-linecap="square"></path>
    </svg>
  `;
}

function renderAuthorSiteIcon() {
  return `
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <circle cx="12" cy="12" r="8.5" fill="none" stroke="currentColor" stroke-width="2"></circle>
      <path d="M4 12h16" stroke="currentColor" stroke-width="2" stroke-linecap="square"></path>
      <path d="M12 3.5a11 11 0 0 1 0 17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="square"></path>
    </svg>
  `;
}

function renderCopyIcon() {
  return `
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <rect x="8" y="8" width="10" height="10" fill="none" stroke="currentColor" stroke-width="2"></rect>
      <path d="M6 16H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="square"></path>
    </svg>
  `;
}

function renderConnectIcon() {
  return `
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M8 12h8" stroke="currentColor" stroke-width="2" stroke-linecap="square"></path>
      <path d="M12 8v8" stroke="currentColor" stroke-width="2" stroke-linecap="square"></path>
      <circle cx="12" cy="12" r="8.5" fill="none" stroke="currentColor" stroke-width="2"></circle>
    </svg>
  `;
}

function renderMenuIcon() {
  return `
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M5 7h14" stroke="currentColor" stroke-width="2" stroke-linecap="square"></path>
      <path d="M5 12h14" stroke="currentColor" stroke-width="2" stroke-linecap="square"></path>
      <path d="M5 17h14" stroke="currentColor" stroke-width="2" stroke-linecap="square"></path>
    </svg>
  `;
}

function renderInstallIcon() {
  return `
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M12 4v10" stroke="currentColor" stroke-width="2" stroke-linecap="square"></path>
      <path d="M8 10l4 4 4-4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="square" stroke-linejoin="miter"></path>
      <path d="M5 19h14" stroke="currentColor" stroke-width="2" stroke-linecap="square"></path>
    </svg>
  `;
}

function renderRelayIcon() {
  return `
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <circle cx="12" cy="12" r="2" fill="currentColor"></circle>
      <path d="M7.5 10.5a6 6 0 0 1 9 0" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="square"></path>
      <path d="M6 7a10 10 0 0 1 12 0" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="square"></path>
      <path d="M4.5 3.5a13 13 0 0 1 15 0" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="square"></path>
    </svg>
  `;
}

function renderRefreshIcon() {
  return `
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M21 2v6h-6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="square"></path>
      <path d="M21 13a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="square"></path>
    </svg>
  `;
}

function renderWalletIcon() {
  return `
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M5 7.5h12a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V7.5Z" fill="none" stroke="currentColor" stroke-width="2"></path>
      <path d="M17 11h2" stroke="currentColor" stroke-width="2" stroke-linecap="square"></path>
      <path d="M7 7.5V6a2 2 0 0 1 2-2h8" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="square"></path>
    </svg>
  `;
}

function renderDisconnectIcon() {
  return `
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M10 7h4" stroke="currentColor" stroke-width="2" stroke-linecap="square"></path>
      <path d="M6.5 12h11" stroke="currentColor" stroke-width="2" stroke-linecap="square"></path>
      <path d="M10 17h4" stroke="currentColor" stroke-width="2" stroke-linecap="square"></path>
      <path d="M15 7l3 5-3 5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="square" stroke-linejoin="miter"></path>
    </svg>
  `;
}

function renderZapIcon() {
  return `
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M13 2L4 13h6l-1 9 11-13h-6l1-7Z" fill="currentColor"></path>
    </svg>
  `;
}

function renderReportIcon() {
  return `
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M12 3 2.75 20h18.5L12 3Z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="miter"></path>
      <path d="M12 8v5" stroke="currentColor" stroke-width="2" stroke-linecap="square"></path>
      <circle cx="12" cy="16.8" r="1.1" fill="currentColor"></circle>
    </svg>
  `;
}

function renderBlockIcon() {
  return `
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <circle cx="12" cy="12" r="8.5" fill="none" stroke="currentColor" stroke-width="2"></circle>
      <path d="M7.5 16.5 16.5 7.5" stroke="currentColor" stroke-width="2" stroke-linecap="square"></path>
    </svg>
  `;
}

function renderZapComposer(app) {
  if (!state.zapComposer || state.zapComposer.eventId !== app.id) return "";
  const composer = state.zapComposer;
  const amount = Number(composer.amountSats || 0);
  const hasInvoice = Boolean(composer.invoice);
  return `
    <section class="panel zap-panel">
      <div class="zap-panel-head">
        <div>
          <p class="eyebrow">Zap app</p>
          <h2>${escapeHtml(app.name)}</h2>
          <p>${escapeHtml(app.lightningAddress || "No Lightning address available.")}</p>
        </div>
        <button class="ghost icon-action" type="button" data-action="close-zap" aria-label="Close zap panel" title="Close zap panel">
          <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
            <path d="M5 5l14 14M19 5L5 19" stroke="currentColor" stroke-width="2" stroke-linecap="square"></path>
          </svg>
        </button>
      </div>
      <div class="zap-presets" role="group" aria-label="Suggested zap amounts">
        ${[1, 21, 100, 500].map((sats) => `
          <button
            class="filter-chip ${sats === amount ? "active" : ""}"
            type="button"
            data-action="zap-amount"
            data-sats="${sats}"
          >
            ${sats} sats
          </button>
        `).join("")}
      </div>
      <div class="zap-grid">
        <label>
          <span>Amount</span>
          <input
            name="zap-amount"
            type="number"
            min="1"
            step="1"
            value="${escapeHtml(String(composer.amountSats || 21))}"
            inputmode="numeric"
          />
        </label>
        <label>
          <span>Note</span>
          <textarea name="zap-note" rows="3" placeholder="Optional message">${escapeHtml(composer.note || "")}</textarea>
        </label>
      </div>
      ${composer.error ? `<p class="error">${escapeHtml(composer.error)}</p>` : ""}
      ${composer.busy ? `<p class="subtle">Preparing invoice…</p>` : ""}
      ${state.hasActiveAccount ? "" : `<p class="warning">Connect a signer to create the zap request.</p>`}
      ${hasInvoice ? `
        <div class="zap-invoice">
          <div>
            <strong>Invoice ready</strong>
            <code>${escapeHtml(composer.invoice)}</code>
          </div>
          <div class="zap-invoice-actions">
            <button class="primary" type="button" data-action="copy-zap-invoice">Copy invoice</button>
            <button class="ghost" type="button" data-action="open-zap-invoice">Open wallet</button>
          </div>
        </div>
      ` : `
        <div class="actions zap-actions">
          <button class="primary" type="button" data-action="send-zap" data-event-id="${escapeHtml(app.id)}" ${composer.busy || !state.hasActiveAccount ? "disabled" : ""}>Create zap</button>
        </div>
      `}
    </section>
  `;
}

function renderSettingsPanel() {
  return `
    <section class="panel settings-panel">
      <h2>Relay, media and wallet settings</h2>
      <div class="grid-2">
        <label>
          <span>Relays</span>
          <textarea name="relay-list" rows="6">${escapeHtml(state.relays.join("\n"))}</textarea>
        </label>
        <label>
          <span>Media server</span>
          <select name="media-server">
            ${state.mediaServers
              .map(
                (server, index) =>
                  `<option value="${index}" ${server.uploadUrl === state.selectedMediaServer?.uploadUrl ? "selected" : ""}>${escapeHtml(server.name)} (${escapeHtml(server.uploadUrl)})</option>`,
              )
              .join("")}
          </select>
          <small>Primary fallback when no user Blossom list is available.</small>
        </label>
      </div>
      <label class="wallet-setting">
        <span>Wallet (NWC)</span>
        <textarea
          name="wallet-connection"
          rows="3"
          spellcheck="false"
          autocomplete="off"
          placeholder="nostr+walletconnect://..."
        >${escapeHtml(state.walletConnection)}</textarea>
        <small>Paste a Nostr Wallet Connect URI here to enable wallet integrations.</small>
      </label>
      <div class="actions">
        <button class="primary" type="button" data-action="save-settings">Save settings</button>
        <button class="ghost" type="button" data-action="toggle-settings">Close</button>
      </div>
    </section>
  `;
}

function renderMain() {
  if (state.route.name === "submit") return renderSubmitView();
  if (state.route.name === "detail") return renderDetailView();
  return renderBrowseView();
}

function renderBrowseView() {
  const apps = [...state.apps.values()]
    .filter((app) => !isBlockedPubkey(app.pubkey))
    .filter((app) => !state.filterCategory || app.categories.includes(state.filterCategory))
    .filter((app) => !state.filterBuildType || app.buildTypes.includes(state.filterBuildType))
    .filter((app) => {
      if (!state.filterText) return true;
      const needle = state.filterText.toLowerCase();
      return [app.name, app.description, app.authorName, app.longDescription, app.repository]
        .filter(Boolean)
        .some((value) => value.toLowerCase().includes(needle));
    })
    .sort((a, b) => compareBrowseApps(a, b, state.sortOrder));

  const cards = apps.map(renderCard).join("");
  const searchAndCategoryCount = Number(Boolean(state.filterText)) + Number(Boolean(state.filterCategory));
  const buildCount = Number(Boolean(state.filterBuildType));
  return `
    <div class="browse-layout">
      <aside class="panel toolbar browse-sidebar">
        <details class="browse-filter-group" data-browse-filters ${state.browseFiltersOpen ? "open" : ""}>
          <summary class="browse-filter-summary">
            <span>Search and categories</span>
            ${renderFilterCountBadge(searchAndCategoryCount)}
          </summary>
          <div class="browse-filter-body">
            <div class="toolbar-row toolbar-row--search">
              <input type="search" name="filter-text" value="${escapeHtml(state.filterText)}" placeholder="Search apps, authors, descriptions" />
            </div>
            <div class="toolbar-group">
              <div class="toolbar-group-label">Categories</div>
              <div class="chip-group chip-group--sidebar" role="group" aria-label="Category filters">
                <button
                  class="filter-chip ${state.filterCategory === "" ? "active" : ""}"
                  type="button"
                  data-category-filter=""
                >
                  All categories
                </button>
                ${CATEGORIES.map(
                  (category) => `
                    <button
                      class="filter-chip ${category === state.filterCategory ? "active" : ""}"
                      type="button"
                      data-category-filter="${category}"
                    >
                      ${category}
                    </button>
                  `,
                ).join("")}
              </div>
            </div>
          </div>
        </details>
      </aside>
      <div class="browse-main">
        <section class="panel toolbar browse-toolbar">
          <details class="browse-filter-group" data-build-filters ${state.buildFiltersOpen ? "open" : ""}>
            <summary class="browse-filter-summary">
              <span>Builds</span>
              ${renderFilterCountBadge(buildCount)}
            </summary>
            <div class="browse-filter-body">
              <div class="toolbar-group">
                <div class="chip-group" role="group" aria-label="Build type filters">
                  <button
                    class="filter-chip ${state.filterBuildType === "" ? "active" : ""}"
                    type="button"
                    data-build-filter=""
                  >
                    All build types
                  </button>
                  ${BUILD_TYPES.map(
                    (buildType) => `
                      <button
                        class="filter-chip ${buildType === state.filterBuildType ? "active" : ""}"
                        type="button"
                        data-build-filter="${buildType}"
                      >
                        ${buildType}
                      </button>
                    `,
                  ).join("")}
                </div>
              </div>
            </div>
          </details>
          <div class="toolbar-row toolbar-row--controls">
            <div class="toolbar-group">
              <div class="toolbar-group-label">Grid</div>
              <div class="chip-group" role="group" aria-label="Grid size">
                ${GRID_SIZE_OPTIONS.map(
                  (size) => `
                    <button
                      class="filter-chip grid-size-chip ${size === state.gridSize ? "active" : ""}"
                      type="button"
                      data-grid-size="${size}"
                      aria-label="${size} grid"
                      title="${size} grid"
                    >
                      ${renderGridSizeIcon(size)}
                    </button>
                  `,
                ).join("")}
              </div>
            </div>
            <div class="toolbar-group">
              <div class="toolbar-group-label">Sort</div>
              <div class="chip-group" role="group" aria-label="Sort order">
                ${[
                  ["newest", "Newest"],
                  ["oldest", "Oldest"],
                  ["alpha", "A-Z"],
                ]
                  .map(
                    ([value, label]) => `
                      <button
                        class="filter-chip sort-chip ${value === state.sortOrder ? "active" : ""}"
                        type="button"
                        data-sort-order="${value}"
                        aria-label="${label}"
                        title="${label}"
                      >
                        ${renderSortIcon(value)}
                      </button>
                    `,
                  )
                  .join("")}
              </div>
            </div>
          </div>
        </section>
        <section class="grid cards-grid cards-grid--${escapeHtml(state.gridSize)}">
          ${state.loading ? `<div class="panel empty-state">Loading apps from relays…</div>` : cards || `<div class="panel empty-state">No apps matched your filters.</div>`}
        </section>
      </div>
    </div>
  `;
}

function renderFilterCountBadge(count) {
  if (!count) return "";
  return `<span class="browse-filter-count">${escapeHtml(String(count))}</span>`;
}

function isCompactBrowseViewport() {
  return typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia("(max-width: 640px)").matches
    : false;
}

function renderCard(app) {
  const iconSrc = app.image || app.imageSources?.[0] || buildFallbackIcon(app.name);
  const iconFallbacks = [app.imageSources || []].flat().filter(Boolean);
  const developer = app.authorName || truncatePubkey(app.pubkey);
  return `
    <article class="card">
      <a href="${escapeHtml(routeToPath({ name: "detail", pubkey: app.pubkey, d: app.d }))}" class="card-link">
        <div class="card-media">
          ${renderImageElement({
            src: iconSrc,
            alt: `${app.name} icon`,
            loading: "lazy",
            className: "",
            fallbacks: iconFallbacks,
            placeholder: buildFallbackIcon(app.name),
          })}
        </div>
        <div class="card-body">
          <h3>${escapeHtml(app.name)}</h3>
          <small>@${escapeHtml(developer)}</small>
        </div>
      </a>
    </article>
  `;
}

function renderGridSizeIcon(size) {
  if (size === "small") {
    return `
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <g fill="currentColor">
          <rect x="3" y="3" width="5" height="5"></rect>
          <rect x="10" y="3" width="5" height="5"></rect>
          <rect x="17" y="3" width="4" height="5"></rect>
          <rect x="3" y="10" width="5" height="5"></rect>
          <rect x="10" y="10" width="5" height="5"></rect>
          <rect x="17" y="10" width="4" height="5"></rect>
          <rect x="3" y="17" width="5" height="4"></rect>
          <rect x="10" y="17" width="5" height="4"></rect>
          <rect x="17" y="17" width="4" height="4"></rect>
        </g>
      </svg>
    `;
  }

  if (size === "large") {
    return `
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <rect x="3" y="3" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"></rect>
        <rect x="6" y="6" width="12" height="12" fill="currentColor"></rect>
      </svg>
    `;
  }

  return `
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <g fill="currentColor">
        <rect x="3" y="3" width="7" height="7"></rect>
        <rect x="14" y="3" width="7" height="7"></rect>
        <rect x="3" y="14" width="7" height="7"></rect>
        <rect x="14" y="14" width="7" height="7"></rect>
      </g>
    </svg>
  `;
}

function renderSortIcon(sortOrder) {
  if (sortOrder === "oldest") {
    return `
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path d="M6 4h12" stroke="currentColor" stroke-width="2" stroke-linecap="square"></path>
        <path d="M9 8l3-4 3 4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="square" stroke-linejoin="miter"></path>
        <path d="M8 14h8" stroke="currentColor" stroke-width="2" stroke-linecap="square"></path>
        <path d="M8 19h8" stroke="currentColor" stroke-width="2" stroke-linecap="square"></path>
      </svg>
    `;
  }

  if (sortOrder === "alpha") {
    return `
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path d="M6 19h4" stroke="currentColor" stroke-width="2" stroke-linecap="square"></path>
        <path d="M8 5l-3 14" stroke="currentColor" stroke-width="2" stroke-linecap="square"></path>
        <path d="M12 19l4-14" stroke="currentColor" stroke-width="2" stroke-linecap="square"></path>
        <path d="M15 14h5" stroke="currentColor" stroke-width="2" stroke-linecap="square"></path>
        <path d="M14 19h6" stroke="currentColor" stroke-width="2" stroke-linecap="square"></path>
      </svg>
    `;
  }

  return `
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M12 4v16" stroke="currentColor" stroke-width="2" stroke-linecap="square"></path>
      <path d="M8 8l4-4 4 4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="square" stroke-linejoin="miter"></path>
      <path d="M8 14h8" stroke="currentColor" stroke-width="2" stroke-linecap="square"></path>
      <path d="M8 19h8" stroke="currentColor" stroke-width="2" stroke-linecap="square"></path>
    </svg>
  `;
}

function buildFallbackIcon(name) {
  const letter = String(name || "A").trim().charAt(0).toUpperCase() || "A";
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" role="img" aria-label="${escapeHtml(name || "App")} icon">
      <rect width="256" height="256" fill="#ff8a3d"/>
      <rect x="20" y="20" width="216" height="216" fill="#111114" stroke="#ff4fa3" stroke-width="4"/>
      <text x="128" y="156" text-anchor="middle" font-family="Inter, Arial, sans-serif" font-size="120" font-weight="800" fill="#f5f5f7">${escapeHtml(letter)}</text>
    </svg>
  `.trim();
  return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`;
}

function renderDetailView() {
  const { pubkey, d } = state.route;
  if (isBlockedPubkey(pubkey)) {
    return `<section class="panel empty-state">This app listing is hidden because the publisher is blocked.</section>`;
  }
  const app = state.apps.get(`${pubkey}:${d}`);
  if (!app) {
    return `<section class="panel empty-state">Loading app detail…</section>`;
  }
  if (isDeleted(app)) {
    return `<section class="panel empty-state">This app listing was deleted on Nostr.</section>`;
  }
  const screenshots = (app.screenshots || [])
    .map((url, index) =>
      renderImageElement({
        src: url,
        alt: `${app.name} screenshot ${index + 1}`,
        loading: "lazy",
        className: "",
        fallbacks: Array.isArray(app.screenshotSources?.[index]) ? app.screenshotSources[index] : [],
        placeholder: buildFallbackImage(`${app.name} screenshot`),
        extraAttrs: ` data-action="open-lightbox" data-lightbox-alt="${escapeHtml(`${app.name} screenshot ${index + 1}`)}"`,
      }),
    )
    .join("");
  const screenshotCount = (app.screenshots || []).length;
  const screenshotLayout = screenshotCount === 1 ? "screenshots--single" : screenshotCount > 1 ? "screenshots--multi" : "";
  return `
    <section class="detail-hero panel">
      <div class="detail-head">
        <div class="detail-icon">
          ${app.image || app.imageSources?.length ? renderImageElement({
            src: app.image || app.imageSources?.[0] || buildFallbackIcon(app.name),
            alt: `${app.name} icon`,
            className: "",
            fallbacks: app.imageSources || [],
            placeholder: buildFallbackIcon(app.name),
          }) : `<span>${escapeHtml(app.name.slice(0, 1).toUpperCase())}</span>`}
        </div>
        <div class="detail-title-block">
          <p class="eyebrow">App listing</p>
          <div class="detail-title-row">
            <h1>${escapeHtml(app.name)}</h1>
            <div class="detail-title-actions" aria-label="App actions">
              ${app.lightningAddress ? renderIconActionButton("zap-app", app.id, "Zap app", renderZapIcon()) : ""}
              ${renderIconActionButton("report-app", app.id, "Report app", renderReportIcon())}
              ${renderIconActionButton("block-app", app.id, "Block app", renderBlockIcon())}
            </div>
          </div>
          <p>${escapeHtml(app.description || "")}</p>
          <div class="tag-row">
            ${app.categories.map((category) => `<span class="tag">${escapeHtml(category)}</span>`).join("")}
            ${app.buildTypes.map((buildType) => `<span class="tag">${escapeHtml(buildType)}</span>`).join("")}
            ${app.version ? `<span class="tag">v${escapeHtml(app.version)}</span>` : ""}
          </div>
        </div>
      </div>
      <div class="actions">
        ${app.web ? renderLabeledLink("primary", app.web, "Open app", renderOpenIcon(), true) : ""}
        ${state.hasActiveAccount && state.pubkey === app.pubkey ? renderLabeledButton("ghost", "edit-app", "Edit app", renderEditIcon(), app.id) : ""}
        ${state.hasActiveAccount && state.pubkey === app.pubkey ? renderLabeledButton("ghost", "delete-app", "Delete app", renderDeleteIcon(), app.id) : ""}
        ${app.repository ? renderLabeledLink("ghost", app.repository, "Repository", renderRepositoryIcon(), true) : ""}
        ${app.authorWebsite ? renderLabeledLink("ghost", app.authorWebsite, "Author site", renderAuthorSiteIcon(), true) : ""}
        ${renderLabeledButton("ghost", "copy-event-id", "Copy event ID", renderCopyIcon(), app.id)}
      </div>
    </section>
    ${renderZapComposer(app)}
    ${app.longDescription || app.description ? `<section class="panel detail-content prose"><h2>About</h2><div>${markdownToHtml(app.longDescription || app.description || "")}</div></section>` : ""}
    <section class="grid detail-grid ${screenshots ? "" : "detail-grid--single"}">
      ${screenshots ? `<section class="panel screenshots-panel ${screenshotLayout}"><h2>Screenshots</h2><div class="screenshots ${screenshotLayout}">${screenshots}</div></section>` : ""}
      <aside class="panel meta-card">
        <h2>Metadata</h2>
        <dl>
          <div><dt>Author</dt><dd>${escapeHtml(app.authorName || truncatePubkey(app.pubkey))}</dd></div>
          <div><dt>Pubkey</dt><dd><code>${escapeHtml(app.pubkey)}</code></dd></div>
          <div><dt>Published</dt><dd>${escapeHtml(formatTimestamp(app.publishedAt))}</dd></div>
          ${app.license ? `<div><dt>License</dt><dd>${escapeHtml(app.license)}</dd></div>` : ""}
          ${app.lightningAddress ? `<div><dt>Lightning</dt><dd>${escapeHtml(app.lightningAddress)}</dd></div>` : ""}
        </dl>
      </aside>
    </section>
  `;
}

function renderSubmitView() {
  const existingApps = state.pubkey
    ? [...state.apps.values()].filter((app) => app.pubkey === state.pubkey && !isBlockedPubkey(app.pubkey)).sort((a, b) => (b.created_at || 0) - (a.created_at || 0))
    : [];
  const uploadSummary = state.userMediaServers.length
    ? `Using ${state.userMediaServers.length} Blossom server${state.userMediaServers.length === 1 ? "" : "s"} from your profile.`
    : `Using ${state.mediaServers.length} default upload server${state.mediaServers.length === 1 ? "" : "s"}.`;
  return `
    <section class="panel submit-layout">
      <div class="submit-intro">
        <p class="eyebrow">Publish or update</p>
        <h1>Submit an app listing.</h1>
        <p>
          Signed events are published to your configured relays. Icon and screenshots can be uploaded to a Blossom or NIP-96 server, or entered manually as URLs.
        </p>
        <p class="subtle">${escapeHtml(uploadSummary)}</p>
        ${state.hasActiveAccount ? `<p class="subtle">Connected signer: ${escapeHtml(state.pubkey || "unknown")}</p>` : `<p class="warning">No NIP-07 signer detected. The window.nostr.js widget can connect you with Nostr Connect or an extension.</p>`}
      </div>
      <div class="actions stack submit-actions">
        ${state.hasActiveAccount ? "" : `<button class="primary" type="button" data-action="connect-account">Connect with Nostr Connect</button>`}
        <button class="ghost" type="button" data-action="toggle-manual-urls">${state.manualUrls ? "Use file uploads" : "Use manual URLs"}</button>
      </div>
    </section>
    <section class="submit-grid">
      <form class="panel form" data-submit-form>
        <h2>Listing details</h2>
        ${existingApps.length ? renderOwnedApps(existingApps) : ""}
        <label><span>Existing app</span>
          <select name="existing-app">
            <option value="">Create new listing</option>
            ${existingApps.map((app) => `<option value="${escapeHtml(app.d)}" ${state.form.d === app.d ? "selected" : ""}>${escapeHtml(app.name)}</option>`).join("")}
          </select>
        </label>
        <div class="grid-2">
          <label><span>App name</span><input name="name" value="${escapeHtml(state.form.name)}" required /></label>
          <label><span>App URL</span><input name="web" value="${escapeHtml(state.form.web)}" placeholder="https://example.com" required /></label>
        </div>
        <label><span>Short description</span><textarea name="description" maxlength="160" rows="3">${escapeHtml(state.form.description)}</textarea></label>
        <label><span>Long description</span><textarea name="longDescription" rows="8">${escapeHtml(state.form.longDescription)}</textarea></label>
        <section class="choice-section">
          <div class="choice-heading">
            <label>Categories</label>
            <small>Pick up to 3</small>
          </div>
          <div class="chip-group choice-group" data-choice-group="categories">
            ${CATEGORIES.map((category) => renderChoiceChip("categories", category, state.form.categories.includes(category))).join("")}
          </div>
        </section>
        <section class="choice-section">
          <div class="choice-heading">
            <label>Build types</label>
            <small>Pick up to 4</small>
          </div>
          <div class="chip-group choice-group" data-choice-group="buildTypes">
            ${BUILD_TYPES.map((buildType) => renderChoiceChip("buildTypes", buildType, state.form.buildTypes.includes(buildType))).join("")}
          </div>
        </section>
        <div class="grid-2">
          <label><span>Version</span><input name="version" value="${escapeHtml(state.form.version)}" /></label>
          <label><span>License</span><input name="license" value="${escapeHtml(state.form.license)}" /></label>
          <label><span>Repository</span><input name="repository" value="${escapeHtml(state.form.repository)}" /></label>
          <label>
            <span>Lightning address</span>
            <input
              name="lightningAddress"
              value="${escapeHtml(state.form.lightningAddress)}"
              placeholder="${state.profileLightningAddress ? escapeHtml(state.profileLightningAddress) : ""}"
            />
            ${state.profileLightningAddress ? `<small>Profile hint: ${escapeHtml(state.profileLightningAddress)}</small>` : ""}
          </label>
          <label><span>Author name</span><input name="authorName" value="${escapeHtml(state.form.authorName)}" /></label>
          <label><span>Author website</span><input name="authorWebsite" value="${escapeHtml(state.form.authorWebsite)}" /></label>
        </div>
        <div class="grid-2">
          <div class="field-stack">
            <label><span>Icon ${state.manualUrls ? "URL" : "file"}</span>${state.manualUrls ? `<input name="image" value="${escapeHtml(state.form.image)}" placeholder="https://..." />` : `<input name="imageFile" type="file" accept="image/*" />`}</label>
            ${state.manualUrls ? "" : renderAttachedFiles("image")}
          </div>
          <label><span>Thumbnail URL</span><input name="thumbnail" value="${escapeHtml(state.form.thumbnail)}" placeholder="Auto-fills from the app website icon" /></label>
        </div>
        ${state.manualUrls ? renderManualScreenshots() : renderUploadFields()}
        <details class="advanced-options" ${!state.hasActiveAccount ? "open" : ""}>
          <summary>Advanced options</summary>
          <div class="advanced-body">
            ${state.hasActiveAccount ? "" : `<label><span>Signed event JSON</span><textarea name="signedJson" rows="8" placeholder='Paste a signed Nostr event JSON here'>${escapeHtml(state.signedJson)}</textarea></label>`}
            <label class="checkbox">
              <input type="checkbox" name="enable-pow" ${state.powBits > 0 ? "checked" : ""} />
              <span>Enable proof-of-work</span>
            </label>
            <input type="number" name="pow-bits" min="0" max="40" value="${escapeHtml(String(state.powBits || 0))}" placeholder="Bits" />
          </div>
        </details>
        <div class="actions">
          <button class="primary" type="submit" ${state.submitBusy ? "disabled" : ""}>${state.submitBusy ? "Publishing…" : "Publish to Nostr"}</button>
          <button class="ghost" type="button" data-action="copy-draft">Copy event JSON</button>
        </div>
        ${state.submitError ? `<p class="error">${escapeHtml(state.submitError)}</p>` : ""}
        ${state.submitSuccess ? `<p class="success">${escapeHtml(state.submitSuccess)}</p>` : ""}
      </form>
    </section>
  `;
}

function renderOwnedApps(existingApps) {
  return `
    <div class="owned-apps">
      <p class="subtle">Your existing listings are available for update.</p>
      <div class="tag-row">
        ${existingApps.slice(0, 5).map((app) => `<span class="tag">${escapeHtml(app.name)}</span>`).join("")}
      </div>
    </div>
  `;
}

function renderUploadFields() {
  return `
    <div class="field-stack">
      <label>
        <span>Screenshot uploads</span>
        <input name="screenshotFiles" type="file" accept="image/*" multiple />
      </label>
      <p class="subtle">Choose more files to add them to the current screenshot list.</p>
      ${renderAttachedFiles("screenshots")}
    </div>
  `;
}

function renderAttachedFiles(kind) {
  const items = kind === "image"
    ? state.form.imageFile
      ? [{ file: state.form.imageFile, previewUrl: state.form.imagePreviewUrl, action: "remove-image-file" }]
      : []
    : (state.form.screenshotFiles || []).map((file, index) => ({
        file,
        previewUrl: state.form.screenshotPreviewUrls?.[index] || "",
        action: "remove-screenshot-file",
        index,
      }));

  if (!items.length) return "";

  return `
    <div class="attachment-list">
      ${items.map((item) => `
        <div class="attachment-item">
          <img
            src="${escapeHtml(item.previewUrl || buildFallbackImage(item.file?.name || "Image"))}"
            alt="${escapeHtml(item.file?.name || "Attached image")}"
          />
          <div class="attachment-meta">
            <strong>${escapeHtml(item.file?.name || "Attached image")}</strong>
            <span>${escapeHtml(formatBytes(item.file?.size || 0))}</span>
          </div>
          <button
            class="attachment-remove"
            type="button"
            data-action="${item.action}"
            ${item.index !== undefined ? `data-index="${item.index}"` : ""}
            aria-label="Remove ${escapeHtml(item.file?.name || "attachment")}"
          >
            ×
          </button>
        </div>
      `).join("")}
    </div>
  `;
}

function renderChoiceChip(group, value, selected) {
  return `
    <button
      class="choice-chip ${selected ? "active" : ""}"
      type="button"
      data-toggle-choice
      data-choice-group="${group}"
      data-choice-value="${value}"
      aria-pressed="${selected ? "true" : "false"}"
    >
      ${escapeHtml(value)}
    </button>
  `;
}

function renderManualScreenshots() {
  const fields = Array.from({ length: 5 }, (_, index) => `
    <label><span>Screenshot ${index + 1}</span><input name="screenshot-${index}" value="${escapeHtml(state.form.screenshots[index] || "")}" placeholder="https://..." /></label>
  `).join("");
  return `<div class="grid-2">${fields}</div>`;
}

function bindUi() {
  attachImageFallbacks();

  document.querySelectorAll("[data-action='toggle-settings']").forEach((element) => {
    element.addEventListener("click", () => {
      state.settingsOpen = !state.settingsOpen;
      state.accountMenuOpen = false;
      scheduleRender();
    });
  });

  document.querySelectorAll("[data-action='toggle-account-menu']").forEach((element) => {
    element.addEventListener("click", () => {
      state.accountMenuOpen = !state.accountMenuOpen;
      state.settingsOpen = false;
      scheduleRender();
    });
  });

  document.querySelectorAll("[data-action='refresh-relays']").forEach((element) => {
    element.addEventListener("click", async () => {
      state.accountMenuOpen = false;
      await refreshCatalog();
    });
  });

  const filterText = document.querySelector('input[name="filter-text"]');
  if (filterText) {
    filterText.addEventListener("input", (event) => {
      state.filterText = event.target.value;
      scheduleRender();
    });
  }

  document.querySelectorAll("[data-category-filter]").forEach((element) => {
    element.addEventListener("click", () => {
      state.filterCategory = element.getAttribute("data-category-filter") || "";
      scheduleRender();
    });
  });

  document.querySelectorAll("[data-build-filter]").forEach((element) => {
    element.addEventListener("click", () => {
      state.filterBuildType = element.getAttribute("data-build-filter") || "";
      scheduleRender();
    });
  });

  document.querySelectorAll("[data-grid-size]").forEach((element) => {
    element.addEventListener("click", () => {
      state.gridSize = normalizeGridSize(element.getAttribute("data-grid-size"), state.gridSize);
      localStorage.setItem(STORAGE_KEYS.gridSize, state.gridSize);
      scheduleRender();
    });
  });

  document.querySelectorAll("[data-sort-order]").forEach((element) => {
    element.addEventListener("click", () => {
      state.sortOrder = normalizeSortOrder(element.getAttribute("data-sort-order"), state.sortOrder);
      localStorage.setItem(STORAGE_KEYS.sortOrder, state.sortOrder);
      scheduleRender();
    });
  });

  document.querySelectorAll("[data-toggle-choice]").forEach((element) => {
    element.addEventListener("click", () => {
      const group = element.getAttribute("data-choice-group");
      const value = element.getAttribute("data-choice-value");
      if (!group || !value) return;
      state.form[group] = toggleChoiceValue(state.form[group], value, group === "categories" ? 3 : 4);
      scheduleRender();
    });
  });

  const browseFilters = document.querySelector("[data-browse-filters]");
  if (browseFilters) {
    browseFilters.addEventListener("toggle", () => {
      state.browseFiltersOpen = browseFilters.open;
    });
  }

  const buildFilters = document.querySelector("[data-build-filters]");
  if (buildFilters) {
    buildFilters.addEventListener("toggle", () => {
      state.buildFiltersOpen = buildFilters.open;
    });
  }

  const saveSettings = document.querySelector("[data-action='save-settings']");
  if (saveSettings) {
    saveSettings.addEventListener("click", () => {
      const relaysField = document.querySelector("textarea[name='relay-list']");
      const mediaServerField = document.querySelector("select[name='media-server']");
      const walletField = document.querySelector("textarea[name='wallet-connection']");
      if (relaysField) {
        state.relays = relaysField.value
          .split(/\s+/)
          .map((relay) => relay.trim())
          .filter(Boolean);
        localStorage.setItem(STORAGE_KEYS.relays, JSON.stringify(state.relays));
        pool.setRelays(state.relays);
      }
      if (mediaServerField) {
        state.selectedMediaServer = state.mediaServers[Number(mediaServerField.value)] || state.mediaServers[0];
        localStorage.setItem(STORAGE_KEYS.mediaServer, JSON.stringify(state.selectedMediaServer));
      }
      if (walletField) {
        state.walletConnection = walletField.value.trim();
        localStorage.setItem(STORAGE_KEYS.walletConnection, state.walletConnection);
      }
      state.settingsOpen = false;
      scheduleRender();
    });
  }

  const openSettings = document.querySelector("[data-action='open-settings']");
  if (openSettings) {
    openSettings.addEventListener("click", () => {
      state.settingsOpen = true;
      state.accountMenuOpen = false;
      scheduleRender();
    });
  }

  const toggleManualUrls = document.querySelector("[data-action='toggle-manual-urls']");
  if (toggleManualUrls) {
    toggleManualUrls.addEventListener("click", () => {
      state.manualUrls = !state.manualUrls;
      scheduleRender();
    });
  }

  document.querySelectorAll("[data-action='connect-account']").forEach((connectAccount) => {
    connectAccount.addEventListener("click", async () => {
      state.connectError = "";
      const connected = isNip07Available() && pool?.connectExtensionAccount ? await connectSigner() : await connectWithNostrConnect();
      if (!connected) {
        state.connectHelpOpen = true;
        scheduleRender();
      }
      routeSideEffects();
    });
  });

  document.querySelectorAll("[data-action='connect-passkey']").forEach((connectPasskey) => {
    connectPasskey.addEventListener("click", async () => {
      state.connectError = "";
      const connected = await connectWithPasskey();
      if (!connected) {
        state.connectHelpOpen = true;
        scheduleRender();
      }
      routeSideEffects();
    });
  });

  const passkeyImportNsec = document.querySelector('input[name="passkey-import-nsec"]');
  if (passkeyImportNsec) {
    passkeyImportNsec.addEventListener("input", (event) => {
      state.passkeyImportNsec = event.target.value;
      scheduleRender();
    });
  }

  const dismissConnectHelp = document.querySelector("[data-action='dismiss-connect-help']");
  if (dismissConnectHelp) {
    dismissConnectHelp.addEventListener("click", () => {
      state.connectHelpOpen = false;
      state.passkeyImportNsec = "";
      scheduleRender();
    });
  }

  const resetConnectSession = document.querySelector("[data-action='reset-connect-session']");
  if (resetConnectSession) {
    resetConnectSession.addEventListener("click", () => {
      disposeNostrConnectSession(state.connectSession);
      state.connectSession = null;
      state.statusText = "No Nostr signer detected on this device.";
      state.connectError = "";
      scheduleRender();
    });
  }

  const disconnectAccount = document.querySelector("[data-action='disconnect-account']");
  if (disconnectAccount) {
    disconnectAccount.addEventListener("click", () => {
      void disconnectActiveAccount();
    });
  }

  document.querySelectorAll("[data-action='copy-connect-uri']").forEach((element) => {
    element.addEventListener("click", async () => {
      if (!state.connectSession?.connectionUri) return;
      try {
        await navigator.clipboard.writeText(state.connectSession.connectionUri);
        state.statusText = "Connection link copied.";
      } catch {
        state.statusText = "Could not copy the connection link.";
      }
      scheduleRender();
    });
  });

  document.querySelectorAll("[data-action='share-connect-uri']").forEach((element) => {
    element.addEventListener("click", async () => {
      if (!state.connectSession?.connectionUri || typeof navigator === "undefined" || typeof navigator.share !== "function") {
        return;
      }
      try {
        await navigator.share({
          title: "Nostr App Store connect link",
          text: "Approve this Nostr Connect request in your signer.",
          url: state.connectSession.connectionUri,
        });
        state.statusText = "Connection link shared.";
      } catch {
        // ignore
      }
      scheduleRender();
    });
  });

  const installApp = document.querySelector("[data-action='install-app']");
  if (installApp) {
    installApp.addEventListener("click", async () => {
      if (!installPromptEvent) return;
      installPromptEvent.prompt();
      try {
        await installPromptEvent.userChoice;
      } finally {
        installPromptEvent = null;
        state.installAvailable = false;
        state.accountMenuOpen = false;
        scheduleRender();
      }
    });
  }

  const toggleTheme = document.querySelector("[data-action='toggle-theme']");
  if (toggleTheme) {
    toggleTheme.addEventListener("click", () => {
      state.theme = state.theme === "dark" ? "light" : "dark";
      state.accountMenuOpen = false;
      applyTheme(state.theme);
      localStorage.setItem(STORAGE_KEYS.theme, state.theme);
      scheduleRender();
    });
  }

  const copyDraft = document.querySelector("[data-action='copy-draft']");
  if (copyDraft) {
    copyDraft.addEventListener("click", async () => {
      const draft = buildDraftEvent();
      await navigator.clipboard.writeText(JSON.stringify(draft, null, 2));
      state.submitSuccess = "Draft event JSON copied.";
      scheduleRender();
    });
  }

  const submitForm = document.querySelector("[data-submit-form]");
  if (submitForm) {
    submitForm.addEventListener("input", handleFormInput);
    submitForm.addEventListener("change", handleFormChange);
    submitForm.addEventListener("submit", handleSubmit);
  }

  document.querySelectorAll("[data-action='copy-event-id']").forEach((element) => {
    element.addEventListener("click", async () => {
      const eventId = element.getAttribute("data-event-id");
      if (!eventId) return;
      await navigator.clipboard.writeText(eventId);
      state.statusText = "Event ID copied";
      scheduleRender();
    });
  });

  document.querySelectorAll("[data-action='report-app']").forEach((element) => {
    element.addEventListener("click", async () => {
      await reportApp(element.getAttribute("data-event-id"));
    });
  });

  document.querySelectorAll("[data-action='zap-app']").forEach((element) => {
    element.addEventListener("click", async () => {
      await zapApp(element.getAttribute("data-event-id"));
    });
  });

  document.querySelectorAll("[data-action='close-zap']").forEach((element) => {
    element.addEventListener("click", () => {
      state.zapComposer = null;
      scheduleRender();
    });
  });

  document.querySelectorAll("[data-action='zap-amount']").forEach((element) => {
    element.addEventListener("click", () => {
      const sats = Number(element.getAttribute("data-sats"));
      if (!Number.isFinite(sats) || sats <= 0 || !state.zapComposer) return;
      state.zapComposer.amountSats = sats;
      state.zapComposer.error = "";
      scheduleRender();
    });
  });

  const zapAmount = document.querySelector("input[name='zap-amount']");
  if (zapAmount) {
    zapAmount.addEventListener("input", (event) => {
      if (!state.zapComposer) return;
      state.zapComposer.amountSats = Number(event.target.value || 0);
      state.zapComposer.error = "";
    });
  }

  const zapNote = document.querySelector("textarea[name='zap-note']");
  if (zapNote) {
    zapNote.addEventListener("input", (event) => {
      if (!state.zapComposer) return;
      state.zapComposer.note = event.target.value;
    });
  }

  document.querySelectorAll("[data-action='send-zap']").forEach((element) => {
    element.addEventListener("click", async () => {
      await sendZap(element.getAttribute("data-event-id"));
    });
  });

  document.querySelectorAll("[data-action='copy-zap-invoice']").forEach((element) => {
    element.addEventListener("click", async () => {
      await copyZapInvoice();
    });
  });

  document.querySelectorAll("[data-action='open-zap-invoice']").forEach((element) => {
    element.addEventListener("click", () => {
      if (!state.zapComposer?.invoice) return;
      try {
        window.open(`lightning:${state.zapComposer.invoice}`, "_blank", "noopener");
      } catch {
        // ignore
      }
    });
  });

  document.querySelectorAll("[data-action='block-app']").forEach((element) => {
    element.addEventListener("click", async () => {
      await blockApp(element.getAttribute("data-event-id"));
    });
  });

  document.querySelectorAll("[data-action='edit-app']").forEach((element) => {
    element.addEventListener("click", () => {
      const eventId = element.getAttribute("data-event-id");
      const app = [...state.apps.values()].find((candidate) => candidate.id === eventId);
      if (!app) return;
      loadAppIntoForm(app);
      state.submitError = "";
      state.submitSuccess = "";
      navigateToRoute({ name: "submit" }, { replace: true });
    });
  });

  document.querySelectorAll("[data-action='delete-app']").forEach((element) => {
    element.addEventListener("click", async () => {
      await deleteApp(element.getAttribute("data-event-id"));
    });
  });

  document.querySelectorAll("[data-action='remove-image-file']").forEach((element) => {
    element.addEventListener("click", () => {
      clearAttachmentPreview("image");
      scheduleRender();
    });
  });

  document.querySelectorAll("[data-action='remove-screenshot-file']").forEach((element) => {
    element.addEventListener("click", () => {
      const index = Number(element.getAttribute("data-index"));
      clearAttachmentPreview("screenshots", Number.isFinite(index) ? index : null);
      scheduleRender();
    });
  });

  document.querySelectorAll("[data-action='open-lightbox']").forEach((element) => {
    element.addEventListener("click", (event) => {
      const image = event.currentTarget;
      const alt = image.getAttribute("data-lightbox-alt") || image.getAttribute("alt") || "Screenshot";
      const src = image.currentSrc || image.getAttribute("src") || "";
      if (!src) return;
      state.lightbox = { src, alt };
      scheduleRender();
    });
  });

  document.querySelectorAll("[data-action='close-lightbox']").forEach((element) => {
    element.addEventListener("click", () => {
      state.lightbox = null;
      scheduleRender();
    });
  });

  const powToggle = document.querySelector("input[name='enable-pow']");
  if (powToggle) {
    powToggle.addEventListener("change", (event) => {
      state.powBits = event.target.checked ? Math.max(20, state.powBits || 20) : 0;
      scheduleRender();
    });
  }

  if (state.lightbox) {
    window.addEventListener(
      "keydown",
      (event) => {
        if (event.key === "Escape") {
          state.lightbox = null;
          scheduleRender();
        }
      },
      { once: true },
    );
  }
}

function attachImageFallbacks() {
  document.querySelectorAll("img[data-fallback-sources]").forEach((image) => {
    if (image.dataset.fallbackBound === "true") return;
    image.dataset.fallbackBound = "true";
    image.addEventListener("error", handleImageFallback);
  });
}

function handleImageFallback(event) {
  const image = event.currentTarget;
  const sources = safeJsonParse(image.getAttribute("data-fallback-sources"), []);
  const index = Number(image.dataset.fallbackIndex || 0);
  const nextSource = sources[index];
  if (nextSource) {
    image.dataset.fallbackIndex = String(index + 1);
    image.src = nextSource;
    return;
  }

  const placeholder = image.getAttribute("data-fallback-placeholder");
  if (placeholder && image.src !== placeholder) {
    image.dataset.fallbackIndex = String(index + 1);
    image.src = placeholder;
  }
}

function renderImageElement({ src, alt, loading = "lazy", className = "", fallbacks = [], placeholder = "", extraAttrs = "" }) {
  const fallbackList = unique([...fallbacks].filter(Boolean));
  const classAttr = className ? ` class="${escapeHtml(className)}"` : "";
  const loadingAttr = loading ? ` loading="${escapeHtml(loading)}"` : "";
  const fallbackAttr = fallbackList.length ? ` data-fallback-sources="${escapeHtml(JSON.stringify(fallbackList))}"` : "";
  const placeholderAttr = placeholder ? ` data-fallback-placeholder="${escapeHtml(placeholder)}"` : "";
  return `<img src="${escapeHtml(src)}" alt="${escapeHtml(alt)}"${loadingAttr}${classAttr}${fallbackAttr}${placeholderAttr}${extraAttrs} />`;
}

function renderLightbox() {
  if (!state.lightbox) return "";
  return `
    <div class="lightbox" role="dialog" aria-modal="true" aria-label="${escapeHtml(state.lightbox.alt || "Expanded image")}">
      <button class="lightbox-backdrop" type="button" data-action="close-lightbox" aria-label="Close image viewer"></button>
      <figure class="lightbox-panel panel">
        <img src="${escapeHtml(state.lightbox.src)}" alt="${escapeHtml(state.lightbox.alt || "Expanded image")}" />
        <figcaption>${escapeHtml(state.lightbox.alt || "")}</figcaption>
      </figure>
    </div>
  `;
}

function buildFallbackImage(label = "Image unavailable") {
  const text = String(label || "Image unavailable");
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" role="img" aria-label="${escapeHtml(text)}">
      <rect width="256" height="256" fill="#111114"/>
      <rect x="18" y="18" width="220" height="220" fill="#0e0e10" stroke="#2f2f38" stroke-width="4"/>
      <path d="M58 164l34-34 26 26 30-30 50 50" fill="none" stroke="#ff4fa3" stroke-width="8" stroke-linecap="square" stroke-linejoin="miter"/>
      <circle cx="92" cy="98" r="14" fill="#ff8a3d"/>
      <text x="128" y="216" text-anchor="middle" font-family="Inter, Arial, sans-serif" font-size="24" font-weight="700" fill="#b8b8c3">Image unavailable</text>
    </svg>
  `.trim();
  return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`;
}

function isStandaloneApp() {
  return window.matchMedia?.("(display-mode: standalone)")?.matches || window.navigator.standalone === true;
}

function handleFormInput(event) {
  const { name, value } = event.target;
  if (name === "description" && value.length > 160) {
    state.form.description = value.slice(0, 160);
  } else if (name === "pow-bits") {
    state.powBits = Number(value || 0);
  } else if (name === "signedJson") {
    state.signedJson = value;
  } else if (name === "imageFile" || name === "screenshotFiles") {
    return;
  } else if (name === "thumbnail") {
    state.form.thumbnail = value;
    const autoValue = websiteIconUrl(state.form.web);
    if (!value || value === autoValue) {
      state.thumbnailAutoValue = autoValue;
    }
  } else if (name.startsWith("screenshot-")) {
    const index = Number(name.split("-")[1]);
    state.form.screenshots[index] = value;
  } else {
    state.form[name] = value;
    if (name === "web") {
      syncThumbnailFromWebsite();
    }
  }
  handleFileInputs();
}

function handleFormChange(event) {
  const { name } = event.target;
  if (name === "categories") {
    return;
  }
  if (name === "buildTypes") {
    return;
  }
  if (name === "imageFile") {
    setImageAttachment(event.target.files?.[0] || null);
    scheduleRender();
    return;
  }
  if (name === "screenshotFiles") {
    setScreenshotAttachments(event.target.files ? [...event.target.files] : [], { append: true });
    scheduleRender();
    return;
  }
  if (name === "mediaServer") {
    state.selectedMediaServer = state.mediaServers[Number(event.target.value)] || state.mediaServers[0];
  }
  if (name === "existing-app") {
    const selected = [...state.apps.values()].find((app) => app.pubkey === state.pubkey && app.d === event.target.value);
    if (selected) {
      loadAppIntoForm(selected);
    } else {
      state.form = createEmptyForm(state.pubkey);
    }
    scheduleRender();
  }
  if (name === "image" || name === "thumbnail" || name === "repository" || name === "license" || name === "version" || name === "lightningAddress" || name === "authorName" || name === "authorWebsite" || name === "web" || name === "name" || name === "description" || name === "longDescription") {
    state.form[name] = event.target.value;
    if (name === "web") {
      syncThumbnailFromWebsite();
    }
  }
  handleFileInputs();
}

async function handleSubmit(event) {
  event.preventDefault();
  state.submitBusy = true;
  state.submitError = "";
  state.submitSuccess = "";
  scheduleRender();

  try {
    let pubkey = state.pubkey;
    let eventToSign;

    if (state.hasActiveAccount && state.signer) {
      pubkey = await state.signer.getPublicKey();
      state.pubkey = pubkey;
      const prepared = await prepareListingEvent(pubkey);
      const signed = await state.signer.signEvent(prepared);
      eventToSign = signed;
    } else {
      const parsed = safeJsonParse(state.signedJson);
      if (!parsed?.sig || !parsed?.id) {
        throw new Error("Paste a fully signed event JSON payload first.");
      }
      eventToSign = parsed;
      pubkey = parsed.pubkey;
    }

    if (isPowEnabled() && !state.form.existingPowSkipped) {
      // If the signer already signed, the event still needs to be mined first.
      // The event returned by the signer is re-mined and re-signed only when
      // we have direct access to the signing interface.
    }

    if (state.hasActiveAccount && state.signer && state.powBits > 0) {
      const mined = await mineNonce(eventToSign, state.powBits);
      eventToSign = await state.signer.signEvent(mined);
    }

    pool.publish(eventToSign);
    await ingestEvents([eventToSign], { persist: true });
    state.submitSuccess = `Published ${state.form.name} successfully.`;
    navigateToRoute({ name: "detail", pubkey, d: getTagValue(eventToSign.tags || [], "d") }, { replace: true });
  } catch (error) {
    state.submitError = error instanceof Error ? error.message : "Publish failed.";
  } finally {
    state.submitBusy = false;
    scheduleRender();
  }
}

async function prepareListingEvent(pubkey) {
  const existing = state.form.d ? [...state.apps.values()].find((app) => app.pubkey === pubkey && app.d === state.form.d) : null;
  const form = { ...state.form };
  const iconUrl = await resolveIconUrl(form);
  const screenshotUrls = await resolveScreenshotUrls(form);
  form.image = iconUrl;
  form.screenshots = screenshotUrls;
  const event = buildNip89Event(form, pubkey, existing);
  return event;
}

function buildDraftEvent() {
  const draftForm = {
    ...state.form,
    image: state.manualUrls ? state.form.image : state.form.image || "[upload required]",
    screenshots: state.manualUrls ? state.form.screenshots.filter(Boolean) : state.form.screenshotFiles.map((file) => file.name),
  };
  return buildNip89Event(draftForm, state.pubkey || "pubkey");
}

async function resolveIconUrl(form) {
  if (state.manualUrls) return form.image.trim();
  if (form.imageFile instanceof File) {
    const servers = getUploadServers();
    if (!servers.length) throw new Error("Choose a media server before uploading.");
    state.uploadProgress = `Uploading icon to ${servers.length} server${servers.length === 1 ? "" : "s"}…`;
    scheduleRender();
    const preparedFile = await prepareImageFileForUpload(form.imageFile, { maxSize: 1024, quality: 0.86 });
    const uploaded = await uploadFileToServers(preparedFile, servers, state.signer, { mediaType: "avatar", contentType: "image/webp" });
    state.form.imageSources = uploaded.urls;
    form.imageSources = uploaded.urls;
    state.uploadProgress = uploaded.failures.length
      ? `Icon uploaded to ${uploaded.urls.length} server${uploaded.urls.length === 1 ? "" : "s"} (${uploaded.failures.length} failed).`
      : `Icon uploaded to ${uploaded.urls.length} server${uploaded.urls.length === 1 ? "" : "s"}.`;
    scheduleRender();
    return uploaded.url;
  }
  return form.image.trim();
}

async function resolveScreenshotUrls(form) {
  if (state.manualUrls) {
    return (form.screenshots || []).map((url) => url.trim()).filter(Boolean).slice(0, 5);
  }
  const files = [...(form.screenshotFiles || [])];
  if (!files.length) {
    return (form.screenshots || []).map((url) => url.trim()).filter(Boolean).slice(0, 5);
  }
  const servers = getUploadServers();
  if (!servers.length) throw new Error("Choose a media server before uploading.");
  const urls = [];
  const sources = [];
  for (const file of files.slice(0, 5)) {
    state.uploadProgress = `Uploading ${file.name} to ${servers.length} server${servers.length === 1 ? "" : "s"}…`;
    scheduleRender();
    const preparedFile = await prepareImageFileForUpload(file, { maxSize: 1600, quality: 0.84 });
    const uploaded = await uploadFileToServers(preparedFile, servers, state.signer, { mediaType: "banner", contentType: "image/webp" });
    urls.push(uploaded.url);
    state.form.screenshotSources = state.form.screenshotSources || [];
    state.form.screenshotSources.push(uploaded.urls);
    sources.push(uploaded.urls);
    state.uploadProgress = uploaded.failures.length
      ? `${file.name} uploaded to ${uploaded.urls.length} server${uploaded.urls.length === 1 ? "" : "s"} (${uploaded.failures.length} failed).`
      : `${file.name} uploaded to ${uploaded.urls.length} server${uploaded.urls.length === 1 ? "" : "s"}.`;
    scheduleRender();
  }
  form.screenshotSources = sources;
  return urls;
}

async function reportApp(eventId) {
  const app = [...state.apps.values()].find((candidate) => candidate.id === eventId);
  if (!app) return;
  if (!state.hasActiveAccount || !state.signer) {
    state.statusText = "Connect a signer to send reports.";
    scheduleRender();
    return;
  }
  try {
    const pubkey = await state.signer.getPublicKey();
    const report = buildReportEvent({ app, signerPubkey: pubkey });
    let signed = await state.signer.signEvent(report);
    if (state.powBits > 0) {
      signed = await state.signer.signEvent(await mineNonce(signed, state.powBits));
    }
    await Promise.resolve(pool.publish(signed));
    state.statusText = "Report published.";
    scheduleRender();
  } catch (error) {
    state.statusText = error instanceof Error ? error.message : "Failed to publish report.";
    scheduleRender();
  }
}

async function zapApp(eventId) {
  const app = [...state.apps.values()].find((candidate) => candidate.id === eventId);
  if (!app) return;
  if (state.zapComposer?.eventId === app.id) {
    state.zapComposer = null;
  } else {
    state.zapComposer = {
      eventId: app.id,
      amountSats: 21,
      note: "",
      invoice: "",
      busy: false,
      error: "",
    };
  }
  scheduleRender();
}

async function sendZap(eventId) {
  const app = [...state.apps.values()].find((candidate) => candidate.id === eventId);
  if (!app || !state.zapComposer || state.zapComposer.eventId !== app.id) return;
  if (!state.hasActiveAccount || !state.signer) {
    state.statusText = "Connect a signer to send zaps.";
    scheduleRender();
    return;
  }

  const composer = state.zapComposer;
  const amountSats = Number(composer.amountSats);
  if (!Number.isFinite(amountSats) || amountSats <= 0) {
    composer.error = "Enter a positive amount.";
    scheduleRender();
    return;
  }

  try {
    composer.busy = true;
    composer.error = "";
    composer.invoice = "";
    scheduleRender();

    const metadata = await fetchLightningAddressMetadata(app.lightningAddress);
    const amountMsats = Math.round(amountSats * 1000);
    const minMsats = Number(metadata.minSendable || 0);
    const maxMsats = Number(metadata.maxSendable || Number.POSITIVE_INFINITY);
    if (amountMsats < minMsats || amountMsats > maxMsats) {
      throw new Error("Zap amount is outside the recipient's allowed range.");
    }

    const senderPubkey = await state.signer.getPublicKey();
    const { invoice } = await requestZapInvoice({
      metadata,
      senderPubkey,
      recipientPubkey: app.pubkey,
      event: app,
      recipientRelays: state.relays.length ? state.relays : DEFAULT_RELAYS,
      amountMsats,
      content: composer.note,
    });

    const walletConnection = state.walletConnection.trim();
    if (walletConnection) {
      try {
        await payInvoiceWithNwc(walletConnection, invoice);
        state.statusText = "Zap paid with NWC.";
        state.zapComposer = null;
        scheduleRender();
        return;
      } catch {
        // Fall through to WebLN or manual payment when the configured wallet fails.
      }
    }

    if (globalThis.window?.webln?.enable && globalThis.window?.webln?.sendPayment) {
      await globalThis.window.webln.enable();
      await globalThis.window.webln.sendPayment(invoice);
      state.statusText = "Zap paid with WebLN.";
      state.zapComposer = null;
    } else {
      state.zapComposer = {
        ...composer,
        busy: false,
        invoice,
        error: "",
      };
      state.statusText = "Invoice ready.";
    }
    scheduleRender();
  } catch (error) {
    state.zapComposer = {
      ...composer,
      busy: false,
      error: error instanceof Error ? error.message : "Failed to create zap.",
    };
    state.statusText = state.zapComposer.error;
    scheduleRender();
  }
}

async function copyZapInvoice() {
  if (!state.zapComposer?.invoice) return;
  try {
    await navigator.clipboard.writeText(state.zapComposer.invoice);
    state.statusText = "Invoice copied.";
  } catch {
    state.statusText = "Could not copy the invoice.";
  }
  scheduleRender();
}

async function blockApp(eventId) {
  const app = [...state.apps.values()].find((candidate) => candidate.id === eventId);
  if (!app) return;
  if (!state.hasActiveAccount || !state.signer) {
    state.statusText = "Connect a signer to update your mute list.";
    scheduleRender();
    return;
  }

  try {
    const pubkey = await state.signer.getPublicKey();
    const existingMuteList = state.blockListEvents.get(state.pubkey) || null;
    const muted = buildMuteListEvent({
      signerPubkey: pubkey,
      existingEvent: existingMuteList,
      addPubkeys: [app.pubkey],
    });
    let signed = await state.signer.signEvent(muted);
    if (state.powBits > 0) {
      signed = await state.signer.signEvent(await mineNonce(signed, state.powBits));
    }
    await ingestEvents([signed], { persist: true });
    await Promise.resolve(pool.publish(signed));
    state.statusText = "Mute list updated.";
    if (state.route.name === "detail" && state.route.pubkey === app.pubkey) {
      navigateToRoute({ name: "browse" }, { replace: true });
    }
    scheduleRender();
  } catch (error) {
    state.statusText = error instanceof Error ? error.message : "Failed to update mute list.";
    scheduleRender();
  }
}

async function deleteApp(eventId) {
  const app = [...state.apps.values()].find((candidate) => candidate.id === eventId);
  if (!app) return;
  if (!state.hasActiveAccount || !state.signer) {
    state.statusText = "Connect a signer to delete your app listing.";
    scheduleRender();
    return;
  }

  if (!window.confirm(`Are you sure you want to delete "${app.name}" from Nostr? This action is permanent.`)) {
    return;
  }

  try {
    const pubkey = await state.signer.getPublicKey();
    const deletionEvent = buildDeleteEvent({
      app,
      signerPubkey: pubkey,
    });
    let signed = await state.signer.signEvent(deletionEvent);
    if (state.powBits > 0) {
      signed = await state.signer.signEvent(await mineNonce(signed, state.powBits));
    }
    await ingestEvents([signed], { persist: true });
    await Promise.resolve(pool.publish(signed));
    state.statusText = "App deletion request published.";
    scheduleRender();
  } catch (error) {
    state.statusText = error instanceof Error ? error.message : "Failed to delete app listing.";
    scheduleRender();
  }
}

function loadAppIntoForm(app) {
  const thumbnailAutoValue = websiteIconUrl(app.web);
  state.form = normalizeListingFormValues({
    pubkey: app.pubkey,
    d: app.d,
    name: app.name || "",
    description: app.description || "",
    longDescription: app.longDescription || "",
    categories: [...app.categories],
    buildTypes: [...(app.buildTypes || [])],
    image: app.image || "",
    thumbnail: app.thumbnail || "",
    web: app.web || "",
    screenshots: [...(app.screenshots || []), "", "", "", "", ""].slice(0, 5),
    repository: app.repository || "",
    license: app.license || "",
    version: app.version || "",
    authorName: app.authorName || "",
    authorWebsite: app.authorWebsite || "",
    lightningAddress: app.lightningAddress || "",
    imageSources: [...(app.imageSources || [])],
    screenshotSources: [...(app.screenshotSources || [])],
    imageFile: null,
    screenshotFiles: [],
    imagePreviewUrl: "",
    screenshotPreviewUrls: [],
  });
  state.thumbnailAutoValue = thumbnailAutoValue;
  syncThumbnailFromWebsite();
}

function createEmptyForm(pubkey = "") {
  return {
    pubkey,
    d: "",
    name: "",
    description: "",
    longDescription: "",
    categories: [],
    buildTypes: [],
    image: "",
    thumbnail: "",
    web: "",
    screenshots: ["", "", "", "", ""],
    repository: "",
    license: "",
    version: "",
    authorName: "",
    authorWebsite: "",
    lightningAddress: "",
    imageSources: [],
    screenshotSources: [],
    imageFile: null,
    screenshotFiles: [],
    imagePreviewUrl: "",
    screenshotPreviewUrls: [],
  };
}

function setImageAttachment(file) {
  if (state.form.imagePreviewUrl) {
    URL.revokeObjectURL(state.form.imagePreviewUrl);
  }
  state.form.imageFile = file || null;
  state.form.imagePreviewUrl = file ? URL.createObjectURL(file) : "";
}

function setScreenshotAttachments(files, { append = false } = {}) {
  for (const previewUrl of state.form.screenshotPreviewUrls || []) {
    URL.revokeObjectURL(previewUrl);
  }
  state.form.screenshotFiles = append ? mergeSelectedFiles(state.form.screenshotFiles, files) : mergeSelectedFiles([], files);
  state.form.screenshotPreviewUrls = state.form.screenshotFiles.map((file) => URL.createObjectURL(file));
}

function syncThumbnailFromWebsite() {
  const autoValue = websiteIconUrl(state.form.web);
  if (!autoValue) return;
  if (!state.form.thumbnail || state.form.thumbnail === state.thumbnailAutoValue) {
    state.form.thumbnail = autoValue;
  }
  state.thumbnailAutoValue = autoValue;
}

function clearAttachmentPreview(kind, index = null) {
  if (kind === "image") {
    if (state.form.imagePreviewUrl) URL.revokeObjectURL(state.form.imagePreviewUrl);
    state.form.imageFile = null;
    state.form.imagePreviewUrl = "";
    return;
  }

  const files = [...(state.form.screenshotFiles || [])];
  const previews = [...(state.form.screenshotPreviewUrls || [])];
  if (index === null || index < 0 || index >= files.length) return;
  const [removedPreview] = previews.splice(index, 1);
  if (removedPreview) URL.revokeObjectURL(removedPreview);
  files.splice(index, 1);
  state.form.screenshotFiles = files;
  state.form.screenshotPreviewUrls = previews;
}

function getUploadServers() {
  return buildUploadServerTargets({
    userServers: state.userMediaServers,
    fallbackServers: state.mediaServers,
  });
}

function handleFileInputs() {
  const imageFile = document.querySelector("input[name='imageFile']");
  if (imageFile?.files?.[0] && imageFile.files[0] !== state.form.imageFile) setImageAttachment(imageFile.files[0]);
}

function normalizeInitialLocation() {
  const route = getRoute();
  const path = routeToPath(route);
  const currentPath = window.location.pathname.replace(/\/+$/, "") || "/";
  const hasLegacyHash = Boolean(window.location.hash && window.location.hash !== "#");
  if (currentPath !== path || hasLegacyHash) {
    window.history.replaceState(null, "", path);
  }
  state.route = route;
}

function navigateToRoute(route, { replace = false } = {}) {
  const nextRoute = typeof route === "string" ? { name: route } : route;
  const path = routeToPath(nextRoute);
  if (replace) {
    window.history.replaceState(null, "", path);
  } else {
    window.history.pushState(null, "", path);
  }
  state.route = nextRoute;
  state.accountMenuOpen = false;
  routeSideEffects();
  scheduleRender();
}

function handleDocumentNavigation(event) {
  if (event.defaultPrevented) return;
  if (event.button !== 0) return;
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;

  const anchor = event.target instanceof Element ? event.target.closest("a[href]") : null;
  if (!anchor) return;
  if ((anchor.target && anchor.target !== "_self") || anchor.hasAttribute("download")) return;

  const href = anchor.getAttribute("href") || "";
  if (href.startsWith("mailto:") || href.startsWith("tel:") || href.startsWith("lightning:")) return;

  const url = new URL(anchor.href, window.location.href);
  if (url.origin !== window.location.origin) return;
  const route = parseRouteFromLocation(url, { fallback: false });
  if (!route) return;

  event.preventDefault();
  navigateToRoute(route);
}

function isPowEnabled() {
  return Number(state.powBits || 0) > 0;
}

function isDeleted(app) {
  for (const ref of deletionReferencesForEvent(app)) {
    if (state.deletions.has(ref)) return true;
  }
  return false;
}

function getRoute() {
  return parseRouteFromLocation(window.location);
}

function parseRouteFromLocation(locationLike, { fallback = true } = {}) {
  const pathname = String(locationLike?.pathname || "/");
  const hash = String(locationLike?.hash || "");
  const hashValue = hash.replace(/^#/, "");

  if (hashValue) {
    const route = parseRouteValue(hashValue);
    if (route) return route;
  }

  const routeFromPath = parseRouteValue(pathname.replace(/^\//, ""));
  if (routeFromPath) return routeFromPath;

  return fallback ? { name: "browse" } : null;
}

function parseRouteValue(value) {
  const normalized = String(value || "").replace(/^\/+/, "").replace(/\/+$/, "");
  if (!normalized || normalized === "browse" || normalized === "index.html") return { name: "browse" };
  if (normalized === "submit") return { name: "submit" };
  if (normalized.startsWith("app/")) {
    const [, pubkey, d] = normalized.split("/");
    if (pubkey && d) {
      return {
        name: "detail",
        pubkey: safeDecodeURIComponent(pubkey),
        d: safeDecodeURIComponent(d),
      };
    }
  }
  return null;
}

function routeToPath(route) {
  if (route?.name === "submit") return "/submit";
  if (route?.name === "detail" && route.pubkey && route.d) {
    return `/app/${encodeURIComponent(route.pubkey)}/${encodeURIComponent(route.d)}`;
  }
  return "/browse";
}

function updateSeoMetadata() {
  const seo = buildSeoMetadata();
  setHeadAttribute('meta[name="description"]', "meta", "content", seo.description, { name: "description" });
  setHeadAttribute('meta[name="robots"]', "meta", "content", seo.robots, { name: "robots" });
  setHeadAttribute('link[rel="canonical"]', "link", "href", seo.canonical, { rel: "canonical" });
  setHeadAttribute('meta[property="og:site_name"]', "meta", "content", SITE_NAME, { property: "og:site_name" });
  setHeadAttribute('meta[property="og:title"]', "meta", "content", seo.title, { property: "og:title" });
  setHeadAttribute('meta[property="og:description"]', "meta", "content", seo.description, { property: "og:description" });
  setHeadAttribute('meta[property="og:type"]', "meta", "content", seo.ogType, { property: "og:type" });
  setHeadAttribute('meta[property="og:url"]', "meta", "content", seo.canonical, { property: "og:url" });
  setHeadAttribute('meta[property="og:image"]', "meta", "content", seo.image, { property: "og:image" });
  setHeadAttribute('meta[name="twitter:card"]', "meta", "content", seo.twitterCard, { name: "twitter:card" });
  setHeadAttribute('meta[name="twitter:title"]', "meta", "content", seo.title, { name: "twitter:title" });
  setHeadAttribute('meta[name="twitter:description"]', "meta", "content", seo.description, { name: "twitter:description" });
  setHeadAttribute('meta[name="twitter:image"]', "meta", "content", seo.image, { name: "twitter:image" });
  document.title = seo.title;

  const jsonLdId = "seo-jsonld";
  let jsonLd = document.getElementById(jsonLdId);
  if (seo.jsonLd) {
    if (!jsonLd) {
      jsonLd = document.createElement("script");
      jsonLd.type = "application/ld+json";
      jsonLd.id = jsonLdId;
      document.head.appendChild(jsonLd);
    }
    jsonLd.textContent = JSON.stringify(seo.jsonLd);
  } else if (jsonLd) {
    jsonLd.remove();
  }
}

function buildSeoMetadata() {
  const canonical = new URL(routeToPath(state.route), window.location.origin).href;
  const baseDescription = SITE_DESCRIPTION;

  if (state.route.name === "submit") {
    return {
      title: `Submit an app listing | ${SITE_NAME}`,
      description: "Publish or update your own Nostr app listing.",
      canonical,
      robots: "noindex,nofollow",
      ogType: "website",
      image: DEFAULT_OG_IMAGE,
      twitterCard: "summary",
      jsonLd: null,
    };
  }

  if (state.route.name === "detail") {
    const app = state.apps.get(`${state.route.pubkey}:${state.route.d}`);
    const description = clampText(app?.longDescription || app?.description || baseDescription, 220);
    const image = absoluteSeoImageUrl(app?.image || app?.imageSources?.[0] || DEFAULT_OG_IMAGE);
    const title = app?.name ? `${app.name} | ${SITE_NAME}` : `App listing | ${SITE_NAME}`;
    return {
      title,
      description,
      canonical,
      robots: "index,follow",
      ogType: "website",
      image,
      twitterCard: "summary_large_image",
      jsonLd: app ? buildSoftwareApplicationJsonLd(app, canonical, image, description) : null,
    };
  }

  return {
    title: `Browse Nostr apps | ${SITE_NAME}`,
    description: baseDescription,
    canonical,
    robots: "index,follow",
    ogType: "website",
    image: DEFAULT_OG_IMAGE,
    twitterCard: "summary_large_image",
    jsonLd: null,
  };
}

function buildSoftwareApplicationJsonLd(app, canonical, image, description) {
  const ld = {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    name: app.name,
    description,
    url: app.web || canonical,
    applicationCategory: app.categories?.[0] || "Application",
    operatingSystem: "Web",
    image,
    author: app.authorName
      ? {
          "@type": "Person",
          name: app.authorName,
        }
      : undefined,
  };

  if (!app.authorName) delete ld.author;
  if (app.version) ld.softwareVersion = app.version;
  if (app.license) ld.license = app.license;
  if (app.repository) ld.codeRepository = app.repository;
  return ld;
}

function absoluteSeoImageUrl(url) {
  if (!url) return DEFAULT_OG_IMAGE;
  try {
    return new URL(url, window.location.origin).href;
  } catch {
    return DEFAULT_OG_IMAGE;
  }
}

function setHeadAttribute(selector, tagName, attributeName, value, baseAttributes = {}) {
  let element = document.head.querySelector(selector);
  if (!element) {
    element = document.createElement(tagName);
    for (const [key, attrValue] of Object.entries(baseAttributes)) {
      element.setAttribute(key, attrValue);
    }
    document.head.appendChild(element);
  }
  element.setAttribute(attributeName, String(value));
  return element;
}

function safeDecodeURIComponent(value) {
  try {
    return decodeURIComponent(String(value));
  } catch {
    return String(value);
  }
}

function loadJson(key, fallback) {
  const raw = localStorage.getItem(key);
  return raw ? safeJsonParse(raw, fallback) : fallback;
}

function loadString(key, fallback) {
  const raw = localStorage.getItem(key);
  return raw ? String(raw) : fallback;
}

function loadTheme() {
  const saved = localStorage.getItem(STORAGE_KEYS.theme);
  if (saved === "light" || saved === "dark") return saved;
  return window.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme === "light" ? "light" : "dark";
}

function loadDraft() {
  return safeJsonParse(localStorage.getItem(STORAGE_KEYS.drafts), null);
}

function routeCleanup() {
  const draft = {
    pubkey: state.form.pubkey,
    d: state.form.d,
    name: state.form.name,
    description: state.form.description,
    longDescription: state.form.longDescription,
    categories: state.form.categories,
    buildTypes: state.form.buildTypes,
    image: state.form.image,
    thumbnail: state.form.thumbnail,
    web: state.form.web,
    screenshots: state.form.screenshots,
    repository: state.form.repository,
    license: state.form.license,
    version: state.form.version,
    authorName: state.form.authorName,
    authorWebsite: state.form.authorWebsite,
    lightningAddress: state.form.lightningAddress,
    imageSources: state.form.imageSources,
    screenshotSources: state.form.screenshotSources,
    signedJson: state.signedJson,
    powBits: state.powBits,
    manualUrls: state.manualUrls,
  };
  localStorage.setItem(STORAGE_KEYS.drafts, JSON.stringify(draft));
}

function initDraft() {
  const draft = loadDraft();
  if (!draft) return;
  state.form = normalizeListingFormValues({ ...state.form, ...draft });
  state.signedJson = draft.signedJson || "";
  state.powBits = Number(draft.powBits || 0);
  state.thumbnailAutoValue = websiteIconUrl(state.form.web);
  syncThumbnailFromWebsite();
}

window.addEventListener("beforeunload", routeCleanup);
initDraft();

function formatForPreview(value) {
  return clampText(value, 80);
}

function isPlaceholder() {
  return false;
}

export { buildNip89Event, parseNip89Event, slugify, nostrEventHash };
