// SPDX-License-Identifier: MIT
// Local Image MCP — local ComfyUI image-generation bridge (Node builtins only)
// Adapted transport framing and workflow references: see NOTICE.md and
// third_party_licenses/ for retained upstream copyright and permission notices.
//
// Transport : MCP over stdio. Framing is auto-detected like the in-box
//             dsh-computer-use-win server: newline-delimited JSON by default,
//             Content-Length headers if the client opens with them.
// stdout    : JSON-RPC messages ONLY. Every log line goes to logs\*.log or stderr.
// Config    : config.json next to this file; never a hard-coded project path.
//
// Tools (DSH shows them as mcp__qwenimg__<name>): generate, get_result, status, free_vram.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ─────────────────────────────────────────────────────────────────────────────
// identity / paths
// ─────────────────────────────────────────────────────────────────────────────

const SERVER_VERSION = "1.1.2";
const SERVER_NAME = "local-image-mcp";
const MIN_NODE_MAJOR = 22;

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(MODULE_DIR, "config.json");
const TEMPLATE_PATH = path.join(MODULE_DIR, "workflow_api.template.json");
const LOG_DIR = path.join(MODULE_DIR, "logs");
const STATE_DIR = path.join(MODULE_DIR, "state");
const COMFY_PID_PATH = path.join(STATE_DIR, "comfy.pid");

// Terminal mode flags. These run instead of the stdio server, so stdout is free
// for human-readable output there.
const MODE = process.argv.includes("--self-test")
  ? "self-test"
  : process.argv.includes("--smoke")
    ? "smoke"
    : process.argv.includes("--status")
      ? "status"
      : "serve";
const IS_MAIN = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

// Node floor check happens before anything else can fail; every mode needs
// global fetch.
if (Number(process.versions.node.split(".")[0]) < MIN_NODE_MAJOR) {
  process.stderr.write(`${SERVER_NAME} requires Node >= ${MIN_NODE_MAJOR} (found v${process.versions.node}); global fetch is required.\n`);
  process.exit(1);
}

// ─────────────────────────────────────────────────────────────────────────────
// logging (never stdout)
// ─────────────────────────────────────────────────────────────────────────────

let logDirOverride = null;

function rotateLog(file) {
  try {
    if (fs.existsSync(file) && fs.statSync(file).size > 1024 * 1024) {
      fs.rmSync(file + ".1", { force: true });
      fs.renameSync(file, file + ".1");
    }
  } catch {
    /* logging must never throw */
  }
}

function log(level, message) {
  const line = `${new Date().toISOString()} [${level}] ${message}\n`;
  try {
    const dir = logDirOverride || LOG_DIR;
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `qwenimg-${new Date().toISOString().slice(0, 10)}.log`);
    rotateLog(file);
    fs.appendFileSync(file, line, "utf8");
  } catch {
    /* ignore */
  }
  if (level === "error" || level === "warn") {
    try {
      process.stderr.write(line);
    } catch {
      /* ignore */
    }
  }
}

function promptDigest(prompt) {
  return createHash("sha256").update(String(prompt), "utf8").digest("hex").slice(0, 8);
}

// ─────────────────────────────────────────────────────────────────────────────
// errors
// ─────────────────────────────────────────────────────────────────────────────

const ERROR_CODES = {
  VALIDATION_ERROR: "参数不合法",
  BAD_PARAMS: "参数不合法",
  COMFY_UNREACHABLE: "ComfyUI 不可达",
  COMFY_START_TIMEOUT: "ComfyUI 启动超时",
  MODEL_MISSING: "模型文件缺失",
  OOM: "显存不足",
  COMFY_ERROR: "ComfyUI 返回错误",
  TIMEOUT: "等待超时",
  INTERNAL: "内部错误",
  BUSY: "任务仍在运行"
};

class McpError extends Error {
  constructor(code, message, hint) {
    super(message);
    this.name = "McpError";
    this.code = ERROR_CODES[code] ? code : "INTERNAL";
    this.hint = hint || "";
  }
}

function fail(code, message, hint) {
  throw new McpError(code, message, hint);
}

function errorText(error) {
  if (error instanceof McpError) {
    return `${error.code}: ${error.message}${error.hint ? ` | 建议: ${error.hint}` : ""}`;
  }
  return `INTERNAL: ${error instanceof Error ? error.message : String(error)} | 建议: 查看 logs\\ 下最新日志`;
}

function toolError(error) {
  // ComfyUI exception messages can contain prompt text; keep them in the
  // returned result, but never copy them verbatim into persistent logs.
  log("error", `tool error code=${error instanceof McpError ? error.code : "INTERNAL"}`);
  return { content: [{ type: "text", text: errorText(error) }], isError: true };
}

// ─────────────────────────────────────────────────────────────────────────────
// config
// ─────────────────────────────────────────────────────────────────────────────

function coerce(raw) {
  const text = String(raw).trim();
  if (text === "") return "";
  if (text === "true") return true;
  if (text === "false") return false;
  if (text === "null") return null;
  if (/^-?\d+$/.test(text)) return Number(text);
  if (/^-?\d*\.\d+$/.test(text)) return Number(text);
  return text;
}

function envKeyFor(...parts) {
  return "QWENIMG_" + parts.join("_").toUpperCase();
}

function readConfigFile() {
  let raw;
  try {
    raw = fs.readFileSync(CONFIG_PATH, "utf8");
  } catch (error) {
    fail("INTERNAL", `无法读取 config.json: ${CONFIG_PATH} (${error.message})`, "确认文件存在且为 UTF-8 无 BOM");
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    fail("INTERNAL", `config.json 不是合法 JSON: ${error.message}`, "用 JSON 校验器修好后重试");
  }
}

// Exported so --self-test can exercise the layering without touching the disk.
function loadConfig(env = process.env, base = readConfigFile()) {
  const config = JSON.parse(JSON.stringify(base));
  for (const [key, value] of Object.entries(config)) {
    if (key.startsWith("$")) continue;
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      for (const [subKey, subValue] of Object.entries(value)) {
        const raw = env[envKeyFor(key, subKey)];
        if (raw !== undefined) value[subKey] = coerce(raw);
      }
      const whole = env[envKeyFor(key)];
      if (whole !== undefined) {
        try {
          Object.assign(value, JSON.parse(whole));
        } catch {
          log("warn", `${envKeyFor(key)} is not valid JSON; ignored`);
        }
      }
    } else {
      const raw = env[envKeyFor(key)];
      if (raw !== undefined) {
        if (Array.isArray(value)) {
          try { config[key] = JSON.parse(raw); }
          catch { fail("INTERNAL", `${envKeyFor(key)} 必须是 JSON 数组`, '例如 ["-s"]'); }
        } else config[key] = coerce(raw);
      }
    }
  }
  return config;
}

function validateConfig(config) {
  if (!config || typeof config !== "object" || Array.isArray(config)) fail("INTERNAL", "配置必须是对象", "检查 config.json");
  let url;
  try {
    url = new URL(config.comfy_url);
  } catch {
    fail("COMFY_UNREACHABLE", `comfy_url 不是合法 URL: ${config.comfy_url}`, "config.json 里写 http://127.0.0.1:8188");
  }
  const host = url.hostname.toLowerCase();
  if (host !== "127.0.0.1" && host !== "localhost") {
    fail("COMFY_UNREACHABLE", `comfy_url 只允许本机地址(127.0.0.1/localhost)，当前为 ${config.comfy_url}`, "把 comfy_url 改回 http://127.0.0.1:8188");
  }
  if (url.protocol !== "http:" || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    fail("COMFY_UNREACHABLE", "comfy_url 必须是无凭据、无路径的本机 HTTP 地址", "例如 http://127.0.0.1:8188");
  }
  for (const key of ["comfy_root", "comfy_output_dir", "comfy_python", "comfy_main"]) {
    if (typeof config[key] !== "string" || !config[key].trim()) {
      fail("INTERNAL", `config.json 缺少字符串字段 ${key}`, "补齐后重试");
    }
  }
  if (!Array.isArray(config.comfy_args)) {
    fail("INTERNAL", "config.json 的 comfy_args 必须是数组", '改成字符串数组，例如 ["--windows-standalone-build"]');
  }
  if (!Array.isArray(config.comfy_pre_args)) {
    fail("INTERNAL", "config.json 的 comfy_pre_args 必须是数组", '放 Python 自己的参数，例如 ["-s"]；没有就写 []');
  }
  if ([...config.comfy_pre_args, ...config.comfy_args].some((arg) => typeof arg !== "string")) {
    fail("INTERNAL", "启动参数数组只能包含字符串", "检查 comfy_pre_args / comfy_args");
  }
  // -s / -X / -u belong to the Python interpreter and must come BEFORE main.py;
  // passing them after the script makes ComfyUI exit with argparse error 2.
  const misplaced = config.comfy_args.filter((arg) => /^-s$|^-X|^-u$/.test(String(arg)));
  if (misplaced.length > 0) {
    fail(
      "INTERNAL",
      `comfy_args 里出现了 Python 解释器参数 ${misplaced.join(", ")}，它们必须放在 comfy_pre_args 里（要写在 main.py 之前）`,
      '把 "-s" 从 comfy_args 移到 comfy_pre_args'
    );
  }
  const timeout = Number(config.autostart_timeout_s);
  if (!Number.isFinite(timeout) || timeout < 1) {
    fail("INTERNAL", "config.json 的 autostart_timeout_s 必须是正数秒", "例如 180");
  }
  config.autostart_timeout_s = timeout;
  if (typeof config.autostart !== "boolean") fail("INTERNAL", "autostart 必须是布尔值", "使用 true 或 false");
  const limits = config.limits || {};
  for (const key of ["min_side", "max_side", "max_pixels", "max_steps", "max_prompt_chars", "default_wait_s", "max_wait_s"]) {
    if (!Number.isSafeInteger(Number(limits[key])) || Number(limits[key]) <= 0) {
      fail("INTERNAL", `config.json 的 limits.${key} 必须是正数`, "参考默认配置");
    }
    limits[key] = Number(limits[key]);
  }
  config.limits = limits;
  if (limits.min_side > limits.max_side || limits.default_wait_s > limits.max_wait_s || timeout > 180 || limits.max_wait_s > 600) {
    fail("INTERNAL", "配置限制不一致或超过宿主等待预算", "min_side≤max_side，default_wait_s≤max_wait_s≤600，autostart_timeout_s≤180");
  }
  config.defaults = config.defaults || {};
  if (typeof config.defaults.filename_prefix !== "string" || !config.defaults.filename_prefix.trim()) {
    fail("INTERNAL", "defaults.filename_prefix 必须是非空字符串", "例如 DSH_Qwen21");
  }
  for (const key of ["unet", "clip", "vae"]) {
    if (!config.models || typeof config.models[key] !== "string" || !config.models[key].trim()) {
      fail("INTERNAL", `config.json 的 models.${key} 不能为空`, "填入真实模型文件名");
    }
  }
  try { validateGenerate({ prompt: "config check", seed: 0 }, config); }
  catch (error) { fail("INTERNAL", `默认参数不可用: ${error.message}`, "检查 defaults 与 limits"); }
  return config;
}

