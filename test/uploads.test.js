import test from "node:test";
import assert from "node:assert/strict";

import { buildUploadServerTargets, createNip98AuthHeader, normalizeUploadServer, prepareImageFileForUpload, uploadFileToServer } from "../src/uploads.js";

test("createNip98AuthHeader encodes a signed auth event", async () => {
  const signer = {
    async signEvent(event) {
      return { ...event, id: "event-id", pubkey: "pubkey", sig: "sig" };
    },
  };

  const header = await createNip98AuthHeader({
    signer,
    requestUrl: "https://example.com/upload",
    method: "POST",
    body: "payload",
  });

  assert.match(header, /^Nostr\s+/);
  const encoded = header.replace(/^Nostr\s+/, "");
  const decoded = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
  assert.equal(decoded.kind, 27235);
  assert.deepEqual(decoded.tags[0], ["u", "https://example.com/upload"]);
  assert.deepEqual(decoded.tags[1], ["method", "POST"]);
});

test("buildUploadServerTargets prefers the selected fallback server", () => {
  const targets = buildUploadServerTargets({
    fallbackServers: [
      { name: "one", type: "blossom", baseUrl: "https://one.example", uploadUrl: "https://one.example/upload" },
      { name: "two", type: "nip96", baseUrl: "https://two.example", uploadUrl: "https://two.example/upload" },
    ],
    preferredUploadUrl: "https://two.example/upload",
  });

  assert.equal(targets[0].uploadUrl, "https://two.example/upload");
  assert.equal(targets[1].uploadUrl, "https://one.example/upload");
});

test("normalizeUploadServer derives a Blossom upload endpoint from a base url", () => {
  const server = normalizeUploadServer("https://blossom.example");

  assert.equal(server.baseUrl, "https://blossom.example");
  assert.equal(server.uploadUrl, "https://blossom.example/upload");
  assert.equal(server.type, "blossom");
});

test("uploadFileToServer uses PUT for Blossom uploads", async () => {
  const originalFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, options) => {
    calls.push({ url, options });
    if (options.method === "HEAD") {
      return new Response("", { status: 401 });
    }
    return new Response(JSON.stringify({ url: "https://cdn.example/file.png", sha256: "hash", size: 12, uploaded: 12 }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  try {
    const signer = {
      async signEvent(event) {
        return { ...event, id: "event-id", pubkey: "pubkey", sig: "sig" };
      },
    };
    const file = new File(["image"], "icon.png", { type: "image/png" });

    const result = await uploadFileToServer(file, { type: "blossom", uploadUrl: "https://blossom.example/upload" }, signer);

    assert.equal(calls[0].options.method, "HEAD");
    assert.equal(calls[1].options.method, "PUT");
    assert.equal(calls[1].options.body, file);
    assert.equal(result.url, "https://cdn.example/file.png");
  } finally {
    global.fetch = originalFetch;
  }
});

test("uploadFileToServer uses POST multipart form-data for NIP-96 uploads", async () => {
  const originalFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, options) => {
    calls.push({ url, options });
    return new Response(JSON.stringify({ url: "https://cdn.example/file.png" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  try {
    const signer = {
      async signEvent(event) {
        return { ...event, id: "event-id", pubkey: "pubkey", sig: "sig" };
      },
    };
    const file = new File(["image"], "icon.png", { type: "image/png" });

    const result = await uploadFileToServer(file, { type: "nip96", uploadUrl: "https://nostr.build/api/v2/upload" }, signer);

    assert.equal(calls[0].options.method, "POST");
    assert.equal(calls[0].options.body instanceof FormData, true);
    assert.equal(result.url, "https://cdn.example/file.png");
  } finally {
    global.fetch = originalFetch;
  }
});

test("prepareImageFileForUpload converts image files to webp and resizes them", async () => {
  const originalCreateImageBitmap = global.createImageBitmap;
  const originalOffscreenCanvas = global.OffscreenCanvas;

  global.createImageBitmap = async () => ({
    width: 2400,
    height: 1200,
    close() {},
  });
  global.OffscreenCanvas = class {
    constructor(width, height) {
      this.width = width;
      this.height = height;
    }

    getContext() {
      return {
        drawImage() {},
      };
    }

    async convertToBlob({ type }) {
      return new Blob(["webp"], { type });
    }
  };

  try {
    const file = new File(["image"], "icon.png", { type: "image/png" });
    const output = await prepareImageFileForUpload(file, { maxSize: 1600, quality: 0.8 });

    assert.equal(output.type, "image/webp");
    assert.equal(output.name, "icon.webp");
  } finally {
    global.createImageBitmap = originalCreateImageBitmap;
    global.OffscreenCanvas = originalOffscreenCanvas;
  }
});
