import test from "node:test";
import assert from "node:assert/strict";

import { bytesToBase64, countLeadingZeroBits, formatBytes, markdownToHtml, slugify, websiteIconUrl } from "../src/utils.js";

test("slugify normalizes app names", () => {
  assert.equal(slugify("Hello, World!"), "hello-world");
  assert.equal(slugify("  Apps.Nostr  "), "apps-nostr");
});

test("countLeadingZeroBits handles hex prefixes", () => {
  assert.equal(countLeadingZeroBits("000f"), 12);
  assert.equal(countLeadingZeroBits("0f"), 4);
});

test("bytesToBase64 works in node", () => {
  const value = new Uint8Array([72, 105]);
  assert.equal(bytesToBase64(value), "SGk=");
});

test("websiteIconUrl derives a favicon url from a website", () => {
  assert.equal(websiteIconUrl("https://example.com/app"), "https://example.com/favicon.ico");
  assert.equal(websiteIconUrl(""), "");
});

test("formatBytes formats attachment sizes", () => {
  assert.equal(formatBytes(0), "0 B");
  assert.equal(formatBytes(1536), "1.5 KB");
});

test("markdownToHtml renders common markdown safely", () => {
  const html = markdownToHtml("# Hello\n\nSee [docs](https://example.com) and <script>alert(1)</script>.");
  assert.match(html, /<h1>Hello<\/h1>/);
  assert.match(html, /<a href="https:\/\/example\.com">docs<\/a>/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
});

test("markdownToHtml strips dangerous link protocols", () => {
  const html = markdownToHtml("[bad](javascript:alert(1))");
  assert.match(html, /<a href="">bad<\/a>/);
});