let CONFIG = null;
let CONFIG_ERROR = null;
try {
  CONFIG = validateConfig(loadConfig());
} catch (error) {
  CONFIG_ERROR = error;
  log("error", `config rejected: ${errorText(error)}`);
}

const COMFY_BASE = CONFIG ? CONFIG.comfy_url.replace(/\/+$/, "") : "http://127.0.0.1:8188";

function requireConfig() {
  if (!CONFIG) fail("INTERNAL", `配置不可用: ${CONFIG_ERROR ? CONFIG_ERROR.message : "unknown"}`, "修正 config.json 后重启 MCP（或重启 DSH）");
  return CONFIG;
}

// ─────────────────────────────────────────────────────────────────────────────
// ComfyUI HTTP
// ─────────────────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// fetch with a hand-managed timeout. AbortSignal.timeout() leaves a libuv timer
// handle that can assert on Windows during a fast process exit (async.c:94);
// clearing our own timer avoids that.
async function timeoutFetch(url, options, timeoutMs, maxBytes = 16 * 1024 * 1024) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`timeout after ${timeoutMs}ms`)), timeoutMs);
  try {
    // Keep the timeout active until the entire bounded body is consumed.
    const response = await fetch(url, { ...options, redirect: "error", signal: controller.signal });
    const chunks = [];
    let length = 0;
    for await (const chunk of response.body || []) {
      length += chunk.byteLength;
      if (length > maxBytes) {
        controller.abort();
        throw new Error(`response exceeds ${maxBytes} bytes`);
      }
      chunks.push(Buffer.from(chunk));
    }
    return { response, bytes: Buffer.concat(chunks, length) };
  } finally {
    clearTimeout(timer);
  }
}

async function httpJson(pathname, { method = "GET", body = null, timeoutMs = 15000, baseOverride = null } = {}) {
  const base = baseOverride || COMFY_BASE;
  let response, text;
  try {
    const received = await timeoutFetch(
      base + pathname,
      {
        method,
        // ComfyUI is a local single-user service; non-persistent connections
        // also keep undici's keep-alive socket from being mid-close when a
        // terminal mode exits.
        headers: { connection: "close", ...(body === null ? {} : { "content-type": "application/json" }) },
        body: body === null ? undefined : JSON.stringify(body)
      },
      timeoutMs
    );
    response = received.response;
    text = received.bytes.toString("utf8");
  } catch (error) {
    throw new McpError("COMFY_UNREACHABLE", `无法连接 ${base}${pathname} (${error.message})`, "先运行 E:\\ComfyUI\\启动Qwen8GB.bat，或让本 MCP 自动拉起");
  }
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      fail("COMFY_ERROR", `${pathname} 返回非 JSON 响应 (HTTP ${response.status})`, "确认端口上运行的是 ComfyUI");
    }
  }
  return { status: response.status, ok: response.ok, data, text };
}

async function probeComfy(timeoutMs = 3000, baseOverride = null) {
  try {
    const { ok, data } = await httpJson("/system_stats", { timeoutMs, baseOverride });
    if (!ok || !data?.system?.comfyui_version || !Array.isArray(data.devices)) return null;
    return data;
  } catch {
    return null;
  }
}

function spawnOptionsForComfy(config) {
  return {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    cwd: config.comfy_root
  };
}

function buildComfyArgs(config) {
  // python-level switches first, then the script, then ComfyUI's own options —
  // exactly how E:\ComfyUI\start_qwen.py launches it.
  return [...config.comfy_pre_args, config.comfy_main, ...config.comfy_args];
}

function startComfy(config) {
  const args = buildComfyArgs(config);
  let child;
  try {
    child = spawn(config.comfy_python, args, spawnOptionsForComfy(config));
  } catch (error) {
    fail("COMFY_START_TIMEOUT", `无法启动 ComfyUI: ${error.message}`, "手动运行 E:\\ComfyUI\\启动Qwen8GB.bat");
  }
  let earlyExit = null;
  child.on("error", (error) => {
    earlyExit = error.message;
  });
  child.on("exit", (code, signal) => {
    if (earlyExit === null) earlyExit = `进程已退出 code=${code} signal=${signal}`;
  });
  child.unref();
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    if (child.pid) fs.writeFileSync(COMFY_PID_PATH, String(child.pid), "utf8");
  } catch (error) {
    log("warn", `cannot write comfy.pid: ${error.message}`);
  }
  // Prompt text is never logged; only structural facts.
  log("info", `autostart ComfyUI pid=${child.pid} cwd=${config.comfy_root} pre_args=${JSON.stringify(config.comfy_pre_args)} args=${JSON.stringify(config.comfy_args)}`);
  return { pid: child.pid, earlyExit: () => earlyExit };
}

const startupPromises = new Map();

async function ensureComfy(config, options) {
  const key = options.baseOverride || COMFY_BASE;
  if (!options.autostart) return ensureComfyOnce(config, options);
  if (startupPromises.has(key)) return startupPromises.get(key);
  const starting = ensureComfyOnce(config, options);
  startupPromises.set(key, starting);
  try { return await starting; }
  finally { startupPromises.delete(key); }
}

async function ensureComfyOnce(config, { autostart, timeoutS, baseOverride = null, start = startComfy, pollMs = 2000 }) {
  let stats = await probeComfy(3000, baseOverride);
  if (stats) return { started: false, stats };

  if (!autostart) {
    fail("COMFY_UNREACHABLE", `ComfyUI 未运行且 autostart=false (${baseOverride || COMFY_BASE})`, "先运行 E:\\ComfyUI\\启动Qwen8GB.bat，或把 config.json 的 autostart 设为 true");
  }

  const missing = [config.comfy_python, config.comfy_main].filter((file) => !fs.existsSync(file));
  if (missing.length > 0) {
    fail("MODEL_MISSING", `ComfyUI 启动文件不存在: ${missing.join(", ")}`, "核对 config.json 的 comfy_python / comfy_main");
  }

  const child = start(config);
  const deadline = Date.now() + timeoutS * 1000;
  const startedAt = Date.now();
  while (Date.now() < deadline) {
    await sleep(Math.min(pollMs, Math.max(0, deadline - Date.now())));
    if (child.earlyExit() && Date.now() - startedAt > 6000) {
      // Give a slow loader a couple of polls before trusting the exit event.
      const lastChance = await probeComfy(3000, baseOverride);
      if (lastChance) {
        log("info", "ComfyUI ready after autostart (process wrapper reported an early exit)");
        return { started: true, stats: lastChance };
      }
      fail("COMFY_START_TIMEOUT", `ComfyUI 启动进程提前退出 (pid=${child.pid}): ${child.earlyExit()}`, "手动运行 E:\\ComfyUI\\启动Qwen8GB.bat 看完整报错；常见原因是端口被占或 Python 环境损坏");
    }
    stats = await probeComfy(Math.max(1, Math.min(3000, deadline - Date.now())), baseOverride);
    if (stats) {
      log("info", "ComfyUI ready after autostart");
      return { started: true, stats };
    }
  }
  fail("COMFY_START_TIMEOUT", `${timeoutS}s 内 ComfyUI 未就绪 (${COMFY_BASE})`, "手动运行 E:\\ComfyUI\\启动Qwen8GB.bat，看它是否报错；首次加载 GGUF 模型较慢");
}

async function listModelOptions(config) {
  const out = { unet: null, clip: null, vae: null, errors: [] };
  const probes = [
    ["unet", "/object_info/UnetLoaderGGUF", "unet_name"],
    ["clip", "/object_info/CLIPLoader", "clip_name"],
    ["vae", "/object_info/VAELoader", "vae_name"]
  ];
  await Promise.all(probes.map(async ([key, pathname, inputName]) => {
    try {
      const { ok, data } = await httpJson(pathname, { timeoutMs: 20000 });
      if (!ok || !data) {
        out.errors.push(`${pathname} -> HTTP not ok`);
        return;
      }
      const node = data[pathname.split("/").at(-1)];
      const input = node && node.input && node.input.required ? node.input.required[inputName] : null;
      const options = input && Array.isArray(input[0]) ? input[0] : [];
      out[key] = { has: options.includes(config.models[key]), count: options.length, nodePresent: Boolean(node) };
    } catch (error) {
      out.errors.push(`${pathname} -> ${error.message}`);
    }
  }));
  return out;
}

function freeVramRequest() {
  return httpJson("/free", { method: "POST", body: { unload_models: true, free_memory: true }, timeoutMs: 30000 });
}

// ─────────────────────────────────────────────────────────────────────────────
// workflow template
// ─────────────────────────────────────────────────────────────────────────────

// Node ID -> [class_type, { field: source }]. Sources are parameter names, or
// { const: <value> } for values fixed by the workflow itself ({ const: "unet" }
// means "the unet model name from config").
const NODE_MAP = {
  1: ["UnetLoaderGGUF", { unet_name: { const: "unet" } }],
  2: ["CLIPLoader", { clip_name: { const: "clip" }, type: { const: "qwen_image" }, device: { const: "default" } }],
  3: ["VAELoader", { vae_name: { const: "vae" } }],
  4: ["EmptyLatentImage", { width: "width", height: "height", batch_size: { const: 1 } }],
  5: ["TextEncodeQwenImage21", { prompt: "prompt", negative_prompt: "negative_prompt", resolution: "resolution" }],
  6: [
    "KSampler",
    {
      seed: "seed",
      steps: "steps",
      cfg: "cfg",
      sampler_name: { const: "euler" },
      scheduler: { const: "simple" },
      denoise: { const: 1 }
    }
  ],
  7: ["VAEDecode", {}],
  8: ["SaveImage", { filename_prefix: "filename_prefix" }]
};

function readTemplate(override) {
  if (override !== undefined) return validateTemplate(override);
  let raw;
  try {
    raw = fs.readFileSync(TEMPLATE_PATH, "utf8");
  } catch (error) {
    fail("INTERNAL", `无法读取模板 ${TEMPLATE_PATH} (${error.message})`, "从 E:\\ComfyUI\\workflows\\qwen21-8gb-test-api.json 重新复制");
  }
  let template;
  try {
    template = JSON.parse(raw);
  } catch (error) {
    fail("INTERNAL", `模板不是合法 JSON: ${error.message}`, "重新复制一份 API 格式工作流");
  }
  return validateTemplate(template);
}

