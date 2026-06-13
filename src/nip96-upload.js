import { bytesToBase64, bytesToHex, sha256Hex } from "./utils.js";

export async function createNip98AuthHeader({ signer, requestUrl, method, body }) {
  const tags = [
    ["u", requestUrl],
    ["method", method.toUpperCase()],
  ];

  if (body instanceof Blob) {
    const buffer = new Uint8Array(await body.arrayBuffer());
    tags.push(["payload", bytesToHex(new Uint8Array(await crypto.subtle.digest("SHA-256", buffer)))]);
  } else if (body instanceof Uint8Array) {
    tags.push(["payload", bytesToHex(new Uint8Array(await crypto.subtle.digest("SHA-256", body)))]);
  } else if (typeof body === "string" && body) {
    tags.push(["payload", await sha256Hex(body)]);
  }

  const event = {
    kind: 27235,
    created_at: Math.floor(Date.now() / 1000),
    tags,
    content: "",
  };

  const signed = await signer.signEvent(event);
  return `Nostr ${bytesToBase64(new TextEncoder().encode(JSON.stringify(signed)))}`;
}

export async function uploadNip96File(file, server, signer, options = {}) {
  const uploadUrl = server.uploadUrl;
  const formData = new FormData();
  formData.append("file", file, file.name || "upload");

  if (options.caption) formData.append("caption", options.caption);
  if (options.alt) formData.append("alt", options.alt);
  if (options.mediaType) formData.append("media_type", options.mediaType);
  if (options.noTransform) formData.append("no_transform", "true");
  if (options.expiration) formData.append("expiration", String(options.expiration));
  if (options.contentType || file.type) formData.append("content_type", options.contentType || file.type);
  formData.append("size", String(file.size));

  const headers = {
    Authorization: await createNip98AuthHeader({
      signer,
      requestUrl: uploadUrl,
      method: "POST",
    }),
  };

  const response = await fetch(uploadUrl, {
    method: "POST",
    headers,
    body: formData,
  });
  return parseUploadResponse(response, { uploadUrl, serverType: "nip96" });
}

async function parseUploadResponse(response, { uploadUrl, serverType }) {
  const text = await response.text();
  const data = safeParseJson(text);

  if (!response.ok) {
    const details = typeof data === "object" && data ? data.message || data.error : "";
    const snippet = text.trim().slice(0, 160);
    const suffix = details || snippet ? `: ${details || snippet}` : "";
    throw new Error(`Upload failed (${response.status})${suffix}`);
  }

  const urlFromJson = typeof data === "object" && data ? data.url || data.location || data?.nip94_event?.tags?.find?.((tag) => tag[0] === "url")?.[1] : "";
  const urlFromHeader = response.headers.get("location") || response.headers.get("Location") || "";
  const urlFromText = typeof text === "string" ? text.trim() : "";
  const resolvedUrl = urlFromJson || urlFromHeader || (looksLikeUrl(urlFromText) ? urlFromText : "");

  if (resolvedUrl) {
    return { url: resolvedUrl, raw: data ?? text, serverType };
  }

  throw new Error(`Upload succeeded but no file URL was returned from ${uploadUrl}.`);
}

export function normalizeUploadServer(server) {
  if (!server) return null;
  if (typeof server === "string") {
    return normalizeUploadServer({ baseUrl: server });
  }

  const baseUrl = normalizeBaseUrl(server.baseUrl || "");
  const uploadUrl = normalizeUploadUrl(server.uploadUrl || (baseUrl ? inferUploadUrl(baseUrl) : ""));
  if (!uploadUrl && !baseUrl) return null;
  const resolvedBaseUrl = baseUrl || deriveBaseUrl(uploadUrl);

  return {
    name: server.name || server.label || inferServerName(baseUrl || uploadUrl),
    type: server.type || inferServerType(uploadUrl),
    baseUrl: resolvedBaseUrl,
    uploadUrl: uploadUrl || inferUploadUrl(resolvedBaseUrl),
  };
}

function safeParseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function normalizeBaseUrl(value) {
  const url = String(value || "").trim();
  if (!url) return "";
  return stripTrailingSlash(url);
}

function normalizeUploadUrl(value) {
  const url = String(value || "").trim();
  if (!url) return "";
  return stripTrailingSlash(url);
}

function inferUploadUrl(baseUrl) {
  const normalized = stripTrailingSlash(baseUrl);
  if (!normalized) return "";
  return `${normalized}/upload`;
}

function inferServerName(url) {
  try {
    return new URL(url).host || "Upload server";
  } catch {
    return "Upload server";
  }
}

function inferServerType(uploadUrl) {
  return /\/api\/|nip96/i.test(uploadUrl || "") ? "nip96" : "blossom";
}

function stripTrailingSlash(value) {
  return String(value || "").replace(/\/+$/, "");
}

function deriveBaseUrl(uploadUrl) {
  const normalized = stripTrailingSlash(uploadUrl);
  if (!normalized) return "";
  return normalized.replace(/\/upload$/, "");
}

function looksLikeUrl(value) {
  if (!value) return false;
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}
