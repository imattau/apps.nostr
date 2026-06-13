import { createUploadAuth } from "blossom-client-sdk";
import { uploadBlob } from "blossom-client-sdk/actions/upload";

export async function uploadBlossomFile(file, server, signer, options = {}) {
  const baseServer = server.baseUrl || server.uploadUrl || server;
  const descriptor = await uploadBlob(baseServer, file, {
    signal: options.signal,
    timeout: options.timeout,
    authEvents: options.authEvents,
    onAuth: async (_server, _sha256, authType, blob) => {
      if (!signer?.signEvent) {
        throw new Error("Missing signer.");
      }
      return createUploadAuth(
        async (draft) => signer.signEvent(draft),
        blob,
        {
          type: authType,
          servers: baseServer,
        },
      );
    },
  });

  return { url: descriptor.url, raw: descriptor, serverType: "blossom" };
}