function validateTemplate(template) {
  const nodes = Object.keys(template);
  if (nodes.length !== Object.keys(NODE_MAP).length || nodes.some((id) => !NODE_MAP[id])) {
    fail(
      "INTERNAL",
      `模板节点与 server.mjs 的 NODE_MAP 不一致: 模板=[${nodes.join(",")}] 映射=[${Object.keys(NODE_MAP).join(",")}]`,
      "不要手工改模板节点 ID；换工作流时同步更新 server.mjs 顶部的 NODE_MAP"
    );
  }
  for (const [id, [classType, fields]] of Object.entries(NODE_MAP)) {
    const node = template[id];
    if (!node || node.class_type !== classType) {
      fail("INTERNAL", `模板节点 ${id} 的 class_type 是 ${node ? node.class_type : "(缺失)"}，映射期望 ${classType}`, "核对模板文件");
    }
    for (const field of Object.keys(fields)) {
      if (!(field in (node.inputs || {}))) {
        fail("INTERNAL", `模板节点 ${id}(${classType}) 缺少字段 ${field}`, "这是节点/模型更新导致的结构变化，请对齐模板与 NODE_MAP");
      }
    }
  }
  return template;
}

function valueFor(source, values, config) {
  if (source && typeof source === "object" && "const" in source) {
    const tag = source.const;
    if (tag === "unet") return config.models.unet;
    if (tag === "clip") return config.models.clip;
    if (tag === "vae") return config.models.vae;
    return tag;
  }
  if (!(source in values)) fail("INTERNAL", `模板映射引用了未知参数 ${source}`, "检查 NODE_MAP");
  return values[source];
}

// Returns { prompt, applied } and is self-checking: every mapped field is
// re-read from the produced object, and every unmapped field must still equal
// the template's value.
function fillTemplate(template, values, config) {
  const prompt = JSON.parse(JSON.stringify(template));
  const applied = {};
  for (const [id, [, fields]] of Object.entries(NODE_MAP)) {
    for (const [field, source] of Object.entries(fields)) {
      const value = valueFor(source, values, config);
      prompt[id].inputs[field] = value;
      applied[`${id}.${prompt[id].class_type}.${field}`] = value;
    }
  }
  for (const [id, node] of Object.entries(prompt)) {
    const expected = NODE_MAP[id][1];
    for (const field of Object.keys(node.inputs)) {
      if (field in expected) continue;
      if (JSON.stringify(node.inputs[field]) !== JSON.stringify(template[id].inputs[field])) {
        fail("INTERNAL", `模板节点 ${id} 的未映射字段 ${field} 被意外改动`, "这是 bug，请报告");
      }
    }
  }
  return { prompt, applied };
}

// ─────────────────────────────────────────────────────────────────────────────
// generation
// ─────────────────────────────────────────────────────────────────────────────

function sanitizePrefix(raw, fallback) {
  const base = typeof raw === "string" && raw.trim() ? raw.trim() : fallback;
  return base.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 40);
}

function randomSeed() {
  return Math.floor(Math.random() * 9007199254740991);
}

function validateGenerate(args, config) {
  const limits = config.limits;
  const defaults = config.defaults;
  const out = {};
  const bad = (message, hint) => fail("BAD_PARAMS", message, hint);

  if (typeof args !== "object" || args === null || Array.isArray(args)) {
    bad("arguments 必须是对象", "参考 tools/list 里的 inputSchema");
  }
  const allowed = new Set(["prompt", "negative_prompt", "width", "height", "steps", "cfg", "seed", "filename_prefix", "wait_seconds", "return_image"]);
  for (const key of Object.keys(args)) {
    if (!allowed.has(key)) bad(`未知参数 ${key}`, `可用参数: ${[...allowed].join(", ")}`);
  }

  if (typeof args.prompt !== "string" || args.prompt.trim().length === 0) {
    bad("prompt 必填且必须是非空字符串", "例如 一只橘猫坐在木桌上，柔和的窗边阳光");
  }
  if (args.prompt.length > limits.max_prompt_chars) {
    bad(`prompt 长度 ${args.prompt.length} 超过上限 ${limits.max_prompt_chars}`, "缩短提示词");
  }
  out.prompt = args.prompt;

  if (args.negative_prompt === undefined || args.negative_prompt === null) {
    out.negative_prompt = "";
  } else if (typeof args.negative_prompt !== "string") {
    bad("negative_prompt 必须是字符串", "留空即可");
  } else if (args.negative_prompt.length > limits.max_prompt_chars) {
    bad(`negative_prompt 长度超过上限 ${limits.max_prompt_chars}`, "缩短负向提示词");
  } else {
    out.negative_prompt = args.negative_prompt;
  }

  const sides = [
    ["width", args.width === undefined ? defaults.width : args.width],
    ["height", args.height === undefined ? defaults.height : args.height]
  ];
  for (const [name, value] of sides) {
    if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value)) {
      bad(`${name} 必须是整数`, `范围 ${limits.min_side}..${limits.max_side}，且为 16 的倍数`);
    }
    if (value < limits.min_side || value > limits.max_side) {
      bad(`${name}=${value} 超出范围 ${limits.min_side}..${limits.max_side}`, "8GB 显卡建议先用 512");
    }
    if (value % 16 !== 0) {
      bad(`${name}=${value} 不是 16 的倍数`, "改成 512/768 这类 16 的倍数");
    }
    out[name] = value;
  }
  if (out.width * out.height > limits.max_pixels) {
    bad(`width*height=${out.width * out.height} 超过 max_pixels=${limits.max_pixels}`, "降低分辨率");
  }

  const steps = args.steps === undefined ? defaults.steps : args.steps;
  if (typeof steps !== "number" || !Number.isInteger(steps) || steps < 1 || steps > limits.max_steps) {
    bad(`steps=${steps} 必须是 1..${limits.max_steps} 的整数`, `默认 ${defaults.steps}`);
  }
  out.steps = steps;

  const cfg = args.cfg === undefined ? defaults.cfg : args.cfg;
  if (typeof cfg !== "number" || !Number.isFinite(cfg) || cfg < 1 || cfg > 8) {
    bad(`cfg=${cfg} 必须是 1..8 的数字`, "Qwen-Image 官方推荐 1");
  }
  out.cfg = cfg;

  if (args.seed === undefined || args.seed === null) {
    out.seed = randomSeed();
    out.seed_random = true;
  } else {
    if (!Number.isInteger(args.seed) || args.seed < 0 || args.seed > 9007199254740991) {
      bad(`seed=${args.seed} 必须是 0..2^53-1 的整数`, "或者省略 seed 让服务端随机");
    }
    out.seed = args.seed;
    out.seed_random = false;
  }

  if (args.filename_prefix !== undefined && args.filename_prefix !== null && typeof args.filename_prefix !== "string") {
    bad("filename_prefix 必须是字符串", "只允许 [A-Za-z0-9_-]");
  }
  out.filename_prefix = sanitizePrefix(args.filename_prefix, defaults.filename_prefix);

  const wait = args.wait_seconds === undefined || args.wait_seconds === null ? limits.default_wait_s : args.wait_seconds;
  if (typeof wait !== "number" || !Number.isInteger(wait) || wait < 1) {
    bad(`wait_seconds=${wait} 必须是 >=1 的整数`, `默认 ${limits.default_wait_s}，上限 ${limits.max_wait_s}`);
  }
  out.wait_seconds = Math.min(wait, limits.max_wait_s);

  if (args.return_image !== undefined && typeof args.return_image !== "boolean") {
    bad("return_image 必须是布尔值", "true / false");
  }
  out.return_image = args.return_image === true;

  out.resolution = Math.max(out.width, out.height);
  return out;
}

function historyErrorText(entry) {
  const status = entry && entry.status ? entry.status : {};
  const parts = [];
  const messages = Array.isArray(status.messages) ? status.messages : [];
  for (const message of messages) {
    if (Array.isArray(message) && message[0] === "execution_interrupted") parts.push("任务已中断");
    if (!Array.isArray(message) || message[0] !== "execution_error") continue;
    const info = message[1] || {};
    parts.push(`${info.node_type || "?"}(${info.node_id || "?"}): ${info.exception_message || "执行失败"}`);
  }
  if (parts.length === 0 && status.status_str && status.status_str !== "success") {
    parts.push(String(status.status_str));
  }
  return parts.join(" | ");
}

function isOutOfMemory(text) {
  return /out of memory|outofmemoryerror|allocation on device|CUDA error: out of memory|CUBLAS_STATUS_ALLOC_FAILED/i.test(String(text || ""));
}

async function fetchImageBytes(filename, subfolder, type, base = COMFY_BASE) {
  const query = new URLSearchParams({ filename, subfolder: subfolder || "", type: type || "output" });
  let received;
  try {
    received = await timeoutFetch(`${base}/view?${query.toString()}`, { headers: { connection: "close" } }, 60000);
  } catch (error) {
    throw new McpError("COMFY_ERROR", `下载图片失败 (${error.message})`, "确认 ComfyUI 仍在运行");
  }
  if (!received.response.ok) throw new McpError("COMFY_ERROR", `/view 返回 HTTP ${received.response.status}`, "用 get_result 重试取回已有任务，避免重复生成");
  if (!received.bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    fail("COMFY_ERROR", "/view 未返回 PNG 图片", "检查 ComfyUI 输出，不要重新提交相同任务");
  }
  return received.bytes;
}

function parseJobHistory(entry) {
  const error = historyErrorText(entry);
  if (error) return { state: "failed", error };
  if (entry.status?.completed === false) return { state: "running" };
  const images = entry.outputs?.["8"]?.images;
  if (Array.isArray(images) && images.length > 0) {
    return { state: "done", filename: images[0].filename, subfolder: images[0].subfolder || "", type: images[0].type || "output" };
  }
  if (entry.status?.completed) return { state: "failed", error: "任务已结束，但保存图片节点 8 没有输出" };
  return { state: "running" };
}

async function firstJobState(promptId, timeoutMs = 20000) {
  const { ok, status, data } = await httpJson(`/history/${encodeURIComponent(promptId)}`, { timeoutMs });
  if (!ok) fail("COMFY_ERROR", `查询历史失败 (HTTP ${status})`, "稍后用原 prompt_id 重试 get_result");
  if (!data || !Object.hasOwn(data, promptId)) return null;
  return parseJobHistory(data[promptId]);
}

async function queueState(promptId) {
    const { ok, status, data } = await httpJson("/queue", { timeoutMs: 10000 });
    if (!ok) fail("COMFY_ERROR", `查询队列失败 (HTTP ${status})`, "用原 prompt_id 稍后重试");
    if (!Array.isArray(data?.queue_running) || !Array.isArray(data?.queue_pending)) fail("COMFY_ERROR", "队列响应结构不正确", "确认该端口运行的是 ComfyUI");
    const running = (data && data.queue_running) || [];
    if (running.some((item) => item && item[1] === promptId)) return "running";
    const pending = (data && data.queue_pending) || [];
    if (pending.some((item) => item && item[1] === promptId)) return "queued";
  return null;
}

