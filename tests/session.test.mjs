import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { after, before, beforeEach, describe, it } from "node:test";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const API_KEY = "sk-notte-test-key";
const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const PROFILE_ID = "notte-profile-0123456789abcdef";
const VIEWER_URL = "https://console.notte.cc/static/viewer?jwt=test-viewer-token";
const LOGIN_URL = "https://example.com/login";

let upstream;
let app;
let appUrl;
let behavior;
let calls;

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return server.address().port;
}

async function availablePort() {
  const reservation = createServer();
  const port = await listen(reservation);
  await new Promise((resolve, reject) => reservation.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function request(method, body, key = API_KEY) {
  return fetch(`${appUrl}/api/session`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(key ? { "x-notte-api-key": key } : {}),
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

before(async () => {
  upstream = createServer(async (req, res) => {
    let rawBody = "";
    for await (const chunk of req) rawBody += chunk;
    calls.push({
      method: req.method,
      path: req.url,
      authorization: req.headers.authorization,
      body: rawBody ? JSON.parse(rawBody) : undefined,
    });

    let operation;
    if (req.method === "POST" && req.url === "/sessions/start") operation = "start";
    if (req.method === "POST" && req.url === `/sessions/${SESSION_ID}/page/execute`) operation = "navigate";
    if (req.method === "POST" && req.url === `/sessions/${SESSION_ID}/profile/save`) operation = "save";
    if (req.method === "DELETE" && req.url === `/sessions/${SESSION_ID}/stop`) operation = "stop";
    if (!operation) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ detail: "Unexpected upstream request" }));
      return;
    }

    const defaults = {
      start: { session_id: SESSION_ID, viewer_url: VIEWER_URL },
      navigate: { success: true },
      save: { profile_id: PROFILE_ID, persisted_domains: ["example.com"] },
      stop: { session_id: SESSION_ID, status: "closed" },
    };
    const result = behavior[operation] ?? {};
    res.writeHead(result.status ?? 200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(result.body ?? defaults[operation]));
  });
  const upstreamPort = await listen(upstream);
  const appPort = await availablePort();
  appUrl = `http://127.0.0.1:${appPort}`;
  app = spawn(process.execPath, ["node_modules/next/dist/bin/next", "dev", "--hostname", "127.0.0.1", "--port", String(appPort)], {
    cwd: ROOT,
    env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1", NOTTE_API_URL: `http://127.0.0.1:${upstreamPort}` },
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });

  await new Promise((resolve, reject) => {
    let output = "";
    const timeout = setTimeout(() => finish(new Error(`Next.js did not become ready within 30 seconds.\n${output}`)), 30_000);
    function finish(error) {
      clearTimeout(timeout);
      app.off("exit", exited);
      app.off("error", finish);
      app.stdout.off("data", read);
      app.stderr.off("data", read);
      app.stdout.resume();
      app.stderr.resume();
      if (error) reject(error);
      else resolve();
    }
    function exited(code, signal) {
      finish(new Error(`Next.js exited before startup (${code ?? signal}).\n${output}`));
    }
    function read(chunk) {
      output += chunk.toString();
      if (/Ready in/.test(output)) finish();
    }
    app.stdout.on("data", read);
    app.stderr.on("data", read);
    app.once("error", finish);
    app.once("exit", exited);
  });
});

beforeEach(() => {
  behavior = {};
  calls = [];
});

after(async () => {
  try {
    if (app && app.exitCode === null && app.signalCode === null) {
      const exited = once(app, "exit", { signal: AbortSignal.timeout(5_000) });
      if (process.platform === "win32") app.kill("SIGTERM");
      else process.kill(-app.pid, "SIGTERM");
      try {
        await exited;
      } catch (error) {
        if (app.exitCode === null && app.signalCode === null) {
          if (process.platform === "win32") app.kill("SIGKILL");
          else process.kill(-app.pid, "SIGKILL");
        }
        throw error;
      }
    }
  } finally {
    if (upstream) {
      upstream.closeAllConnections();
      await new Promise((resolve, reject) => upstream.close((error) => error ? reject(error) : resolve()));
    }
  }
});

