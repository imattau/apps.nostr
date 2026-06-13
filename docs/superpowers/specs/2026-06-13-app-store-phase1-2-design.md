# Nostr App Store — Phase 1+2 Design: Foundation, Browse & Submit

## Context

`apps.nostr` is a decentralized app store built on Nostr. App metadata is published
as NIP-89 `kind 31922` parameterized-replaceable events (replaceable per
`(pubkey, d)`). The full product vision spans 7 phases (foundation, submit,
image uploads, detail page, moderation, caching/polish, testing) — see the
project's original planning notes for the complete roadmap.

This spec covers the first sub-project: **Phase 1 (Foundation + Browse) and
Phase 2 (Submit)** combined, producing an app that can browse existing NIP-89
apps and let a logged-in user publish or update their own listing, with manual
image URLs (no upload integration yet).

## Goals

- Static SPA, deployable to any static host, built with Vite.
- Browse all `kind 31922` events from default relays, deduplicated and
  filtered for expiry, with search and category filtering.
- View full details of a single app.
- Let a logged-in user (NIP-07 extension or NIP-46 remote signer) publish a
  new app listing or edit/update their own existing listing.

## Out of Scope (later phases)

- Blossom/NIP-96 image uploads (icon/screenshots are plain URL text inputs
  for now).
- Relay settings UI (relays are hardcoded defaults from `config.ts`).
- IndexedDB caching, virtual scrolling.
- Moderation: NIP-13 proof-of-work, report button, NIP-09 deletion checks,
  NIP-51 curator allow-lists.
- Lightning zap button.
- Screenshot carousel/lightbox (detail page shows a simple image list).

## Tech Stack

- **Vite + TypeScript** — build tooling and type safety for NIP-89 event
  shapes.
- **Lit** — web components for the UI layer.
- **applesauce-core** + **applesauce-relay** — relay pool, subscriptions, and
  an `EventStore` that handles replaceable-event semantics (keeps the latest
  event per `(pubkey, kind, d)` automatically).
- **applesauce-accounts** (or equivalent applesauce signer package) — NIP-07
  extension login and NIP-46 remote-signer login, exposed as an observable
  active-account.
- **Tailwind CSS** (Vite plugin) for styling.
- **marked** (or similar) for rendering markdown long-descriptions.
- A small hand-rolled hash router for 3 routes: `#browse` (default),
  `#app/:pubkey/:d`, `#submit`.

Output is a static `dist/` folder, deployable to GitHub Pages, Netlify,
Vercel, IPFS, etc.

## NIP-89 Event Schema

`kind 31922`, tags: `d`, `name`, `description`, `web`, `image`, `thumbnail`,
`published_at`, `t` (repeatable, categories), `version`, `repository`,
`license`, `lightning_address`.

`content` is a JSON string:

```json
{
  "longDescription": "markdown text",
  "screenshots": ["https://...", "https://..."],
  "authorName": "Display Name",
  "authorWebsite": "https://...",
  "price": { "amount": 0, "currency": "sats", "lightningAddress": "user@example.com" }
}
```

Validity rules: latest event per `(pubkey, d)` is canonical; events with an
expired NIP-40 `expiration` tag are ignored.

## Data Layer

- `config.ts` — `DEFAULT_RELAYS` (hardcoded array of relay URLs) and
  `CATEGORIES` (fixed list of category strings for the `t` tag dropdown).
- `nostr.ts` — initializes an applesauce `RelayPool` and `EventStore`, opens a
  persistent subscription for `{ kinds: [31922] }` across `DEFAULT_RELAYS`.
  The `EventStore` deduplicates by `(pubkey, d)`, keeping the newest
  `created_at`. A wrapper filter drops events whose NIP-40 `expiration` tag is
  in the past.
- All UI components subscribe to the EventStore's RxJS observable for
  `kind 31922` and re-render reactively as events stream in. No manual
  polling, no persistent cache (deferred to a later "polish" phase).

## Auth