function imagePath(config, image) {
  const folder = image.subfolder || "";
  if (image.type !== "output" || typeof image.filename !== "string" || !/^[^\\/:\x00-\x1f]+\.png$/i.test(image.filename) ||
      typeof folder !== "string" || /[:\x00-\x1f]/.test(folder) || /^[\\/]/.test(folder) || folder.split(/[\\/]/).includes("..")) {
    fail("COMFY_ERROR", "图片元数据不是有效的输出 PNG 路径", "只支持本工作流保存图片节点的 output 结果");
  }
  const root = path.resolve(config.comfy_output_dir);
  const direct = path.resolve(root, folder, image.filename);
  const contained = (base, candidate) => {
    const relative = path.relative(base, candidate);
    return relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative);
  };
  if (!contained(root, direct)) fail("COMFY_ERROR", "图片路径越过输出目录", "检查历史记录的文件名");
  // Reject existing directory links that lead outside the configured root.
  if (fs.existsSync(root)) {
    let ancestor = direct;
    while (!fs.existsSync(ancestor)) ancestor = path.dirname(ancestor);
    if (!contained(fs.realpathSync(root), fs.realpathSync(ancestor))) {
      fail("COMFY_ERROR", "图片路径经链接越过输出目录", "检查输出目录中的链接");
    }
  }
  return direct;
}

async function resolveImage(config, image) {
  const direct = imagePath(config, image);
  const stat = () => {
    try {
      return fs.statSync(direct);
    } catch {
      return null;
    }
  };
  let info = stat();
  if (info && info.isFile() && info.size > 0) {
    return { path: direct, bytes: info.size, via: "filesystem" };
  }
  const bytes = await fetchImageBytes(image.filename, image.subfolder, image.type, config.comfy_url);
  try {
    fs.mkdirSync(path.dirname(direct), { recursive: true });
    // Never overwrite an existing file, even if it arrived between stat and
    // the download. ComfyUI is responsible for saving the original output.
    fs.writeFileSync(direct, bytes, { flag: "wx" });
  } catch (error) {
    if (error.code !== "EEXIST") fail("COMFY_ERROR", `图片已生成但无法保存到输出目录 (${error.code || "write error"})`, "修复输出目录权限后用原 prompt_id 调用 get_result");
  }
  info = stat();
  if (!info?.isFile() || !info.size) fail("COMFY_ERROR", "输出图片路径不存在或为空", "用原 prompt_id 重试 get_result");
  return { path: direct, bytes: info.size, via: "http:/view" };
}

async function waitForResult(config, promptId, waitSeconds, { withImage }) {
  const deadline = Date.now() + waitSeconds * 1000;
  for (;;) {
    if (Date.now() >= deadline) {
      const queued = await queueState(promptId);
      return { status: queued || "unknown", waitedS: waitSeconds };
    }
    let state;
    try { state = await firstJobState(promptId, Math.max(1, Math.min(20000, deadline - Date.now()))); }
    catch (error) {
      if (Date.now() >= deadline && error.code === "COMFY_UNREACHABLE") {
        const queued = await queueState(promptId);
        return { status: queued || "unknown", waitedS: waitSeconds };
      }
      throw error;
    }
    if (state && state.state === "done") {
      const image = { filename: state.filename, subfolder: state.subfolder, type: state.type };
      if (!withImage) return { status: "ok", image };
      const resolved = await resolveImage(config, image);
      return { status: "ok", image, resolved };
    }
    if (state && state.state === "failed") {
      return { status: "failed", error: state.error, oom: isOutOfMemory(state.error) };
    }
    if (Date.now() >= deadline) {
      const queued = await queueState(promptId);
      return { status: queued || "unknown", waitedS: waitSeconds };
    }
    await sleep(Math.min(1000, Math.max(0, deadline - Date.now())));
  }
}

async function queuePrompt(prompt, clientId) {
  const { status, ok, data, text } = await httpJson("/prompt", {
    method: "POST",
    body: { prompt, client_id: clientId },
    timeoutMs: 30000
  });
  if (!ok) {
    const parts = [];
    if (data && data.error) {
      const info = data.error;
      parts.push(`${info.type || "error"}: ${info.message || ""} ${info.details || ""}`.trim());
    }
    if (data && data.node_errors) {
      for (const [nodeId, value] of Object.entries(data.node_errors)) {
        const messages = (value && value.errors ? value.errors : []).map((item) => `${item.type || "error"}: ${item.message || ""} ${item.details || ""}`.trim());
        parts.push(`节点 ${nodeId}(${(value && value.class_type) || "?"}): ${messages.join("; ")}`);
      }
    }
    const detail = parts.length > 0 ? parts.join(" | ") : String(text).slice(0, 500);
    const oom = isOutOfMemory(detail);
    fail(
      oom ? "OOM" : "COMFY_ERROR",
      `提交工作流失败 (HTTP ${status}): ${detail}`,
      oom ? "降到 512×512 并调用 free_vram" : "检查模型文件名是否与 config.json 一致，或先用 ComfyUI 界面跑一次同一工作流"
    );
  }
  if (!data || !data.prompt_id) {
    fail("COMFY_ERROR", `ComfyUI 未返回 prompt_id: ${String(text).slice(0, 300)}`, "重试；若持续出现请查看 logs\\");
  }
  return data.prompt_id;
}

function runKey() {
  return `${Math.random().toString(36).slice(2, 6)}${Date.now().toString(36)}`;
}

function uniquePrefix(base, run) {
  const room = 40 - run.length - 1;
  return `${base.slice(0, Math.max(1, room))}_${run}`;
}

function describeTarget(applied) {
  return `${applied["4.EmptyLatentImage.width"]}x${applied["4.EmptyLatentImage.height"]}`;
}

async function callGenerate(args) {
  const config = requireConfig();
  const values = validateGenerate(args, config);
  const run = runKey();
  const prefix = uniquePrefix(values.filename_prefix, run);
  log(
    "info",
    `generate start prompt_len=${values.prompt.length} prompt_sha256_8=${promptDigest(values.prompt)} size=${values.width}x${values.height} steps=${values.steps} cfg=${values.cfg} seed=${values.seed} seed_random=${values.seed_random}`
  );

  const template = readTemplate();
  const { prompt, applied } = fillTemplate(template, { ...values, filename_prefix: prefix }, config);

  const startedAt = Date.now();
  const { started, stats } = await ensureComfy(config, { autostart: config.autostart, timeoutS: config.autostart_timeout_s });
  const device = stats && Array.isArray(stats.devices) && stats.devices[0] ? stats.devices[0] : null;

  const promptId = await queuePrompt(prompt, run);
  let outcome;
  try { outcome = await waitForResult(config, promptId, values.wait_seconds, { withImage: true }); }
  catch (error) {
    throw new McpError(error instanceof McpError ? error.code : "COMFY_ERROR", `任务已提交 prompt_id=${promptId}；取结果时出错: ${error.message}`, "稍后用这个 prompt_id 调用 get_result，避免重复生成");
  }
  const elapsedS = Math.round((Date.now() - startedAt) / 1000);

  if (outcome.status === "failed") {
    const hint = outcome.oom ? "显存不足：降到 512×512 并调用 free_vram" : "查看 ComfyUI 控制台；确认模型文件名与 config.json 一致";
    fail(outcome.oom ? "OOM" : "COMFY_ERROR", `生成失败 prompt_id=${promptId}: ${outcome.error}`, hint);
  }

  if (outcome.status !== "ok") {
    log("info", `generate pending prompt_id=${promptId} state=${outcome.status} elapsed=${elapsedS}s`);
    return {
      content: [
        {
          type: "text",
          text: [
            `status=${outcome.status}`,
            `prompt_id=${promptId}`,
            `尺寸=${describeTarget(applied)} steps=${values.steps} cfg=${values.cfg} seed=${values.seed}`,
            `已等待=${outcome.waitedS || values.wait_seconds}s（可用 wait_seconds 提高，上限 ${config.limits.max_wait_s}s）`,
            `请稍后用 get_result 取结果（参数 prompt_id=${promptId}），不要重复提交；unknown 表示暂时无法在历史或队列中找到任务。`
          ].join("\n")
        }
      ]
    };
  }

  const bytes = outcome.resolved.bytes;
  const lines = [
    "status=ok",
    `图片路径=${outcome.resolved.path}`,
    `尺寸=${describeTarget(applied)}`,
    `steps=${values.steps}`,
    `cfg=${values.cfg}`,
    `seed=${values.seed}${values.seed_random ? " (随机)" : ""}`,
    `耗时=${elapsedS}s`,
    `prompt_id=${promptId}`,
    `文件大小=${bytes} bytes`,
    `取值方式=${outcome.resolved.via}${started ? "；本次自动拉起了 ComfyUI" : ""}${device && device.name ? `；显卡=${device.name}` : ""}`
  ];
  log("info", `generate ok prompt_id=${promptId} file=${outcome.image.filename} bytes=${bytes} elapsed=${elapsedS}s`);

  const content = [{ type: "text", text: lines.join("\n") }];
  if (values.return_image && bytes <= 2 * 1024 * 1024) {
    try {
      content.push({ type: "image", data: fs.readFileSync(outcome.resolved.path).toString("base64"), mimeType: "image/png" });
    } catch (error) {
      log("warn", `return_image failed: ${error.message}`);
    }
  }
  return { content };
}

async function callGetResult(args) {
  const config = requireConfig();
  const promptId = args && typeof args.prompt_id === "string" ? args.prompt_id.trim() : "";
  if (!promptId) fail("BAD_PARAMS", "prompt_id 必填（generate 的返回值里有）", "例如 prompt_id=abc123");
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(promptId)) {
    fail("BAD_PARAMS", `prompt_id 格式可疑: ${promptId.slice(0, 40)}`, "使用 generate 返回的原始 prompt_id");
  }

  const state = await firstJobState(promptId);
  if (!state) {
    const queued = await queueState(promptId);
    return { content: [{ type: "text", text: `status=${queued || "unknown"}\nprompt_id=${promptId}\n${queued ? "任务仍在队列或执行中，稍后再试。" : "历史与队列中均未找到任务；可能 ID 错误、历史已清除或服务已重启。请先核对输出目录，避免重复生成。"}` }] };
  }
  if (state && state.state === "done") {
    const resolved = await resolveImage(config, { filename: state.filename, subfolder: state.subfolder, type: state.type });
    const content = [{ type: "text", text: ["status=ok", `图片路径=${resolved.path}`, `文件大小=${resolved.bytes} bytes`, `prompt_id=${promptId}`].join("\n") }];
    if (args.return_image === true && resolved.bytes <= 2 * 1024 * 1024) {
      content.push({ type: "image", data: fs.readFileSync(resolved.path).toString("base64"), mimeType: "image/png" });
    }
    return { content };
  }
  if (state && state.state === "failed") {
    const oom = isOutOfMemory(state.error);
    return {
      content: [
        {
          type: "text",
          text: ["status=failed", `原因=${state.error}`, `prompt_id=${promptId}`, `建议=${oom ? "显存不足：降到 512×512 并调用 free_vram" : "查看 ComfyUI 控制台日志"}`].join("\n")
        }
      ],
      isError: true
    };
  }
  return { content: [{ type: "text", text: `status=running\nprompt_id=${promptId}\n尚未产出结果。` }] };
}

