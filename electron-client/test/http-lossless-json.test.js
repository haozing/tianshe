const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { nativeHttpRequest } = require("../src/main/ipc/http");
const { parseLosslessJson } = require("../src/main/utils/lossless-json");

test("lossless JSON keeps platform identifiers as strings", () => {
  const payload = parseLosslessJson('{"ticket_id":7655157084790898950,"product_id":3827575095157719000,"code":0}');

  assert.equal(payload.ticket_id, "7655157084790898950");
  assert.equal(payload.product_id, "3827575095157719000");
  assert.equal(payload.code, 0);
});

test("native HTTP losslessJson parses response text without rounding identifiers", async (t) => {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"ticket_id":7655157084790898950,"object_id":3827575095157719000,"total":56}');
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  assert.ok(address && typeof address === "object");

  const result = await nativeHttpRequest({
    url: `http://127.0.0.1:${address.port}/violations`,
    responseType: "losslessJson",
    persistSetCookie: false
  });

  assert.equal(result.ok, true);
  assert.equal(result.data.ticket_id, "7655157084790898950");
  assert.equal(result.data.object_id, "3827575095157719000");
  assert.equal(result.data.total, 56);
});

test("native HTTP preserves a non-JSON 429 body as the rate-limit error", async (t) => {
  const server = http.createServer((_request, response) => {
    response.writeHead(429, { "content-type": "text/plain" });
    response.end("rate limit exceeded");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  assert.ok(address && typeof address === "object");

  const result = await nativeHttpRequest({
    url: `http://127.0.0.1:${address.port}/submit`,
    responseType: "losslessJson",
    persistSetCookie: false
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 429);
  assert.equal(result.data, "rate limit exceeded");
  assert.match(result.error.message, /^HTTP 429.*rate limit exceeded$/);
  assert.doesNotMatch(result.error.message, /invalid lossless JSON/);
});
