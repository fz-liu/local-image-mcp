// mcp-client-test.mjs — real stdio client for qwen-image-mcp/server.mjs
//
// Speaks the same framing the server accepts (newline-delimited JSON, plus one
// Content-Length framed round trip to prove the auto-detection works), then
// asserts the handshake, the tool list and an invalid-argument call.
//
// Usage: node scripts\mcp-client-test.mjs
// Exit 0 and "MCP CLIENT TEST PASS" on success.

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const SERVER_PATH = path.join(SCRIPT_DIR, "..", "server.mjs");
const EXPECTED_TOOLS = ["free_vram", "generate", "get_result", "status"];
const REQUIRED_KEYS = { generate: ["prompt"], get_result: ["prompt_id"], status: [], free_vram: [] };

const failures = [];
let checks = 0;

function check(label, condition, detail) {
  checks += 1;
  if (condition) {
    console.log(`  ok   ${label}`);
  } else {
    console.log(`  FAIL ${label}${detail ? ` :: ${detail}` : ""}`);
    failures.push(label);
  }
}

const child = spawn(process.execPath, [SERVER_PATH], { stdio: ["pipe", "pipe", "pipe"] });
let stderrText = "";
child.stderr.on("data", (chunk) => {
  stderrText += chunk.toString("utf8");
});

const pending = new Map();
let nextId = 1;
let framingMode = "line";
let buffer = Buffer.alloc(0);

child.stdout.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    if (buffer.length === 0) return;
    const asText = buffer.toString("utf8");
    if (framingMode === "headers" || asText.startsWith("Content-Length:")) {
      framingMode = "headers";
      const headerEnd = asText.indexOf("\r\n\r\n");
      if (headerEnd === -1) return;
      const match = /Content-Length:\s*(\d+)/i.exec(asText.slice(0, headerEnd));
      if (!match) throw new Error("invalid Content-Length framing from server");
      const length = Number(match[1]);
      const bodyStart = headerEnd + 4;
      if (buffer.length < bodyStart + length) return;
      const body = buffer.subarray(bodyStart, bodyStart + length).toString("utf8");
      buffer = buffer.subarray(bodyStart + length);
      deliver(JSON.parse(body));
      continue;
    }
    const newline = asText.indexOf("\n");
    if (newline === -1) return;
    const line = asText.slice(0, newline).trim();
    buffer = buffer.subarray(Buffer.byteLength(asText.slice(0, newline + 1), "utf8"));
    if (line) deliver(JSON.parse(line));
  }
});

function deliver(message) {
  if (message && message.id !== undefined && message.id !== null && pending.has(message.id)) {
    const settle = pending.get(message.id);
    pending.delete(message.id);
    settle(message);
  }
}

function send(method, params, { framing = "line", expectReply = true, timeoutMs = 60000 } = {}) {
  const id = expectReply ? nextId++ : null;
  const message = { jsonrpc: "2.0", method };
  if (expectReply) message.id = id;
  if (params !== undefined) message.params = params;
  const payload = JSON.stringify(message);
  const promise = expectReply
    ? new Promise((resolve, reject) => {
        pending.set(id, resolve);
        setTimeout(() => {
          if (pending.has(id)) {
            pending.delete(id);
            reject(new Error(`timeout waiting for ${method}`));
          }
        }, timeoutMs);
      })
    : Promise.resolve(null);
  if (framing === "headers") {
    child.stdin.write(`Content-Length: ${Buffer.byteLength(payload, "utf8")}\r\n\r\n${payload}`);
  } else {
    child.stdin.write(`${payload}\n`);
  }
  return promise;
}

function toolText(result) {
  return result && result.content && result.content[0] ? result.content[0].text : "";
}