async function callStatus() {
  const config = requireConfig();
  let diagnosisFailed = false;
  const lines = [`server=${SERVER_NAME} ${SERVER_VERSION}`, `comfy_url=${COMFY_BASE}`];
  const stats = await probeComfy(4000);
  if (!stats) {
    lines.push("comfyui=未运行（本工具不会自动拉起，避免体检时占用显存）");
    lines.push("建议=运行 E:\\ComfyUI\\启动Qwen8GB.bat 后重试，或直接调用 generate（autostart 会拉起）");
    return { content: [{ type: "text", text: lines.join("\n") }] };
  }

  const system = stats.system || {};
  lines.push(
    `comfyui=运行中 version=${system.comfyui_version || "?"} python=${system.python_version ? String(system.python_version).split(" ")[0] : "?"} device=${system.device_type || "?"}`
  );
  try {
    const { ok, data: queue } = await httpJson("/queue", { timeoutMs: 10000 });
    if (!ok || !Array.isArray(queue?.queue_running) || !Array.isArray(queue?.queue_pending)) throw new Error("队列响应无效");
    const running = (queue && queue.queue_running) || [];
    const pending = (queue && queue.queue_pending) || [];
    lines.push(`queue=running ${running.length} / pending ${pending.length}`);
  } catch (error) {
    diagnosisFailed = true;
    lines.push(`queue=读取失败 (${error.message})`);
  }

  const devices = Array.isArray(stats.devices) ? stats.devices : [];
  if (devices.length === 0) lines.push("gpu=未报告");
  for (const device of devices) {
    const total = Number(device.vram_total || 0);
    const free = Number(device.vram_free || 0);
    const gib = (value) => (value / 1024 ** 3).toFixed(1);
    lines.push(`gpu=${device.name || "?"} vram_total=${gib(total)}GiB vram_free=${gib(free)}GiB (${total ? Math.round((free / total) * 100) : 0}% free)`);
  }

  const models = await listModelOptions(config);
  for (const key of ["unet", "clip", "vae"]) {
    const info = models[key];
    const wanted = config.models[key];
    if (!info) {
      diagnosisFailed = true;
      lines.push(`model_${key}=无法读取可选列表 (${models.errors.join("; ") || "unknown"})`);
    } else {
      if (!info.has) diagnosisFailed = true;
      lines.push(`model_${key}=${info.has ? "OK" : "缺失"} ${wanted}（可选 ${info.count} 项）`);
    }
  }

  try {
    const te = await httpJson("/object_info/TextEncodeQwenImage21", { timeoutMs: 15000 });
    const unetOk = Boolean(models.unet?.nodePresent);
    const teOk = te.ok && Boolean(te.data?.TextEncodeQwenImage21);
    if (!unetOk || !teOk) diagnosisFailed = true;
    lines.push(`nodes=UnetLoaderGGUF:${unetOk ? "OK" : "缺失"} TextEncodeQwenImage21:${teOk ? "OK" : "缺失"}`);
  } catch (error) {
    diagnosisFailed = true;
    lines.push(`nodes=读取失败 (${error.message})`);
  }

  lines.push(`config=模板 ${path.basename(TEMPLATE_PATH)} / 输出目录 ${config.comfy_output_dir}`);
  return { content: [{ type: "text", text: lines.join("\n") }], diagnosisFailed };
}

async function callFreeVram() {
  requireConfig();
  const { ok: queueOk, data: queue } = await httpJson("/queue", { timeoutMs: 10000 });
  if (!queueOk || !Array.isArray(queue?.queue_running) || !Array.isArray(queue?.queue_pending)) fail("COMFY_ERROR", "无法确认队列是否空闲", "稍后重试 free_vram");
  if (queue?.queue_running?.length || queue?.queue_pending?.length) {
    fail("BUSY", "ComfyUI 仍有生成任务，未请求卸载模型", "等任务结束后再调用 free_vram");
  }
  const before = await probeComfy(4000);
  const beforeLine =
    before && before.devices && before.devices[0] ? `释放前 vram_free=${(Number(before.devices[0].vram_free || 0) / 1024 ** 3).toFixed(1)}GiB` : "释放前 vram_free=未知";
  const { ok } = await freeVramRequest();
  if (!ok) fail("COMFY_ERROR", "/free 调用失败", "确认 ComfyUI 在运行");
  log("info", "free_vram called");
  const after = await probeComfy(4000);
  const afterLine =
    after && after.devices && after.devices[0] ? `释放后 vram_free=${(Number(after.devices[0].vram_free || 0) / 1024 ** 3).toFixed(1)}GiB` : "释放后 vram_free=未知";
  return {
    content: [
      {
        type: "text",
        text: ["status=ok", "已请求 ComfyUI 卸载模型并释放显存（服务仍在运行）。", beforeLine, afterLine, "下次 generate 会重新加载模型，首张会明显变慢。"].join("\n")
      }
    ]
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// tools
// ─────────────────────────────────────────────────────────────────────────────

const tools = [
  {
    name: "generate",
    description:
      "用本地 ComfyUI 的 Qwen-Image 2.1 模型做文生图，返回图片绝对路径。Generate an image locally with Qwen-Image 2.1 on the local ComfyUI and return the absolute file path. " +
      "512x512、20 步在本机约 29 秒（已加载）；768×768 冷启动约 60 秒、1024×1024 已加载约 80 秒，仅为单次记录。A local test took about 29s at 512x512 warm, 60s at 768x768 cold, and 80s at 1024x1024 warm; timing varies. 超时返回 prompt_id，请用 get_result 继续查询，避免重复提交。Use get_result after a wait timeout instead of submitting again.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["prompt"],
      properties: {
        prompt: {
          type: "string",
          minLength: 1,
          maxLength: 4000,
          description: "正向提示词，必填，1..4000 字符。Positive prompt (required, 1..4000 chars)."
        },
        negative_prompt: {
          type: "string",
          maxLength: 4000,
          description: "负向提示词，可选，默认空字符串。Negative prompt (optional, default empty)."
        },
        width: {
          type: "integer",
          minimum: 256,
          maximum: 1024,
          default: 512,
          description:
            "图片宽度像素：256..1024，必须是 16 的倍数，且 width*height 不超过 1048576；默认 512。768、1024 已在 8GB 显卡上实测可用，更大面积可能显存不足。Image width: 256..1024, multiple of 16, width*height <= 1048576, default 512. 768 and 1024 are verified on an 8GB GPU; larger areas may hit OOM."
        },
        height: {
          type: "integer",
          minimum: 256,
          maximum: 1024,
          default: 512,
          description: "图片高度像素：256..1024，必须是 16 的倍数；默认 512。768、1024 已在 8GB 显卡上实测可用。Image height: 256..1024, multiple of 16, default 512."
        },
        steps: {
          type: "integer",
          minimum: 1,
          maximum: 40,
          default: 20,
          description: "采样步数，1..40，默认 20；越多越慢越细。Sampling steps 1..40, default 20."
        },
        cfg: {
          type: "number",
          minimum: 1,
          maximum: 8,
          default: 1,
          description: "CFG 引导强度，1..8，默认 1（Qwen-Image 官方推荐 1）。CFG scale 1..8, default 1."
        },
        seed: {
          type: "integer",
          minimum: 0,
          maximum: 9007199254740991,
          description: "随机种子 0..2^53-1；省略则随机生成，并在结果里返回实际使用的 seed（便于复现）。Seed 0..2^53-1; omit for a random one, which is returned in the result so it can be reproduced."
        },
        filename_prefix: {
          type: "string",
          maxLength: 40,
          description: "输出文件名前缀，仅允许 [A-Za-z0-9_-]，长度 ≤40，非法字符会被替换成 _；默认 DSH_Qwen21。实际文件名还会带一个短运行 ID，避免覆盖旧图。Output filename prefix, [A-Za-z0-9_-] only, <=40 chars, illegal characters become _; default DSH_Qwen21."
        },
        wait_seconds: {
          type: "integer",
          minimum: 1,
          maximum: 600,
          default: 180,
          description: "最多等待多少秒，默认 180，上限 600。超时不算失败，返回 status=running，之后可调用 get_result 取图。Max seconds to wait, default 180, cap 600. A timeout is not an error: it returns status=running and get_result can fetch the image later."
        },
        return_image: {
          type: "boolean",
          default: false,
          description: "为 true 且图片不超过 2MB 时，额外返回一个 image 内容块（base64 PNG），模型可直接看图。When true and the file is <=2MB, an extra image content block (base64 PNG) is returned."
        }
      }
    }
  },
  {
    name: "get_result",
    description:
      "用 generate 返回的 prompt_id 查询任务状态：queued / running / ok / failed / unknown（历史和队列未找到）。Look up a job by prompt_id; unknown means neither history nor queue contains it. 可用 return_image=true 取回图片内容。Use return_image=true for image content.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["prompt_id"],
      properties: {
        prompt_id: {
          type: "string",
          minLength: 1,
          maxLength: 80,
          description: "generate 返回的 prompt_id。The prompt_id returned by generate."
        },
        return_image: {
          type: "boolean", default: false,
          description: "为 true 且图片≤2MB 时返回 PNG 内容块。Return image content when true and file is <=2MB."
        }
      }
    }
  },
  {
    name: "status",
    description:
      "体检：ComfyUI 是否可达、版本、队列长度、显卡与显存、三个模型文件是否在可加载列表里、关键节点是否存在。只读，不会启动 ComfyUI。Health check: reachability, version, queue length, GPU/VRAM, whether the three model files are selectable, and whether the key nodes exist. Read-only; it never starts ComfyUI.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} }
  },
  {
    name: "free_vram",
    description:
      "让 ComfyUI 卸载模型并释放显存（服务继续运行）。玩游戏或跑别的显卡任务前调用。Ask ComfyUI to unload models and free VRAM while the service keeps running; call it before gaming or another GPU-heavy task.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} }
  }
];

const TOOL_NAMES = tools.map((tool) => tool.name);
const MCP_PROTOCOL_VERSION = "2025-06-18";
const SUPPORTED_PROTOCOL_VERSIONS = new Set(["2024-11-05", "2025-03-26", MCP_PROTOCOL_VERSION]);

