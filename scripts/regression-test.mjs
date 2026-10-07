// Focused regression coverage. Mock servers never call the real ComfyUI.
import assert from "node:assert/strict";
import { test, after } from "node:test";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import { timeoutFetch, resolveImage, parseJobHistory, validateConfig, loadConfig, ensureComfy, ingest } from "../server.mjs";

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const config = JSON.parse(fs.readFileSync(path.join(project, "config.json"), "utf8"));
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "qwenimg-regression-"));
const output = path.join(scratch, "output");
fs.mkdirSync(output);
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jD1sAAAAASUVORK5CYII=", "base64");
fs.writeFileSync(path.join(output, "test.png"), png);
let scenario = "empty", historyReads = 0, freeRequests = 0;
const stats = { system: { comfyui_version: "mock" }, devices: [{ name: "mock", vram_total: 8 * 1024 ** 3, vram_free: 7 * 1024 ** 3 }] };
const mock = http.createServer((req, res) => {
  const route = req.url.split("?")[0];
  const json = (data, code = 200) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(data)); };
  if (route === "/stalled") { res.writeHead(200); res.flushHeaders(); return; }
  if (route === "/large") { res.end("12345678"); return; }
  if (route === "/redirect") { res.writeHead(302, { location: "/large" }); res.end(); return; }
  if (route === "/system_stats") { json(stats); return; }
  if (route === "/prompt") { req.resume(); json({ prompt_id: "test-job" }); return; }
  if (route.startsWith("/history/")) {
    historyReads++;
    if (scenario === "http-error") { json({ error: "unavailable" }, 503); return; }
    if (["pending", "empty", "busy", "empty-node"].includes(scenario)) { json({}); return; }
    const filename = scenario === "traversal" ? "../secret.png" : scenario === "http-fallback" ? "download.png" : scenario === "leak" ? "missing.png" : "test.png";
    const entry = { status: { status_str: "success", completed: true, messages: [] }, outputs: { "8": { images: [{ filename, type: "output", subfolder: "" }] } } };
    if (scenario === "failed-output" || scenario === "leak") entry.status = { status_str: "error", completed: false, messages: [["execution_error", { node_type: "KSampler", exception_message: scenario === "leak" ? "SECRET_PROMPT_SHOULD_NOT_BE_LOGGED" : "CUDA out of memory" }]] };
    json({ "test-job": entry }); return;
  }
  if (route === "/queue") { json({ queue_running: scenario === "busy" ? [[0, "test-job"]] : [], queue_pending: scenario === "pending" ? [[0, "test-job"]] : [] }); return; }
  if (route.startsWith("/object_info/")) {
    const name = route.split("/").at(-1);
    if (scenario === "empty-node") { json({}); return; }
    const keys = { UnetLoaderGGUF: ["unet_name", config.models.unet], CLIPLoader: ["clip_name", config.models.clip], VAELoader: ["vae_name", config.models.vae] };
    const pair = keys[name];
    json({ [name]: { input: { required: pair ? { [pair[0]]: [[pair[1]]] } : {} } } }); return;
  }
  if (route === "/free") { freeRequests++; req.resume(); json({}); return; }
  if (route === "/view") {
    if (scenario === "leak") { json({ error: "SECRET_PROMPT_SHOULD_NOT_BE_LOGGED" }, 500); return; }
    res.writeHead(200, { "content-type": "image/png" }); res.end(png); return;
  }
  json({}, 404);
});
await new Promise((resolve) => mock.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${mock.address().port}`;
config.comfy_url = base;
const child = spawn(process.execPath, [path.join(project, "server.mjs")], {
  windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
  env: { ...process.env, QWENIMG_COMFY_URL: base, QWENIMG_COMFY_OUTPUT_DIR: output, QWENIMG_AUTOSTART: "false" }
});
const childExit = once(child, "exit");
let stderr = "", received = "", nextId = 1;
const pending = new Map();
const unsolicited = [];
child.stderr.on("data", (chunk) => { stderr = (stderr + chunk.toString()).slice(-16000); });
child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  received += chunk;
  for (;;) {
    const end = received.indexOf("\n");
    if (end < 0) break;
    const msg = JSON.parse(received.slice(0, end)); received = received.slice(end + 1);
    const entry = pending.get(msg.id);
    if (entry) { clearTimeout(entry.timer); pending.delete(msg.id); entry.resolve(msg); }
    else unsolicited.push(msg);
  }
});
function request(method, params, prefix = "") {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`MCP timeout: ${method}; ${stderr}`)); }, 10000);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(prefix + JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}
const tool = async (name, args = {}) => (await request("tools/call", { name, arguments: args })).result;
const text = (result) => result.content[0].text;

after(async () => {
  for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error("test teardown")); }
  child.stdin.end();
  const killer = setTimeout(() => child.kill(), 2000);
  await childExit; clearTimeout(killer);
  mock.closeAllConnections();
  await new Promise((resolve) => mock.close(resolve));
  // Only delete the exact fresh temporary workspace created above.
  assert.equal(path.dirname(scratch), path.resolve(os.tmpdir()));
  assert.ok(path.basename(scratch).startsWith("qwenimg-regression-"));
  fs.rmSync(scratch, { recursive: true, force: true });
});

test("unsupported protocol negotiates an implemented version", async () => {
  const result = await request("initialize", { protocolVersion: "2099-01-01" });
  assert.equal(result.result.protocolVersion, "2025-06-18");
});
test("unknown jobs do not stay queued forever", async () => {
  scenario = "empty"; historyReads = 0;
  const result = await tool("get_result", { prompt_id: "test-job" });
  assert.match(text(result), /status=unknown/); assert.equal(historyReads, 1);
});
test("HTTP history errors are errors, not pending jobs", async () => {
  scenario = "http-error";
  const result = await tool("get_result", { prompt_id: "test-job" });
  assert.equal(result.isError, true); assert.match(text(result), /HTTP 503/);
});
test("failed execution takes priority over partial image outputs", async () => {
  scenario = "failed-output";
  const result = await tool("get_result", { prompt_id: "test-job" });
  assert.equal(result.isError, true); assert.match(text(result), /status=failed/);
});
test("successful retrieval uses one history query and can return image content", async () => {
  scenario = "done"; historyReads = 0;
  const result = await tool("get_result", { prompt_id: "test-job", return_image: true });
  assert.match(text(result), /status=ok/); assert.equal(result.content[1].type, "image"); assert.equal(historyReads, 1);
});
test("image traversal is rejected before any file is read", async () => {
  fs.writeFileSync(path.join(scratch, "secret.png"), png); scenario = "traversal";
  const result = await tool("get_result", { prompt_id: "test-job", return_image: true });
  assert.equal(result.isError, true); assert.equal(result.content.length, 1);
});
test("HTTP image fallback creates a real PNG", async () => {
  scenario = "http-fallback";
  const result = await tool("get_result", { prompt_id: "test-job" });
  assert.match(text(result), /status=ok/); assert.deepEqual(fs.readFileSync(path.join(output, "download.png")), png);
});
test("an unwritable output path cannot be reported as success", async () => {
  const fileRoot = path.join(scratch, "not-a-directory"); fs.writeFileSync(fileRoot, "occupied");
  await assert.rejects(resolveImage({ ...config, comfy_output_dir: fileRoot }, { filename: "x.png", subfolder: "", type: "output" }));
});
test("existing files are not overwritten when empty", async () => {
  fs.writeFileSync(path.join(output, "empty.png"), "");
  await assert.rejects(resolveImage({ ...config, comfy_output_dir: output }, { filename: "empty.png", subfolder: "", type: "output" }));
  assert.equal(fs.statSync(path.join(output, "empty.png")).size, 0);
});
test("output directory junctions cannot escape the output root", async () => {
  const other = path.join(scratch, "other"); fs.mkdirSync(other);
  fs.symlinkSync(other, path.join(output, "linked"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(resolveImage({ ...config, comfy_output_dir: output }, { filename: "x.png", subfolder: "linked", type: "output" }), /链接越过/);
});
test("free_vram refuses a busy queue", async () => {
  scenario = "busy"; freeRequests = 0;
  const result = await tool("free_vram");
  assert.equal(result.isError, true); assert.match(text(result), /^BUSY:/); assert.equal(freeRequests, 0);
});
test("status detects missing nodes even when HTTP status is 200", async () => {
  scenario = "empty-node";
  const result = await tool("status"); assert.equal(result.diagnosisFailed, true); assert.match(text(result), /TextEncodeQwenImage21:缺失/);
});
test("a short generate wait returns the queued job without duplicate submission", async () => {
  scenario = "pending";
  const started = Date.now();
  const result = await tool("generate", { prompt: "mock cat", wait_seconds: 1 });
  assert.match(text(result), /status=queued/); assert.match(text(result), /prompt_id=test-job/); assert.ok(Date.now() - started < 2500);
});
test("post-submission failures retain prompt_id for retry", async () => {
  scenario = "http-error";
  const result = await tool("generate", { prompt: "mock cat" });
  assert.equal(result.isError, true); assert.match(text(result), /任务已提交 prompt_id=test-job/);
});
test("ComfyUI exception details never copy prompt text into persistent logs", async () => {
  scenario = "leak";
  const result = await tool("generate", { prompt: "mock cat" });
  assert.equal(result.isError, true); assert.match(text(result), /SECRET_PROMPT_SHOULD_NOT_BE_LOGGED/);
  const logfile = path.join(project, "logs", `qwenimg-${new Date().toISOString().slice(0,10)}.log`);
  assert.ok(!fs.readFileSync(logfile, "utf8").includes("SECRET_PROMPT_SHOULD_NOT_BE_LOGGED"));
});
test("get_result enforces its schema", async () => {
  assert.equal((await tool("get_result", { prompt_id: "test-job", return_image: "yes" })).isError, true);
  assert.equal((await tool("status", { unexpected: 1 })).isError, true);
});
test("parse errors do not stall valid messages in the same input chunk", async () => {
  const ping = await request("ping", {}, '{broken}\n'); assert.deepEqual(ping.result, {});
  assert.ok(unsolicited.some((msg) => msg.error?.code === -32700));
});
test("notifications never cause an undefined-id response", async () => {
  const count = unsolicited.length;
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/unknown" }) + "\n");
  await request("ping", {}); assert.equal(unsolicited.length, count);
});
test("an invalid Content-Length header does not poison the next frame", async () => {
  const replies = [];
  ingest(Buffer.from('Content-Length: invalid\r\n\r\n'), (reply) => replies.push(reply));
  ingest(Buffer.from('{"jsonrpc":"2.0","id":"after-bad-header","method":"ping"}\n'), (reply) => replies.push(reply));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(replies[0].error.code, -32700);
  assert.equal(replies[1].id, "after-bad-header"); assert.deepEqual(replies[1].result, {});
});
test("body timeout stays active after headers arrive", async () => {
  const started = Date.now();
  await assert.rejects(timeoutFetch(base + "/stalled", {}, 150)); assert.ok(Date.now() - started < 2000);
});
test("response size is bounded and redirects are rejected", async () => {
  await assert.rejects(timeoutFetch(base + "/large", {}, 1000, 4), /exceeds/);
  await assert.rejects(timeoutFetch(base + "/redirect", {}, 1000));
});
test("interrupted and completed-without-image jobs terminate", () => {
  assert.equal(parseJobHistory({ status: { completed: true, messages: [["execution_interrupted", {}]] } }).state, "failed");
  assert.equal(parseJobHistory({ status: { status_str: "success", completed: true }, outputs: {} }).state, "failed");
});
test("config rejects invalid defaults and non-HTTP local URLs", () => {
  for (const comfy_url of ["https://127.0.0.1:8188", "http://user:password@localhost:8188", "http://localhost:8188/other"]) {
    assert.throws(() => validateConfig({ ...structuredClone(config), comfy_url }));
  }
  assert.throws(() => validateConfig({ ...structuredClone(config), defaults: { ...config.defaults, width: 517 } }));
  const override = loadConfig({ QWENIMG_COMFY_PRE_ARGS: '["-s","-u"]' }, config);
  assert.deepEqual(override.comfy_pre_args, ["-s", "-u"]);
});
test("simultaneous cold starts share one launch", async () => {
  const reserve = http.createServer(); await new Promise((resolve) => reserve.listen(0, "127.0.0.1", resolve));
  const port = reserve.address().port; await new Promise((resolve) => reserve.close(resolve));
  const fixture = http.createServer((req, res) => { res.end(JSON.stringify(stats)); });
  let starts = 0;
  const opts = { autostart: true, timeoutS: 2, baseOverride: `http://127.0.0.1:${port}`, pollMs: 20,
    start() { starts++; fixture.listen(port, "127.0.0.1"); return { pid: 0, earlyExit: () => null }; } };
  try {
    const results = await Promise.all([ensureComfy(config, opts), ensureComfy(config, opts)]);
    assert.equal(starts, 1); assert.ok(results.every((result) => result.stats.system.comfyui_version === "mock"));
  } finally { fixture.closeAllConnections(); await new Promise((resolve) => fixture.close(resolve)); }
});

