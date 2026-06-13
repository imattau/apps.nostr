import { DEFAULT_MEDIA_SERVERS } from "./config.js";
import { prepareImageFileForUpload } from "./image-preprocess.js";
import { uploadBlossomFile } from "./blossom-upload.js";
import { normalizeUploadServer, uploadNip96File } from "./nip96-upload.js";

export { prepareImageFileForUpload } from "./image-preprocess.js";
export { createNip98AuthHeader } from "./nip96-upload.js";
export { normalizeUploadServer } from "./nip96-upload.js";

export function buildUploadServerTargets({ userServers = [], fallbackServers = DEFAULT_MEDIA_SERVERS, preferredUploadUrl = "" } = {}) {
  const list = userServers.length ? userServers : fallbackServers;
  const normalized = dedupeBy(list.map(normalizeUploadServer).filter(Boolean), (server) => server.uploadUrl);
  const preferredIndex = normalized.findIndex((server) => server.uploadUrl === preferredUploadUrl || server.baseUrl === preferredUploadUrl);
  if (preferredIndex <= 0) return normalized;
  return [normalized[preferredIndex], ...normalized.slice(0, preferredIndex), ...normalized.slice(preferredIndex + 1)];
}

export async function uploadFileToServer(file, server, signer, options = {}) {
  const normalized = normalizeUploadServer(server);
  if (!normalized) {
    throw new Error("No upload server configured.");
  }
  if (normalized.type === "nip96") {
    return uploadNip96File(file, normalized, signer, options);
  }
  return uploadBlossomFile(file, normalized, signer, options);
}

export async function uploadFileToServers(file, servers, signer, options = {}) {
  const targets = dedupeBy(servers.map(normalizeUploadServer).filter(Boolean), (server) => server.uploadUrl);
  if (!targets.length) {
    throw new Error("No upload servers configured.");
  }

  const authEvents = options.authEvents ?? new Set();
  const results = await Promise.allSettled(
    targets.map((server) => uploadFileToServer(file, server, signer, { ...options, authEvents })),
  );
  const successes = results
    .map((result, index) => ({ result, server: targets[index] }))
    .filter(({ result }) => result.status === "fulfilled");

  if (!successes.length) {
    const reason = results.find((result) => result.status === "rejected")?.reason;
    throw reason instanceof Error ? reason : new Error("Upload failed on all servers.");
  }

  const uploads = successes.map(({ result, server }) => ({ server, ...result.value }));
  const urls = [...new Set(uploads.map((upload) => upload.url).filter(Boolean))];
  return {
    url: urls[0],
    urls,
    uploads,
    failures: results
      .map((result, index) => (result.status === "rejected" ? { server: targets[index], error: result.reason } : null))
      .filter(Boolean),
  };
}

function dedupeBy(values, keyFn) {
  const seen = new Set();
  const output = [];
  for (const value of values) {
    const key = keyFn(value);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    output.push(value);
  }
  return output;
}
