// Opt-in end-to-end test through MCP stdio. Generates ONE 512x512 image.
// Usage: node scripts/live-test.mjs --generate
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
if (!process.argv.includes("--generate")) {
  console.log("This test generates one image. Run with --generate to opt in.");
  process.exit(0);
}
const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const child = spawn(process.execPath, [path.join(project, "server.mjs")], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
const exited = once(child, "exit");
let nextId = 1, buffer = "", stderr = "";
const pending = new Map();
child.stderr.on("data", (chunk) => { stderr = (stderr + chunk.toString()).slice(-10000); });
child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  buffer += chunk;
  for (;;) {
    const newline = buffer.indexOf("\n"); if (newline < 0) return;
    const message = JSON.parse(buffer.slice(0,newline)); buffer = buffer.slice(newline+1);
    const request = pending.get(message.id);
    if (request) { clearTimeout(request.timer); pending.delete(message.id); request.resolve(message); }
  }
});
function rpc(method, params) {
  const id = nextId++;
  return new Promise((resolve,reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`MCP request timeout: ${method}\n${stderr}`)); }, 240000);
    pending.set(id,{resolve,reject,timer});
    child.stdin.write(JSON.stringify({jsonrpc:"2.0",id,method,params})+"\n");
  });
}
const tool = async (name,args={}) => {
  const response = await rpc("tools/call",{name,arguments:args});
  assert.ok(response.result, JSON.stringify(response.error));
  assert.ok(!response.result.isError,response.result.content?.[0]?.text);
  return response.result;
};
const text = (result) => result.content[0].text;
const start = Date.now();
try {
  const initialization = await rpc("initialize",{protocolVersion:"2025-06-18",capabilities:{},clientInfo:{name:"qwenimg-live-test",version:"1.1.1"}});
  child.stdin.write(JSON.stringify({jsonrpc:"2.0",method:"notifications/initialized"})+"\n");
  let result = await tool("generate",{
    prompt:"一只橘猫坐在木桌上，柔和的窗边阳光，写实摄影，背景简洁。",
    width:512,height:512,steps:20,cfg:1,seed:42,filename_prefix:"DSH_Qwen21_review",wait_seconds:1,return_image:true
  });
  console.log(text(result));
  const promptId = /prompt_id=([^\s]+)/.exec(text(result))?.[1]; assert.ok(promptId);
  while (!text(result).includes("status=ok")) {
    assert.ok(Date.now()-start<240000,"image did not finish within four minutes");
    await new Promise((resolve)=>setTimeout(resolve,2000));
    result=await tool("get_result",{prompt_id:promptId,return_image:true});
  }
  const file = /图片路径=(.+)/.exec(text(result))?.[1]?.trim(); assert.ok(file);
  const image=fs.readFileSync(file);
  assert.equal(image.readUInt32BE(16),512); assert.equal(image.readUInt32BE(20),512);
  assert.ok(result.content.some((item)=>item.type==="image"),"image content block missing");
  assert.equal(result.content.find((item)=>item.type==="image").data,image.toString("base64"));
  console.log(text(result));
  console.log(text(await tool("status")));
  console.log(text(await tool("free_vram")));
  const date = new Intl.DateTimeFormat("en-CA", {timeZone:"Asia/Shanghai",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date());
  const record={date,serverVersion:initialization.result.serverInfo.version,promptId,file,width:512,height:512,steps:20,seed:42,seconds:Math.round((Date.now()-start)/1000),mcpStdio:true,imageContent:true,dshUiVerified:false};
  fs.writeFileSync(path.join(project,"state/review-live-test.json"),JSON.stringify(record,null,2)+"\n");
  console.log("MCP LIVE TEST PASS");
} finally {
  for (const request of pending.values()) clearTimeout(request.timer);
  child.stdin.end();
  const killer=setTimeout(()=>child.kill(),2000);
  await exited;clearTimeout(killer);
}
