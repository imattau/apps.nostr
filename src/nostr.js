import { DEFAULT_RELAYS, STORAGE_KEYS } from "./config.js";
import { bytesToHex, countLeadingZeroBits, hexToBytes } from "./utils.js";

function hasWebSocketSupport() {
  return typeof WebSocket !== "undefined";
}

export class RelayPool {
  constructor(relays = DEFAULT_RELAYS) {
    this.relays = [];
    this.sockets = new Map();
    this.subscriptions = new Map();
    this.eventListeners = new Set();
    this.statusListeners = new Set();
    this.setRelays(relays);
  }

  onEvent(listener) {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  onStatus(listener) {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  emitStatus(status) {
    for (const listener of this.statusListeners) listener(status);
  }

  emitEvent(relayUrl, message) {
    for (const listener of this.eventListeners) listener(relayUrl, message);
  }

  setRelays(relays) {
    const next = [...new Set((relays || []).map((relay) => String(relay).trim()).filter(Boolean))];
    this.relays = next;
    if (!hasWebSocketSupport()) return;

    for (const [relayUrl, socket] of this.sockets.entries()) {
      if (!next.includes(relayUrl)) {
        try {
          socket.close();
        } catch {
          // ignore
        }
        this.sockets.delete(relayUrl);
      }
    }

    for (const relayUrl of next) {
      if (!this.sockets.has(relayUrl)) {
        this.openRelay(relayUrl);
      }
    }
  }

  openRelay(relayUrl) {
    const socket = new WebSocket(relayUrl);
    socket.addEventListener("open", () => {
      this.emitStatus({ relayUrl, state: "open" });
      for (const sub of this.subscriptions.values()) {
        socket.send(JSON.stringify(["REQ", sub.id, sub.filter]));
      }
    });
    socket.addEventListener("message", (event) => {
      const message = parseMessage(event.data);
      if (!message) return;
      this.emitEvent(relayUrl, message);
      this.handleMessage(relayUrl, socket, message);
    });
    socket.addEventListener("close", () => {
      this.emitStatus({ relayUrl, state: "closed" });
      this.sockets.delete(relayUrl);
      if (this.relays.includes(relayUrl)) {
        window.setTimeout(() => this.openRelay(relayUrl), 1500);
      }
    });
    socket.addEventListener("error", () => {
      this.emitStatus({ relayUrl, state: "error" });
    });
    this.sockets.set(relayUrl, socket);
  }

  handleMessage(relayUrl, socket, message) {
    const [type, ...rest] = message;
    if (type === "EOSE") {
      const [subId] = rest;
      const sub = this.subscriptions.get(subId);
      if (sub) {
        sub.eoseRelays.add(relayUrl);
        if (sub.eoseRelays.size >= this.relays.length) {
          sub.onEose?.();
        }
      }
    }
  }

  subscribe(filter, { onEvent, onEose } = {}) {
    const id = crypto.randomUUID();
    const sub = {
      id,
      filter,
      onEvent,
      onEose,
      eoseRelays: new Set(),
    };
    this.subscriptions.set(id, sub);

    for (const socket of this.sockets.values()) {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(["REQ", id, filter]));
      }
    }

    return {
      id,
      close: () => {
        this.subscriptions.delete(id);
        for (const socket of this.sockets.values()) {
          if (socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify(["CLOSE", id]));
          }
        }
      },
    };
  }

  async query(filter, timeoutMs = 2000) {
    const events = new Map();
    return await new Promise((resolve) => {
      const subscription = this.subscribe(filter, {
        onEvent: (_relayUrl, message) => {
          if (message[0] !== "EVENT") return;
          const event = message[2];
          const key = event.id || JSON.stringify(event);
          events.set(key, event);
        },
        onEose: () => {
          subscription.close();
          resolve([...events.values()]);
        },
      });

      window.setTimeout(() => {
        subscription.close();
        resolve([...events.values()]);
      }, timeoutMs);
    });
  }

  publish(event) {
    const payload = JSON.stringify(["EVENT", event]);
    for (const socket of this.sockets.values()) {
      if (socket.readyState === WebSocket.OPEN) socket.send(payload);
    }
  }
}

export function parseMessage(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function createSigner(windowNostr = globalThis.window?.nostr) {
  if (!windowNostr) return null;
  return {
    async getPublicKey() {
      if (typeof windowNostr.getPublicKey === "function") {
        return windowNostr.getPublicKey();
      }
      if (typeof windowNostr.npub === "string") return windowNostr.npub;
      throw new Error("No public key method exposed by the signer.");
    },
    async signEvent(event) {
      if (typeof windowNostr.signEvent !== "function") {
        throw new Error("The connected signer cannot sign events.");
      }
      return windowNostr.signEvent(event);
    },
    async encrypt(pubkey, plaintext) {
      if (typeof windowNostr.nip04?.encrypt !== "function") {
        throw new Error("NIP-04 encryption is not supported by this signer.");
      }
      return windowNostr.nip04.encrypt(pubkey, plaintext);
    },
  };
}

export function isNip07Available() {
  return typeof window !== "undefined" && Boolean(window.nostr?.signEvent);
}

export async function mineNonce(event, bits) {
  const targetBits = Number(bits || 0);
  if (!targetBits || targetBits <= 0) return event;

  const base = {
    kind: event.kind,
    pubkey: event.pubkey,
    created_at: event.created_at,
    tags: event.tags.filter((tag) => tag[0] !== "nonce"),
    content: event.content || "",
  };

  let nonce = 0;
  while (nonce < 2_000_000) {
    const candidate = {
      ...base,
      tags: [...base.tags, ["nonce", String(nonce), String(targetBits)]],
    };
    const hash = await nostrEventHash(candidate);
    if (countLeadingZeroBits(hash) >= targetBits) {
      return candidate;
    }
    nonce += 1;
  }

  throw new Error(`Unable to mine ${targetBits} bits within the configured attempt limit.`);
}

export async function nostrEventHash(event) {
  const serialized = JSON.stringify([
    0,
    event.pubkey,
    event.created_at,
    event.kind,
    event.tags || [],
    event.content || "",
  ]);
  return bytesToHex(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(serialized))));
}