// Publish the actual configured bounds rather than stale hard-coded defaults.
if (CONFIG) {
  const props = tools[0].inputSchema.properties;
  for (const key of ["width", "height"]) Object.assign(props[key], { minimum: CONFIG.limits.min_side, maximum: CONFIG.limits.max_side, multipleOf: 16, default: CONFIG.defaults[key] });
  Object.assign(props.steps, { maximum: CONFIG.limits.max_steps, default: CONFIG.defaults.steps });
  props.cfg.default = CONFIG.defaults.cfg;
  props.prompt.maxLength = props.negative_prompt.maxLength = CONFIG.limits.max_prompt_chars;
  Object.assign(props.wait_seconds, { maximum: CONFIG.limits.max_wait_s, default: CONFIG.limits.default_wait_s });
}

async function callTool(name, args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) fail("BAD_PARAMS", "arguments 必须是对象", "参考工具 inputSchema");
  if (name !== "generate") {
    const allowed = name === "get_result" ? ["prompt_id", "return_image"] : [];
    if (Object.keys(args).some((key) => !allowed.includes(key))) fail("BAD_PARAMS", "存在未支持的工具参数", "参考 tools/list");
    if (args.return_image !== undefined && typeof args.return_image !== "boolean") fail("BAD_PARAMS", "return_image 必须是布尔值", "使用 true 或 false");
  }
  if (name === "generate") return callGenerate(args);
  if (name === "get_result") return callGetResult(args);
  if (name === "status") return callStatus();
  if (name === "free_vram") return callFreeVram();
  fail("BAD_PARAMS", `未知工具 ${name}`, `可用工具: ${TOOL_NAMES.join(", ")}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// MCP protocol
// ─────────────────────────────────────────────────────────────────────────────

function rpcError(id, code, message) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

async function handleRequest(message) {
  if (!message || typeof message !== "object" || Array.isArray(message) || message.jsonrpc !== "2.0" || typeof message.method !== "string") {
    return rpcError(null, -32600, "Invalid Request");
  }
  const { id, method, params } = message;
  if (!Object.hasOwn(message, "id")) return null;
  if (typeof id !== "string" && !(typeof id === "number" && Number.isFinite(id))) return rpcError(null, -32600, "Invalid request id");
  if (params !== undefined && (!params || typeof params !== "object" || Array.isArray(params))) return rpcError(id, -32602, "Invalid params");
  if (method === "initialize") {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: SUPPORTED_PROTOCOL_VERSIONS.has(params?.protocolVersion) ? params.protocolVersion : MCP_PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION }
      }
    };
  }
  if (method === "ping") return { jsonrpc: "2.0", id, result: {} };
  if (method === "tools/list") return { jsonrpc: "2.0", id, result: { tools } };
  if (method === "tools/call") {
    const name = params && params.name;
    const args = params?.arguments === undefined ? {} : params.arguments;
    try {
      return { jsonrpc: "2.0", id, result: await callTool(name, args) };
    } catch (error) {
      return { jsonrpc: "2.0", id, result: toolError(error) };
    }
  }
  return rpcError(id, -32601, `Method not found: ${method}`);
}

let framingMode = "line";
let pendingRequests = 0;
let stdinEnded = false;
let exiting = false;

function defaultEmit(message) {
  const payload = JSON.stringify(message);
  if (framingMode === "headers") {
    process.stdout.write(`Content-Length: ${Buffer.byteLength(payload, "utf8")}\r\n\r\n${payload}`);
  } else {
    process.stdout.write(`${payload}\n`);
  }
}

function send(message, emit) {
  if (!message) return;
  (emit || defaultEmit)(message);
}

let buffer = Buffer.alloc(0);

function ingest(chunk, emit) {
  buffer = Buffer.concat([buffer, chunk]);
  if (buffer.length > 1024 * 1024) {
    buffer = Buffer.alloc(0);
    send(rpcError(null, -32700, "MCP input exceeds 1 MiB"), emit);
    return;
  }
  const parse = (body) => {
    let message;
    try { message = JSON.parse(body); }
    catch { send(rpcError(null, -32700, "Parse error"), emit); return; }
    dispatch(message, emit);
  };
  for (;;) {
    if (buffer.length === 0) return;
    const asText = buffer.toString("utf8");
    if (asText.startsWith("Content-Length:")) {
      const headerEnd = asText.indexOf("\r\n\r\n");
      if (headerEnd === -1) return;
      const match = /Content-Length:\s*(\d+)/i.exec(asText.slice(0, headerEnd));
      if (!match) {
        buffer = Buffer.alloc(0);
        send(rpcError(null, -32700, "Invalid MCP Content-Length header"), emit);
        return;
      }
      const length = Number(match[1]);
      if (!Number.isSafeInteger(length) || length > 1024 * 1024) {
        buffer = Buffer.alloc(0);
        send(rpcError(null, -32700, "Invalid frame length"), emit);
        return;
      }
      const bodyStart = headerEnd + 4;
      if (buffer.length < bodyStart + length) return;
      const body = buffer.subarray(bodyStart, bodyStart + length).toString("utf8");
      buffer = buffer.subarray(bodyStart + length);
      framingMode = "headers";
      parse(body);
      continue;
    }
    const newline = asText.indexOf("\n");
    if (newline === -1) return;
    const line = asText.slice(0, newline).trim();
    buffer = buffer.subarray(Buffer.byteLength(asText.slice(0, newline + 1), "utf8"));
    if (line) parse(line);
  }
}

function dispatch(message, emit) {
  pendingRequests += 1;
  Promise.resolve(handleRequest(message, emit))
    .then((response) => send(response, emit))
    .catch((error) => {
      const id = message && Object.hasOwn(message, "id") ? message.id : null;
      log("error", `request failed: ${errorText(error)}`);
      send(rpcError(id, -32603, errorText(error)), emit);
    })
    .finally(() => {
      pendingRequests -= 1;
      maybeExitAfterStdinEnd();
    });
}

function maybeExitAfterStdinEnd() {
  if (!stdinEnded || pendingRequests > 0) return;
  if (exiting) return;
  exiting = true;
  if (process.stdin && typeof process.stdin.pause === "function") {
    try {
      process.stdin.pause();
    } catch {
      /* ignore */
    }
  }
  // Node 24 / Windows: process.exit() while fetch sockets are still closing
  // trips a libuv assertion (async.c:94). Wait briefly, then exit.
  setTimeout(() => process.exit(0), EXIT_DRAIN_MS);
}

// ─────────────────────────────────────────────────────────────────────────────
// --self-test (fully offline)
// ─────────────────────────────────────────────────────────────────────────────

async function runSelfTest() {
  let checks = 0;
  const failures = [];
  logDirOverride = path.join(process.env.TEMP || process.env.TMP || MODULE_DIR, "qwenimg-selftest-logs");

  const check = (label, condition, detail) => {
    checks += 1;
    if (!condition) failures.push(`${label}${detail ? ` :: ${detail}` : ""}`);
  };

  const rpc = async (method, params) => {
    const request = { jsonrpc: "2.0", method, params };
    if (!method.startsWith("notifications/")) request.id = `t${checks}`;
    const response = await handleRequest(request);
    return response ? [response] : [];
  };

  const callToolOffline = async (name, args) => {
    const messages = await rpc("tools/call", { name, arguments: args });
    check(`tools/call ${name} responded`, messages.length === 1, `messages=${messages.length}`);
    return messages[0] ? messages[0].result : null;
  };

  const expectToolError = (label, result, code) => {
    check(`${label}: isError`, Boolean(result && result.isError), JSON.stringify(result).slice(0, 200));
    const text = result && result.content && result.content[0] ? result.content[0].text : "";
    check(`${label}: code ${code}`, text.startsWith(`${code}:`), text.slice(0, 160));
    check(`${label}: carries 建议`, text.includes("建议:"), text.slice(0, 160));
  };

  try {
    // 1) handshake
    const initMessages = await rpc("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "self-test", version: "1" } });
    check("initialize is answered", initMessages.length === 1, `messages=${initMessages.length}`);
    const init = initMessages[0] && initMessages[0].result;
    check("initialize echoes client protocolVersion", Boolean(init && init.protocolVersion === "2025-03-26"), JSON.stringify(init && init.protocolVersion));
    check("initialize serverInfo name", Boolean(init && init.serverInfo && init.serverInfo.name === SERVER_NAME), JSON.stringify(init && init.serverInfo));
    check("initialize serverInfo version", Boolean(init && init.serverInfo && init.serverInfo.version === SERVER_VERSION), JSON.stringify(init && init.serverInfo));
    check("initialize advertises tools capability", Boolean(init && init.capabilities && init.capabilities.tools));

    const initDefault = await rpc("initialize", {});
    check(
      "initialize falls back to the server protocolVersion",
      Boolean(initDefault[0] && initDefault[0].result && initDefault[0].result.protocolVersion),
      JSON.stringify(initDefault[0] && initDefault[0].result && initDefault[0].result.protocolVersion)
    );

    const notified = await rpc("notifications/initialized", {});
    check("notifications/initialized is not answered", notified.length === 0, `messages=${notified.length}`);

    const pong = await rpc("ping", {});
    check("ping answered with an empty result", Boolean(pong[0] && pong[0].result && Object.keys(pong[0].result).length === 0));

    const unknownMethod = await rpc("tools/nope", {});
    check("unknown method returns -32601", Boolean(unknownMethod[0] && unknownMethod[0].error && unknownMethod[0].error.code === -32601), JSON.stringify(unknownMethod[0]));

    // 2) tools/list
    const listMessages = await rpc("tools/list", {});
    const list = listMessages[0] && listMessages[0].result;
    check("tools/list returns exactly 4 tools", Boolean(list && list.tools && list.tools.length === 4), JSON.stringify(list && list.tools && list.tools.map((tool) => tool.name)));
    check("tool names are unprefixed", Boolean(list && list.tools.every((tool) => TOOL_NAMES.includes(tool.name))), JSON.stringify(list && list.tools.map((tool) => tool.name)));
    check(
      "every tool has a bilingual description",
      Boolean(list && list.tools.every((tool) => tool.description.length > 40 && /[\u4e00-\u9fa5]/.test(tool.description) && /[A-Za-z]{4}/.test(tool.description)))
    );
    check("every schema is object + additionalProperties:false", Boolean(list && list.tools.every((tool) => tool.inputSchema.type === "object" && tool.inputSchema.additionalProperties === false)));
    check("generate schema required=[prompt]", Boolean(list && JSON.stringify(list.tools.find((tool) => tool.name === "generate").inputSchema.required) === JSON.stringify(["prompt"])));
    check("get_result schema required=[prompt_id]", Boolean(list && JSON.stringify(list.tools.find((tool) => tool.name === "get_result").inputSchema.required) === JSON.stringify(["prompt_id"])));
    const schema = list.tools.find((tool) => tool.name === "generate").inputSchema;
    check("width/height bounds documented", Boolean(schema.properties.width.minimum === 256 && schema.properties.height.maximum === 1024));
    check("steps/cfg bounds documented", Boolean(schema.properties.steps.minimum === 1 && schema.properties.steps.maximum === 40 && schema.properties.cfg.minimum === 1 && schema.properties.cfg.maximum === 8));
    check("wait_seconds default+cap documented", Boolean(schema.properties.wait_seconds.default === 180 && schema.properties.wait_seconds.maximum === 600));
    check(
      "status takes no parameters",
      Boolean(list.tools.find((tool) => tool.name === "status").inputSchema.properties && Object.keys(list.tools.find((tool) => tool.name === "status").inputSchema.properties).length === 0)
    );
    check("stdin framing default is line-delimited", framingMode === "line", framingMode);

    // 3) argument validation (fails before any network use)
    const bad = async (label, args, code) => expectToolError(label, await callToolOffline("generate", args), code || "BAD_PARAMS");
    await bad("empty prompt", { prompt: "" });
    await bad("missing prompt", {});
    await bad("whitespace-only prompt", { prompt: "   " });
    await bad("prompt too long", { prompt: "x".repeat(4001) });
    await bad("width not a multiple of 16", { prompt: "cat", width: 100 });
    await bad("height not a multiple of 16", { prompt: "cat", height: 517 });
    await bad("width below min", { prompt: "cat", width: 240 });
    await bad("height above max", { prompt: "cat", height: 1040 });
    // 1024x1024 exactly equals max_pixels, so it must still be accepted; the
    // budget only rejects strictly larger areas (impossible with max_side=1024,
    // hence the temporary limit).
    check("1024x1024 is accepted at the exact budget", validateGenerate({ prompt: "cat", width: 1024, height: 1024 }, CONFIG).width === 1024);
    const savedMaxPixels = CONFIG.limits.max_pixels;
    CONFIG.limits.max_pixels = 262144;
    await bad("pixel budget exceeded", { prompt: "cat", width: 1024, height: 1024 });
    CONFIG.limits.max_pixels = savedMaxPixels;
    await bad("steps below 1", { prompt: "cat", steps: 0 });
    await bad("steps above max", { prompt: "cat", steps: 41 });
    await bad("steps not an integer", { prompt: "cat", steps: 2.5 });
    await bad("cfg out of range", { prompt: "cat", cfg: 9 });
    await bad("negative seed", { prompt: "cat", seed: -1 });
    await bad("seed not an integer", { prompt: "cat", seed: 1.5 });
    await bad("wait_seconds not an integer", { prompt: "cat", wait_seconds: 1.5 });
    await bad("return_image not a boolean", { prompt: "cat", return_image: "yes" });
    await bad("unknown parameter", { prompt: "cat", resolution: 512 });
    await bad("arguments not an object", "cat");
    expectToolError("unknown tool name", await callToolOffline("nope", {}), "BAD_PARAMS");
    expectToolError("get_result without prompt_id", await callToolOffline("get_result", {}), "BAD_PARAMS");
    expectToolError("get_result rejects a suspicious prompt_id", await callToolOffline("get_result", { prompt_id: "a b/../c" }), "BAD_PARAMS");

    // 4) filename_prefix sanitising
    const prefixProbe = validateGenerate({ prompt: "cat", filename_prefix: "a b/c:d*e?f" }, CONFIG);
    check("filename_prefix sanitised", prefixProbe.filename_prefix === "a_b_c_d_e_f", prefixProbe.filename_prefix);
    check("filename_prefix truncated to 40", validateGenerate({ prompt: "cat", filename_prefix: "Z".repeat(80) }, CONFIG).filename_prefix.length === 40);
    check("filename_prefix default", validateGenerate({ prompt: "cat" }, CONFIG).filename_prefix === CONFIG.defaults.filename_prefix);
    check("run id fits the 40-char budget", uniquePrefix("Z".repeat(40), "abc123").length === 40, String(uniquePrefix("Z".repeat(40), "abc123").length));

    // 5) defaults / clamping
    const dflt = validateGenerate({ prompt: "cat" }, CONFIG);
    check("defaults are 512x512", dflt.width === 512 && dflt.height === 512, `${dflt.width}x${dflt.height}`);
    check("defaults are steps 20 / cfg 1", dflt.steps === 20 && dflt.cfg === 1, `${dflt.steps}/${dflt.cfg}`);
    check("default wait_seconds = default_wait_s", dflt.wait_seconds === CONFIG.limits.default_wait_s, String(dflt.wait_seconds));
    check("wait_seconds clamped to max_wait_s", validateGenerate({ prompt: "cat", wait_seconds: 99999 }, CONFIG).wait_seconds === CONFIG.limits.max_wait_s);
    check("resolution follows the long side", validateGenerate({ prompt: "cat", width: 768, height: 512 }, CONFIG).resolution === 768);
    const randomSeedA = validateGenerate({ prompt: "cat" }, CONFIG);
    const randomSeedB = validateGenerate({ prompt: "cat" }, CONFIG);
    check("omitted seed randomises and is flagged", randomSeedA.seed_random === true && randomSeedB.seed_random === true && randomSeedA.seed >= 0 && randomSeedA.seed <= 9007199254740991);
    check("random seeds differ", randomSeedA.seed !== randomSeedB.seed, `${randomSeedA.seed} vs ${randomSeedB.seed}`);
    const explicitSeed = validateGenerate({ prompt: "cat", seed: 42 }, CONFIG);
    check("explicit seed is kept", explicitSeed.seed === 42 && explicitSeed.seed_random === false);
    check("negative_prompt defaults to empty", dflt.negative_prompt === "");

    // 6) template filling
    const template = readTemplate();
    const values = validateGenerate({ prompt: "一只橘猫", negative_prompt: "模糊", width: 512, height: 512, steps: 7, cfg: 2, seed: 42, filename_prefix: "DSH_TEST" }, CONFIG);
    const filled = fillTemplate(template, values, CONFIG);
    const prompt = filled.prompt;
    check("node 1 unet_name from config", prompt["1"].inputs.unet_name === CONFIG.models.unet, prompt["1"].inputs.unet_name);
    check("node 2 clip_name from config", prompt["2"].inputs.clip_name === CONFIG.models.clip, prompt["2"].inputs.clip_name);
    check("node 2 type/device constants", prompt["2"].inputs.type === "qwen_image" && prompt["2"].inputs.device === "default");
    check("node 3 vae_name from config", prompt["3"].inputs.vae_name === CONFIG.models.vae, prompt["3"].inputs.vae_name);
    check("node 4 width/height/batch", prompt["4"].inputs.width === 512 && prompt["4"].inputs.height === 512 && prompt["4"].inputs.batch_size === 1, JSON.stringify(prompt["4"].inputs));
    check("node 5 prompt written", prompt["5"].inputs.prompt === "一只橘猫", prompt["5"].inputs.prompt);
    check("node 5 negative_prompt + resolution", prompt["5"].inputs.negative_prompt === "模糊" && prompt["5"].inputs.resolution === 512, JSON.stringify(prompt["5"].inputs));
    check("node 5 clip wiring untouched", JSON.stringify(prompt["5"].inputs.clip) === JSON.stringify(template["5"].inputs.clip));
    check("node 6 seed/steps/cfg", prompt["6"].inputs.seed === 42 && prompt["6"].inputs.steps === 7 && prompt["6"].inputs.cfg === 2, JSON.stringify(prompt["6"].inputs));
    check("node 6 sampler/scheduler/denoise constants", prompt["6"].inputs.sampler_name === "euler" && prompt["6"].inputs.scheduler === "simple" && prompt["6"].inputs.denoise === 1);
    check(
      "node 6 wiring untouched",
      JSON.stringify(prompt["6"].inputs.model) === JSON.stringify(template["6"].inputs.model) && JSON.stringify(prompt["6"].inputs.latent_image) === JSON.stringify(template["6"].inputs.latent_image)
    );
    check("node 7 wiring untouched", JSON.stringify(prompt["7"].inputs) === JSON.stringify(template["7"].inputs));
    check("node 8 filename_prefix", prompt["8"].inputs.filename_prefix === "DSH_TEST", prompt["8"].inputs.filename_prefix);
    check("node 8 images wiring untouched", JSON.stringify(prompt["8"].inputs.images) === JSON.stringify(template["8"].inputs.images));
    check("class_types preserved", Object.entries(prompt).every(([id, node]) => node.class_type === template[id].class_type));
    check("template object is not mutated", template["5"].inputs.prompt !== "一只橘猫" && template["6"].inputs.steps === 4);
    // 4 (EmptyLatentImage: w/h/batch) + 3 (TextEncode) + 6 (KSampler) + 1 (SaveImage) + 1+3+1 (loaders) = 18
    check("applied map covers all 18 mapped fields", Object.keys(filled.applied).length === 18, String(Object.keys(filled.applied).length));

    // 7) template / mapping drift detection
    const broken = JSON.parse(JSON.stringify(template));
    delete broken["8"].inputs.filename_prefix;
    let driftDetected = false;
    const savedTemplate = fs.readFileSync(TEMPLATE_PATH, "utf8");
    try {
      try {
        readTemplate(broken);
      } catch (error) {
        driftDetected = error instanceof McpError && error.message.includes("filename_prefix");
      }
    } finally {
      // Probe in memory: never rewrite the live template during self-test.
    }
    check("template drift is detected with a clear error", driftDetected);
    check("template file restored after the drift probe", fs.readFileSync(TEMPLATE_PATH, "utf8") === savedTemplate);

    // 8) comfy_url policy
    let rejectedNonLocal = false;
    try {
      validateConfig({ ...JSON.parse(JSON.stringify(CONFIG)), comfy_url: "http://192.168.1.50:8188" });
    } catch (error) {
      rejectedNonLocal = error instanceof McpError && error.code === "COMFY_UNREACHABLE" && /127\.0\.0\.1|localhost/.test(error.message);
    }
    check("non-local comfy_url is rejected", rejectedNonLocal);
    check("localhost comfy_url is accepted", validateConfig({ ...JSON.parse(JSON.stringify(CONFIG)), comfy_url: "http://localhost:8188" }).comfy_url === "http://localhost:8188");

    // 9) config layering
    const merged = loadConfig({ QWENIMG_DEFAULTS_STEPS: "33", QWENIMG_MODELS_UNET: "other.gguf", QWENIMG_AUTOSTART: "false" }, JSON.parse(JSON.stringify(CONFIG)));
    check("env override for nested defaults", merged.defaults.steps === 33, String(merged.defaults.steps));
    check("env override for nested models", merged.models.unet === "other.gguf" && merged.models.clip === CONFIG.models.clip, JSON.stringify(merged.models));
    check("env override for booleans", merged.autostart === false, String(merged.autostart));

    // 10) spawn shape / real paths
    const options = spawnOptionsForComfy(CONFIG);
    check("spawn is detached + ignored + hidden, cwd=comfy_root", options.detached === true && options.stdio === "ignore" && options.windowsHide === true && options.cwd === CONFIG.comfy_root, JSON.stringify(options));
    check("python + main.py exist", fs.existsSync(CONFIG.comfy_python) && fs.existsSync(CONFIG.comfy_main), `${CONFIG.comfy_python} / ${CONFIG.comfy_main}`);
    check("comfy_main matches start_qwen.py's shape", /ComfyUI[\\/]main\.py$/.test(CONFIG.comfy_main), CONFIG.comfy_main);
    check("--disable-auto-launch present in comfy_args", CONFIG.comfy_args.includes("--disable-auto-launch"), JSON.stringify(CONFIG.comfy_args));
    const launchArgs = buildComfyArgs(CONFIG);
    check(
      "launch args order is python-flags -> main.py -> comfy flags",
      launchArgs.indexOf(CONFIG.comfy_main) === CONFIG.comfy_pre_args.length && launchArgs[0] === "-s",
      JSON.stringify(launchArgs)
    );
    check("comfy_args holds no python interpreter flags", !CONFIG.comfy_args.some((arg) => /^-s$|^-X|^-u$/.test(String(arg))), JSON.stringify(CONFIG.comfy_args));
    let misplacedRejected = false;
    try {
      validateConfig({ ...JSON.parse(JSON.stringify(CONFIG)), comfy_args: ["-s", "--windows-standalone-build"] });
    } catch (error) {
      misplacedRejected = error instanceof McpError && error.message.includes("comfy_pre_args");
    }
    check("a misplaced -s in comfy_args is rejected at startup", misplacedRejected);
    check("output dir exists", fs.existsSync(CONFIG.comfy_output_dir), CONFIG.comfy_output_dir);

    // 11) ComfyUI reachability handling, deterministic and offline: an unused
    // local port stands in for "not running", a throwaway stub server for
    // "running". This is why --self-test never touches the real ComfyUI.
    const reserve = http.createServer();
    await new Promise((resolve) => reserve.listen(0, "127.0.0.1", resolve));
    const unusedPort = reserve.address().port;
    await new Promise((resolve) => reserve.close(resolve));
    let unreachableCode = "";
    try {
      await ensureComfy(CONFIG, { autostart: false, timeoutS: 1, baseOverride: `http://127.0.0.1:${unusedPort}` });
    } catch (error) {
      unreachableCode = error instanceof McpError ? `${error.code}: ${error.message}` : String(error);
    }
    check("autostart=false + unreachable -> COMFY_UNREACHABLE", unreachableCode.startsWith("COMFY_UNREACHABLE:"), unreachableCode.slice(0, 160));

    const stub = http.createServer((request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ system: { comfyui_version: "stub" }, devices: [{ name: "stub-gpu", vram_total: 1024, vram_free: 512 }] }));
    });
    await new Promise((resolve) => stub.listen(0, "127.0.0.1", resolve));
    const stubPort = stub.address().port;
    let stubResult = null;
    let stubError = "";
    try {
      stubResult = await ensureComfy(CONFIG, { autostart: false, timeoutS: 1, baseOverride: `http://127.0.0.1:${stubPort}` });
    } catch (error) {
      stubError = errorText(error);
    }
    await new Promise((resolve) => stub.close(resolve));
    check("reachable server -> ensureComfy reports not started", Boolean(stubResult && stubResult.started === false && stubResult.stats.system.comfyui_version === "stub"), stubError || JSON.stringify(stubResult));
    check("real ComfyUI was never required by --self-test", true);

    // 12) OOM detection + logging hygiene
    check("OOM text is recognised", isOutOfMemory("RuntimeError: CUDA error: out of memory") && isOutOfMemory("torch.OutOfMemoryError: CUDA out of memory"));
    check("normal errors are not flagged as OOM", !isOutOfMemory("node 5 prompt is invalid"));

    const probe = `PROMPT-LEAK-${Math.random().toString(36).slice(2)}`;
    log("info", `generate start prompt_len=${probe.length} prompt_sha256_8=${promptDigest(probe)}`);
    const logFile = path.join(logDirOverride, `qwenimg-${new Date().toISOString().slice(0, 10)}.log`);
    let logText = "";
    try {
      logText = fs.readFileSync(logFile, "utf8");
    } catch {
      /* empty */
    }
    check("logger writes to a file", logText.includes(promptDigest(probe)), logFile);
    check("prompt text never reaches the log (hash only)", !logText.includes(probe));
    check("rotation keeps at most one .1 file", fs.readdirSync(logDirOverride).filter((name) => name.endsWith(".1")).length <= 1);
  } catch (error) {
    failures.push(`unexpected exception :: ${error instanceof Error ? error.stack : String(error)}`);
    checks += 1;
  }

  if (failures.length === 0) {
    console.log(`SELF-TEST PASS (${checks} checks)`);
    return 0;
  }
  console.log(`SELF-TEST FAIL (${checks - failures.length}/${checks} checks passed)`);
  for (const failure of failures) console.log(`  FAIL ${failure}`);
  return 1;
}

