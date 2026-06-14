import { micromark } from "micromark";

export function slugify(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-")
    .slice(0, 80);
}

export function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function safeJsonParse(value, fallback = null) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

export function truncatePubkey(pubkey, length = 12) {
  if (!pubkey) return "";
  if (pubkey.length <= length) return pubkey;
  return `${pubkey.slice(0, 8)}…${pubkey.slice(-4)}`;
}

export function formatTimestamp(unixSeconds) {
  if (!unixSeconds) return "unknown";
  const date = new Date(Number(unixSeconds) * 1000);
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

export function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

export function clampText(value, maxLength) {
  const text = String(value || "");
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

export function formatBytes(bytes) {
  const value = Number(bytes || 0);
  if (!Number.isFinite(value) || value <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  const rounded = size >= 10 || unit === 0 ? Math.round(size) : Math.round(size * 10) / 10;
  return `${rounded} ${units[unit]}`;
}

export function markdownToHtml(markdown) {
  const input = String(markdown || "").replace(/\r\n/g, "\n");
  if (!input.trim()) return "<p class=\"muted\">No description provided.</p>";
  return micromark(input, {
    allowDangerousHtml: false,
    allowDangerousProtocol: false,
  });
}

export async function sha256Hex(value) {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return bytesToHex(new Uint8Array(digest));
}

export async function sha256Base64(value) {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return bytesToBase64(new Uint8Array(digest));
}

export function bytesToHex(bytes) {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function bytesToBase64(bytes) {
  if (typeof btoa === "function") {
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
  }
  return Buffer.from(bytes).toString("base64");
}

export function hexToBytes(hex) {
  const normalized = String(hex || "").replace(/^0x/, "");
  const output = new Uint8Array(normalized.length / 2);
  for (let i = 0; i < output.length; i += 1) {
    output[i] = Number.parseInt(normalized.slice(i * 2, i * 2 + 2), 16);
  }
  return output;
}

export function countLeadingZeroBits(hex) {
  let bits = 0;
  for (const char of hex) {
    const value = Number.parseInt(char, 16);
    if (value === 0) {
      bits += 4;
      continue;
    }
    for (let shift = 3; shift >= 0; shift -= 1) {
      if ((value >> shift) & 1) return bits;
      bits += 1;
    }
    return bits;
  }
  return bits;
}

export function getTagValue(tags, name) {
  const tag = tags.find((entry) => entry[0] === name);
  return tag ? tag[1] : undefined;
}

export function getTagValues(tags, name) {
  return tags.filter((entry) => entry[0] === name).map((entry) => entry[1]).filter(Boolean);
}

export function resolveUrl(baseUrl, path = "") {
  return new URL(path, baseUrl).toString();
}

export function websiteIconUrl(website) {
  const value = String(website || "").trim();
  if (!value) return "";
  try {
    const url = new URL(value);
    return new URL("/favicon.ico", url.origin).toString();
  } catch {
    return "";
  }
}