- `auth.ts` wraps applesauce-accounts with an `AccountManager` supporting two
  account types:
  - **NIP-07**: browser extension (`window.nostr`).
  - **NIP-46**: remote signer via `bunker://` URI or NIP-05 identifier.
- `<login-button>` (Lit component) offers "Connect extension" and "Connect
  remote signer" (prompts for the bunker URI/NIP-05).
- The active account (pubkey + signer) is exposed as an observable. The nav
  bar and `<app-submit>` both react to login state.
- If no account is active, `<app-submit>` shows a login prompt instead of the
  form.

## Routing

Simple hash-based router mapping:

- `#browse` (default) → `<app-browse>`
- `#app/:pubkey/:d` → `<app-detail>`
- `#submit` → `<app-submit>`

## Browse View (`<app-browse>`, `#browse`)

- Subscribes to the EventStore's kind-31922 observable and renders a
  responsive grid of `<app-card>` components: icon (`image` tag), name,
  category badges (`t` tags), author (`authorName` from content JSON,
  falling back to truncated pubkey), short `description`.
- A search input filters the in-memory list client-side on `name` and
  `description`. A category dropdown filters on `t` tags. Both operate purely
  on already-received events — no relay re-query.
- Clicking a card navigates to `#app/<pubkey>/<d>`.

## Detail View (`<app-detail>`, `#app/:pubkey/:d`)

- Looks up the event from the EventStore by `(pubkey, d)`. If not present
  (e.g., a direct link visited before the subscription has filled in), issues
  a one-off relay query filtered to that author + `kind: 31922`.
- Renders:
  - Icon, name, `version`, author (`authorName` or truncated pubkey),
    category badges.
  - Markdown-rendered `longDescription` (via `marked`).
  - Screenshots as a simple vertical/grid list of `<img>` elements (no
    carousel or lightbox).
  - Links: "Open App" (`web` tag, primary CTA), `repository`, author website
    (`authorWebsite`).
- No zap button, no report button (both require infrastructure from later
  phases).

## Submit View (`<app-submit>`, `#submit`)

- Requires an active account; shows a login prompt via `<login-button>` if
  none.
- Form fields (per the original plan's table), with file pickers replaced by
  plain URL text inputs for icon and screenshots (max 5 screenshot URL
  inputs):

  | Field | Required | Maps to |
  |---|---|---|
  | App Name | Yes | `d` (slugified) and `name` tag |
  | Short Description | Yes (≤160 chars) | `description` tag |
  | Long Description | Yes | `content.longDescription` (markdown) |
  | Category | Yes (1-3) | `t` tags |
  | Icon URL | Yes | `image` tag |
  | App URL | Yes | `web` tag |
  | Screenshot URLs | No (up to 5) | `content.screenshots` |
  | Repository URL | No | `repository` tag |
  | License | No | `license` tag |
  | Version | No | `version` tag |
  | Author display name | No | `content.authorName` |
  | Author website | No | `content.authorWebsite` |
  | Lightning address | No | `lightning_address` tag |

- **Edit my app**: queries the EventStore (or relays) for
  `{ kinds: [31922], authors: [activePubkey] }`. A dropdown lists the user's
  existing apps by name; selecting one loads its fields into the form,
  preserving its `d` tag so re-publishing overwrites it (correct replaceable
  event behavior, no collision handling needed).
- On submit:
  1. Validate required fields.
  2. Build the `kind 31922` event: tags from form fields, `content` as
     JSON-stringified object per the schema above, `published_at` set to
     now.
  3. Sign via the active account's signer.
  4. Publish to `DEFAULT_RELAYS` via the relay pool.
  5. On success, navigate to `#app/<pubkey>/<d>` for the new/updated app.

## Testing

- Manual testing via Vite dev server against live relays for browse/submit
  flows (login with extension and remote signer, publish, edit, browse,
  detail view).
- Unit tests (Vitest) for pure functions: event-building from form data,
  parsing `content` JSON, slugification, expiration filtering.