describe("session API", () => {
  it("requires the visitor's key for every operation", async () => {
    for (const [method, body] of [
      ["POST", { url: LOGIN_URL }],
      ["PATCH", { sessionId: SESSION_ID }],
      ["DELETE", { sessionId: SESSION_ID }],
    ]) {
      const response = await request(method, body, "");
      assert.equal(response.status, 401);
      assert.equal(typeof (await response.json()).error, "string");
    }
    assert.deepEqual(calls, []);
  });

  it("rejects malformed payloads and unsafe login URLs before creating a browser", async () => {
    for (const body of ["{", null, [], {}, { url: 7 }, { url: "not a URL" }, { url: "javascript:alert(1)" }, { url: "https://user:password@example.com/" }]) {
      const response = await request("POST", body);
      assert.equal(response.status, 400, `Unexpected status for ${JSON.stringify(body)}`);
    }
    assert.deepEqual(calls, []);
  });

  it("rejects malformed session and profile identifiers before sending upstream requests", async () => {
    for (const method of ["PATCH", "DELETE"]) {
      for (const body of ["{", null, [], {}, { sessionId: "../other-session" }, { sessionId: "abc?another=value" }]) {
        const response = await request(method, body);
        assert.equal(response.status, 400, `Unexpected ${method} status for ${JSON.stringify(body)}`);
      }
    }
    const response = await request("PATCH", { sessionId: SESSION_ID, profileId: "../other-profile" });
    assert.equal(response.status, 400);
    assert.deepEqual(calls, []);
  });

  it("starts and navigates the browser using the supplied key without echoing it", async () => {
    const response = await request("POST", { url: LOGIN_URL });
    assert.equal(response.status, 200);
    const text = await response.text();
    const result = JSON.parse(text);
    assert.equal(result.sessionId, SESSION_ID);
    assert.equal(new URL(result.viewerUrl).origin, "https://console.notte.cc");
    assert.equal(text.includes(API_KEY), false);
    assert.deepEqual(calls.map(({ method, path }) => ({ method, path })), [
      { method: "POST", path: "/sessions/start" },
      { method: "POST", path: `/sessions/${SESSION_ID}/page/execute` },
    ]);
    assert.equal(calls.every((call) => call.authorization === `Bearer ${API_KEY}`), true);
    assert.equal(calls[1].body.type, "goto");
    assert.equal(calls[1].body.url, LOGIN_URL);
  });

  it("reports start failures without navigating or stopping a nonexistent browser", async () => {
    behavior.start = { status: 401, body: { detail: "Invalid key" } };
    const response = await request("POST", { url: LOGIN_URL });
    assert.equal(response.ok, false);
    assert.equal(typeof (await response.json()).error, "string");
    assert.equal(calls.length, 1);
  });

  it("closes a started browser when initial navigation fails", async () => {
    behavior.navigate = { body: { success: false, message: "Navigation failed" } };
    const response = await request("POST", { url: LOGIN_URL });
    assert.equal(response.ok, false);
    assert.equal(typeof (await response.json()).error, "string");
    assert.equal(calls.at(-1).method, "DELETE");
    assert.equal(calls.at(-1).path, `/sessions/${SESSION_ID}/stop`);
  });

  it("preserves a browser handle when navigation and cleanup both fail", async () => {
    behavior.navigate = { status: 502, body: { detail: "Navigation failed" } };
    behavior.stop = { status: 503, body: { detail: "Stop failed" } };
    const response = await request("POST", { url: LOGIN_URL });
    assert.equal(response.ok, false);
    const result = await response.json();
    assert.equal(typeof result.error, "string");
    assert.equal(result.sessionId, SESSION_ID);
    assert.equal(new URL(result.viewerUrl).origin, "https://console.notte.cc");
  });

  it("cleans up a started browser that did not return a viewer URL", async () => {
    behavior.start = { body: { session_id: SESSION_ID, viewer_url: null } };
    const response = await request("POST", { url: LOGIN_URL });
    assert.equal(response.ok, false);
    assert.equal(typeof (await response.json()).error, "string");
    assert.deepEqual(calls.map((call) => call.path), ["/sessions/start", `/sessions/${SESSION_ID}/stop`]);
  });

  it("retains only a usable stop handle when a malformed viewer URL cannot be cleaned up", async () => {
    behavior.start = { body: { session_id: SESSION_ID, viewer_url: "not a URL" } };
    behavior.stop = { status: 503, body: { detail: "Stop failed" } };
    const response = await request("POST", { url: LOGIN_URL });
    assert.equal(response.ok, false);
    const result = await response.json();
    assert.equal(typeof result.error, "string");
    assert.equal(result.sessionId, SESSION_ID);
    assert.equal(result.viewerUrl, null);
    assert.deepEqual(calls.map((call) => call.path), ["/sessions/start", `/sessions/${SESSION_ID}/stop`]);
  });

  it("returns a saved profile only after the explicit save succeeds", async () => {
    const response = await request("PATCH", { sessionId: SESSION_ID });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.profileId, PROFILE_ID);
    assert.equal(result.sessionStopped, true);
    assert.deepEqual(calls.map(({ method, path }) => ({ method, path })), [
      { method: "POST", path: `/sessions/${SESSION_ID}/profile/save` },
      { method: "DELETE", path: `/sessions/${SESSION_ID}/stop` },
    ]);
    assert.equal(typeof calls[0].body.name, "string");
    assert.equal(calls[0].body.name.length > 0, true);
    assert.equal(calls.every((call) => call.authorization === `Bearer ${API_KEY}`), true);
  });

  it("keeps the browser running when profile saving fails", async () => {
    behavior.save = { status: 503, body: { detail: "Profile save failed" } };
    const response = await request("PATCH", { sessionId: SESSION_ID });
    assert.equal(response.ok, false);
    const result = await response.json();
    assert.equal(typeof result.error, "string");
    assert.equal(result.profileId, undefined);
    assert.deepEqual(calls.map((call) => call.path), [`/sessions/${SESSION_ID}/profile/save`]);
  });

  it("preserves a successfully saved profile when closing the browser fails", async () => {
    behavior.stop = { status: 503, body: { detail: "Stop failed" } };
    const response = await request("PATCH", { sessionId: SESSION_ID });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.profileId, PROFILE_ID);
    assert.equal(result.sessionStopped, false);
    assert.equal(typeof result.error, "string");
  });

  it("uses an existing profile as the save target when supplied", async () => {
    const response = await request("PATCH", { sessionId: SESSION_ID, profileId: PROFILE_ID });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).profileId, PROFILE_ID);
    assert.deepEqual(calls[0].body, { profile_id: PROFILE_ID });
  });

  it("confirms an explicit stop only when Notte accepts it", async () => {
    const response = await request("DELETE", { sessionId: SESSION_ID });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).ok, true);
    assert.equal(calls[0].path, `/sessions/${SESSION_ID}/stop`);
  });

  it("reports a failed explicit stop instead of pretending the browser closed", async () => {
    behavior.stop = { status: 503, body: { detail: "Stop failed" } };
    const response = await request("DELETE", { sessionId: SESSION_ID });
    assert.equal(response.ok, false);
    const result = await response.json();
    assert.equal(typeof result.error, "string");
    assert.notEqual(result.ok, true);
    assert.notEqual(result.sessionStopped, true);
  });

  it("surfaces an already closed browser while allowing the page to clear its session", async () => {
    behavior.stop = { status: 404, body: { detail: "Session is closed or expired" } };
    const response = await request("DELETE", { sessionId: SESSION_ID });
    assert.equal(response.status, 404);
    const result = await response.json();
    assert.equal(result.sessionStopped, true);
    assert.equal(typeof result.error, "string");
    assert.notEqual(result.ok, true);
  });
});