let exitCode = 1;
try {
  console.log(`client: spawning ${process.execPath} ${SERVER_PATH}`);

  // 1) initialize
  const init = await send("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "mcp-client-test", version: "1.0.0" } });
  check("initialize returns a result", Boolean(init && init.result), JSON.stringify(init).slice(0, 200));
  check("initialize echoes protocolVersion", Boolean(init.result && init.result.protocolVersion === "2025-06-18"), JSON.stringify(init.result && init.result.protocolVersion));
  check("serverInfo.name is qwen-image-mcp", Boolean(init.result && init.result.serverInfo && init.result.serverInfo.name === "qwen-image-mcp"), JSON.stringify(init.result && init.result.serverInfo));
  check("serverInfo.version present", Boolean(init.result && init.result.serverInfo && /^\d+\.\d+\.\d+$/.test(init.result.serverInfo.version)), JSON.stringify(init.result && init.result.serverInfo));

  // 2) initialized notification (no reply expected)
  await send("notifications/initialized", {}, { expectReply: false });
  check("notifications/initialized accepted without reply", true);

  // 3) tools/list
  const list = await send("tools/list", {});
  const tools = list && list.result && list.result.tools ? list.result.tools : [];
  check("tools/list returns exactly 4 tools", tools.length === 4, String(tools.length));
  const names = tools.map((tool) => tool.name).sort();
  check("tool names match", JSON.stringify(names) === JSON.stringify(EXPECTED_TOOLS), JSON.stringify(names));
  for (const tool of tools) {
    const required = tool.inputSchema && tool.inputSchema.required ? tool.inputSchema.required : [];
    check(`${tool.name}: schema carries required`, JSON.stringify(required) === JSON.stringify(REQUIRED_KEYS[tool.name] || []), JSON.stringify(required));
    check(`${tool.name}: additionalProperties=false`, Boolean(tool.inputSchema && tool.inputSchema.additionalProperties === false));
    check(`${tool.name}: bilingual description`, Boolean(tool.description && /[\u4e00-\u9fa5]/.test(tool.description) && /[A-Za-z]{4}/.test(tool.description)));
  }

  // 4) tools/call status — read-only, never starts ComfyUI
  const status = await send("tools/call", { name: "status", arguments: {} }, { timeoutMs: 120000 });
  const statusText = toolText(status && status.result);
  check("status returns text content", statusText.length > 0, JSON.stringify(status).slice(0, 200));
  check("status reports the server version", statusText.includes("server=qwen-image-mcp"), statusText.split("\n")[0]);
  check("status reports ComfyUI state", /comfyui=/.test(statusText), statusText.slice(0, 300));
  check("status is not an error", Boolean(status && status.result && status.result.isError !== true), statusText.slice(0, 200));
  console.log("  info status output:");
  for (const line of statusText.split("\n")) console.log(`       ${line}`);

  // 5) invalid generate arguments must come back as an isError result, not a crash
  const invalid = await send("tools/call", { name: "generate", arguments: { prompt: "cat", width: 100 } });
  const invalidText = toolText(invalid && invalid.result);
  check("invalid generate returns isError", Boolean(invalid && invalid.result && invalid.result.isError === true), JSON.stringify(invalid).slice(0, 200));
  check("invalid generate carries BAD_PARAMS", invalidText.startsWith("BAD_PARAMS:"), invalidText.slice(0, 200));
  check("invalid generate carries 建议", invalidText.includes("建议:"), invalidText.slice(0, 200));

  const invalid2 = await send("tools/call", { name: "generate", arguments: { prompt: "cat", steps: 999 } });
  check("out-of-range steps returns BAD_PARAMS", toolText(invalid2 && invalid2.result).startsWith("BAD_PARAMS:"), toolText(invalid2 && invalid2.result).slice(0, 160));

  // 6) ping + unknown method
  const pong = await send("ping", {});
  check("ping returns an empty result", Boolean(pong && pong.result && Object.keys(pong.result).length === 0), JSON.stringify(pong));
  const unknown = await send("tools/nope", {});
  check("unknown method returns -32601", Boolean(unknown && unknown.error && unknown.error.code === -32601), JSON.stringify(unknown));

  // 7) Content-Length framing round trip (auto-detection must switch modes)
  check("framing so far is line-delimited", framingMode === "line", framingMode);
  const framedPing = await send("ping", {}, { framing: "headers" });
  check("Content-Length framed ping is answered", Boolean(framedPing && framedPing.result), JSON.stringify(framedPing));
  try {
    const framedList = await send("tools/list", {}, { framing: "headers" });
    check("Content-Length framed tools/list is answered", Boolean(framedList && framedList.result && framedList.result.tools.length === 4));
  } catch (error) {
    check("Content-Length framed tools/list is answered", false, error.message);
  }

  // 8) stdin close -> clean exit
  child.stdin.end();
  const exitInfo = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ code: null, timedOut: true }), 15000);
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, timedOut: false });
    });
  });
  check("server exits cleanly when stdin closes", exitInfo.timedOut === false && exitInfo.code === 0, JSON.stringify(exitInfo));
  check("server printed nothing but protocol on stdout", true);

  exitCode = failures.length === 0 ? 0 : 1;
} catch (error) {
  console.log(`  FAIL unexpected exception :: ${error && error.stack ? error.stack : String(error)}`);
  failures.push("unexpected exception");
  exitCode = 1;
} finally {
  try {
    if (!child.killed) child.kill();
  } catch {
    /* ignore */
  }
}

console.log(`client: ${checks} checks, ${failures.length} failure(s)`);
if (stderrText.trim()) {
  console.log("client: server stderr:");
  for (const line of stderrText.trim().split("\n")) console.log(`       ${line}`);
}
console.log(exitCode === 0 ? "MCP CLIENT TEST PASS" : "MCP CLIENT TEST FAIL");
process.exit(exitCode);
