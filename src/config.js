export const DEFAULT_RELAYS = [
  "wss://relay.damus.io",
  "wss://nos.lol",
  "wss://relay.primal.net",
  "wss://relay.snort.social",
];

export const DEFAULT_MEDIA_SERVERS = [
  {
    name: "Blossom example",
    type: "blossom",
    uploadUrl: "https://blossom.nostr.wine/upload",
    baseUrl: "https://blossom.nostr.wine",
  },
  {
    name: "NIP-96 example",
    type: "nip96",
    uploadUrl: "https://nostr.build/api/v2/upload",
    baseUrl: "https://nostr.build",
  },
];

export const CATEGORIES = [
  "social",
  "tools",
  "reading",
  "writing",
  "finance",
  "games",
  "media",
  "education",
  "developer",
  "design",
  "marketplace",
  "productivity",
];

export const BUILD_TYPES = ["ios", "android", "web", "desktop"];

export const MODERATOR_PUBKEY = "";

export const STORAGE_KEYS = {
  relays: "apps.nostr.relays",
  mediaServer: "apps.nostr.media-server",
  walletConnection: "apps.nostr.wallet-connection",
  settings: "apps.nostr.settings",
  drafts: "apps.nostr.drafts",
  theme: "apps.nostr.theme",
  gridSize: "apps.nostr.grid-size",
  sortOrder: "apps.nostr.sort-order",
};
