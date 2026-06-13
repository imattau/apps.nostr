# apps.nostr
A decentralised Nostr app store.

apps.nostr is a simple place to discover and publish Nostr apps.

It was built so builders can submit an app easily, without waiting for someone else to approve it first. The store content lives in Nostr events, images can live on Blossom, and developers can be zapped directly.

## Runtime

- `vite`
- `applesauce-core`
- `applesauce-relay`
- `applesauce-accounts`
- `window.nostr.js` loaded from the browser CDN

The app uses an Applesauce adapter for relay/event-store/account support and loads `window.nostr.js` in the page shell so NIP-07 and NIP-46/Nostr Connect both work through the same `window.nostr` surface.

The app is also installable as a PWA in browsers that support Web App manifests and service workers.

## Setup

- `npm install`
- `npm run dev`

The development server runs the app locally with live reload.

## Build

- `npm run build`

This creates a production build in `dist/`.

## Deploy

The repository includes a remote deploy helper for a static Linux host:

- `bash scripts/deploy-remote.sh --host user@server`

It builds `dist/`, syncs the repo to the remote machine, and runs the app from a small Python SPA server behind an optional Caddy or Nginx reverse proxy.