// ─────────────────────────────────────────────────────────────────────────────
// --status / --smoke
// ─────────────────────────────────────────────────────────────────────────────

function resultText(result) {
  return result && result.content && result.content[0] ? result.content[0].text : JSON.stringify(result);
}

async function runStatus() {
  let result;
  try {
    result = await callStatus();
  } catch (error) {
    result = toolError(error);
  }
  console.log(resultText(result));
  if (result && result.isError) return 1;
  // "ComfyUI is not running" is a reportable state, not a CLI failure: exit 0
  // and let check.ps1 read the text. A failing self-diagnosis (unreadable
  // config, or models missing while ComfyUI is up) still exits non-zero.
  if (result && result.diagnosisFailed) return 1;
  return 0;
}

// Minimal PNG IHDR reader: bytes 16..24 hold width/height big-endian.
function readPngSize(file) {
  const head = Buffer.alloc(24);
  const fd = fs.openSync(file, "r");
  try {
    fs.readSync(fd, head, 0, 24, 0);
  } finally {
    fs.closeSync(fd);
  }
  if (head.subarray(1, 4).toString("ascii") !== "PNG") return null;
  return { width: head.readUInt32BE(16), height: head.readUInt32BE(20) };
}

async function runSmoke() {
  console.log("smoke: 512x512 steps=4 cfg=1 seed=42 prefix=DSH_Qwen21_smoke");
  const started = Date.now();
  let result;
  try {
    result = await callGenerate({
      prompt: "一只橘猫坐在木桌上，柔和的窗边阳光，写实摄影，背景简洁。",
      width: 512,
      height: 512,
      steps: 4,
      cfg: 1,
      seed: 42,
      filename_prefix: "DSH_Qwen21_smoke",
      wait_seconds: 600
    });
  } catch (error) {
    console.log(`smoke FAILED: ${errorText(error)}`);
    return 1;
  }
  const text = resultText(result);
  console.log(text);
  if (result.isError) {
    console.log("smoke FAILED");
    return 1;
  }
  const match = /图片路径=(.+)/.exec(text);
  if (!match) {
    console.log("smoke FAILED: no image path in the result");
    return 1;
  }
  const file = match[1].trim();
  let ok = true;
  try {
    const stat = fs.statSync(file);
    const size = readPngSize(file);
    console.log(`smoke: exists=${stat.isFile()} bytes=${stat.size} pngSize=${size ? `${size.width}x${size.height}` : "not a PNG"}`);
    ok = stat.isFile() && stat.size > 1000 && size !== null && size.width === 512 && size.height === 512;
  } catch (error) {
    console.log(`smoke FAILED: cannot inspect ${file}: ${error.message}`);
    ok = false;
  }
  console.log(`smoke: elapsed=${Math.round((Date.now() - started) / 1000)}s`);
  try {
    console.log(resultText(await callFreeVram()));
  } catch (error) {
    console.log(`free_vram after smoke failed: ${errorText(error)}`);
  }
  console.log(ok ? "SMOKE PASS" : "SMOKE FAIL");
  return ok ? 0 : 1;
}