const installer = path.join(project, "scripts/install-patch.ps1");
const localSnippet = path.join(project, "cordis.patch.snippet.yml");
const readSnippet = () => fs.readFileSync(fs.existsSync(localSnippet) ? localSnippet : path.join(project, "cordis.patch.example.yml"), "utf8")
  .replaceAll('__QWENIMG_SERVER_PATH__', path.join(project, "server.mjs").replaceAll("'", "''"));
function install(file, extra = []) {
  return spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", installer, "-ProfilePatchFile", file, ...extra], { encoding: "utf8", windowsHide: true, timeout: 15000 });
}
for (const [label, bytes] of [
  ["mixed-newlines", Buffer.from("# 中文\r\n- insert:\n    - id: existing\r\n\n")],
  ["UTF8-BOM", Buffer.concat([Buffer.from([239,187,191]), Buffer.from("# 中文\r\n")])],
  ["no-final-newline", Buffer.from("# keep this exact")],
  ["empty-file", Buffer.alloc(0)]
]) {
  test(`patch round trip is byte-exact: ${label}`, () => {
    const file = path.join(scratch, `${label}.yml`); fs.writeFileSync(file, bytes);
    assert.equal(install(file).status, 0); assert.deepEqual(fs.readFileSync(file), bytes);
    let run = install(file, ["-Apply", "-Force"]); assert.equal(run.status, 0, run.stdout + run.stderr);
    const applied = fs.readFileSync(file);
    run = install(file, ["-Apply", "-Force"]); assert.equal(run.status, 0, run.stdout + run.stderr); assert.deepEqual(fs.readFileSync(file), applied);
    run = install(file, ["-Remove", "-Apply", "-Force"]); assert.equal(run.status, 0, run.stdout + run.stderr); assert.deepEqual(fs.readFileSync(file), bytes);
  });
}
test("replacement keeps an existing block in place and preserves both surrounding byte regions", () => {
  const file = path.join(scratch, "middle.yml");
  const before = "# before\r\n", after = "# after\n# no final newline";
  const old = readSnippet().replace("900000", "300000");
  fs.writeFileSync(file, before + old + after);
  const result = install(file, ["-Apply", "-Force"]); assert.equal(result.status, 0, result.stdout + result.stderr);
  const updated = fs.readFileSync(file, "utf8"); assert.ok(updated.startsWith(before)); assert.ok(updated.endsWith(after)); assert.match(updated, /900000/);
  assert.equal(install(file, ["-Remove", "-Apply", "-Force"]).status, 0); assert.equal(fs.readFileSync(file, "utf8"), before + after);
});
test("duplicate, incomplete markers and hand-written ID conflicts are rejected without writes", () => {
  const snippet = readSnippet();
  for (const content of [snippet + snippet, "# >>> qwen-image-mcp\n", "# <<< qwen-image-mcp <<<\n", "- insert:\n  - id: mcp-qwen-image # handwritten\n"]) {
    const file = path.join(scratch, "invalid.yml"); fs.writeFileSync(file, content);
    assert.equal(install(file, ["-Apply", "-Force"]).status, 1); assert.equal(fs.readFileSync(file, "utf8"), content);
  }
});