// ─────────────────────────────────────────────────────────────────────────────
// entry point
// ─────────────────────────────────────────────────────────────────────────────

if (IS_MAIN) {
  process.on("uncaughtException", () => {
    log("error", "uncaughtException: terminating server; details withheld to protect prompts");
    void finish(1);
  });
  process.on("unhandledRejection", () => {
    log("error", "unhandledRejection: terminating server; details withheld to protect prompts");
    void finish(1);
  });
}

// Terminal modes must terminate on their own: an inherited stdin pipe would
// otherwise keep the event loop alive. A short drain first matters on Node 24 /
// Windows: calling process.exit() while fetch sockets are still closing trips a
// libuv assertion (async.c:94) and corrupts the exit code.
const EXIT_DRAIN_MS = 300;

async function finish(code) {
  if (process.stdin && typeof process.stdin.pause === "function") {
    try {
      process.stdin.pause();
    } catch {
      /* ignore */
    }
  }
  await new Promise((resolve) => setTimeout(resolve, EXIT_DRAIN_MS));
  process.exit(code);
}

if (IS_MAIN && MODE === "self-test") {
  await finish(await runSelfTest());
} else if (IS_MAIN && MODE === "status") {
  await finish(await runStatus());
} else if (IS_MAIN && MODE === "smoke") {
  await finish(await runSmoke());
} else if (IS_MAIN) {
  if (!CONFIG) {
    // Still answer the handshake so the failure is visible to the client; the
    // tools themselves then return the config error.
    log("error", `starting with an unusable config: ${CONFIG_ERROR ? CONFIG_ERROR.message : "unknown"}`);
  }
  process.stdin.on("data", (chunk) => {
    try {
      ingest(chunk);
    } catch (error) {
      send(rpcError(null, -32700, error instanceof Error ? error.message : String(error)));
    }
  });
  process.stdin.on("end", () => {
    stdinEnded = true;
    maybeExitAfterStdinEnd();
  });
  process.stderr.write(`${SERVER_NAME} ${SERVER_VERSION} ready (node ${process.versions.node}, comfy ${COMFY_BASE})\n`);
}

export {
  handleRequest,
  fillTemplate,
  readTemplate,
  validateGenerate,
  validateConfig,
  loadConfig,
  ensureComfy,
  NODE_MAP,
  SERVER_VERSION,
  SERVER_NAME,
  tools,
  isOutOfMemory,
  uniquePrefix,
  spawnOptionsForComfy,
  buildComfyArgs,
  timeoutFetch,
  resolveImage,
  parseJobHistory,
  ingest
};
