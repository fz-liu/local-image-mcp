# Local Image MCP

独立社区维护的本机 ComfyUI MCP 桥接工具，服务版本 **1.1.2**。当前测试模型为 Qwen-Image 2.1，可通过标准 stdio MCP 宿主调用；附带一个社区 DSH profile 的注册示例。

**AI 辅助编写说明：代码主要由 AI 辅助生成、修改、检查并进行自动化测试。** 本项目不是 Qwen、ComfyUI 或 DeepSeek 官方产品，没有获得其赞助或背书。

## 许可和使用范围

桥接代码按 [MIT](LICENSE) 提供，参考/改编来源及第三方许可见 [NOTICE](NOTICE.md)。本仓库不分发模型、第三方程序、logo 或角色素材。

**Qwen-Image 2.1 模型使用研究许可，非商用限定为研究或评估，商业使用需另行授权。** 本项目的 MIT 许可不会授予模型商业使用权。请先阅读 [官方模型许可](https://huggingface.co/Qwen/Qwen-Image-2.1/blob/main/LICENSE)和[公开发布自查](LEGAL.md)。本项目没有给所有生成内容作合法性或权属保证。

本机配置为 RTX 4060 Laptop 8GB、Qwen-Image 2.1 Q4_K 主体、W4A8 编码器、专用 BF16 VAE。服务使用 Node 内置模块，通过 stdio MCP 调用本机 ComfyUI。模型、ComfyUI 主程序和既有 DSH 插件文件保持原配置。

**当前状态：MCP 独立调用已经实际出图，注册补丁尚未应用，DSH 聊天界面内仍待验证。** 原方案采用用户手动注册，这次保留这一流程。审查详情见 [REVIEW.md](REVIEW.md)。

## 从 GitHub 下载后开始使用

本仓库保存源代码、配置示例与测试，不包含本机配置、日志、状态、模型或生成图片。已有的本机 `config.json` 不受影响。

新电脑或新目录需要先安装 ComfyUI 与模型，再在项目目录中执行：

```powershell
Copy-Item config.example.json config.json
```

修改 `config.json` 中的 ComfyUI 路径、模型文件名和输出目录。示例采用 E 盘安装位置；按实际安装调整。需要 Node ≥22 和 Windows PowerShell，服务本身零依赖，无需 npm install。

`cordis.patch.example.yml` 是通用注册模板。没有本机 `cordis.patch.snippet.yml` 时，安装器与体检会自动使用模板并填入当前目录的 `server.mjs` 绝对路径；目标用户目录来自 USERPROFILE，不再依赖 Administrator 用户名。若本机已有 snippet，它优先使用，移动项目后需同步修改其中 args。

随后按下文注册。PowerShell 命令里的本机项目路径要换成你下载到的实际目录。也可以在项目目录使用 `powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install-patch.ps1 -Apply`。

## 使用的四个工具

| 工具 | 作用 |
| --- | --- |
| `mcp__qwenimg__generate` | 根据提示词生成单张图片，返回实际路径或任务 ID |
| `mcp__qwenimg__get_result` | 用已有任务 ID 查状态、取回路径，可带 `return_image=true` 返回 PNG 内容 |
| `mcp__qwenimg__status` | 只读检查版本、显存、队列、模型列表与节点，不自动启动 ComfyUI |
| `mcp__qwenimg__free_vram` | 空闲时请求卸载模型；队列有任务时返回 BUSY，不停止服务 |

`generate` 的参数：

| 参数 | 默认 / 本次限制 |
| --- | --- |
| `prompt` | 必填，非空字符串，最多 4000 字符 |
| `negative_prompt` | 空字符串，最多 4000 字符 |
| `width`、`height` | 512；每边 256..1024，16 的倍数，面积≤1048576 |
| `steps` | 20；1..40 |
| `cfg` | 1；1..8 |
| `seed` | 省略则随机，实际值在返回结果中；可指定 0..2^53-1 整数 |
| `filename_prefix` | DSH_Qwen21；非法字符替换为下划线、截取 40 字符，并追加运行 ID |
| `wait_seconds` | 180；正整数，最多按配置的 600 秒等待；不含启动服务所用时间 |
| `return_image` | false；true 且图片≤2MiB 时额外返回 PNG 内容块 |

超时通常返回 `status=queued` 或 `running` 和 `prompt_id`。**不要因此重复调用 generate**，改用 `get_result` 查询原任务。`unknown` 表示历史和队列都没找到：可能 ID 错误、历史已清除、服务重启或短暂状态变化，先检查输出目录。

任务提交后，如果查询或取图失败，错误也会保留 `prompt_id`，供继续查询。已结束但没有保存图片、执行错误或中断，都会明确返回失败。

## 文件和配置

| 文件 | 作用 |
| --- | --- |
| `server.mjs` | 零依赖服务，Node ≥22 |
| `config.example.json` / 本机 `config.json` | 配置示例 / 实际 ComfyUI 路径、模型、启动参数和默认值 |
| `workflow_api.template.json` | 已验证的八节点 API 工作流；不是界面导入 JSON |
| `cordis.patch.example.yml` / 本机 `cordis.patch.snippet.yml` | 通用注册模板 / 可选的本机注册块副本 |
| `scripts/install-patch.ps1` | 默认预览；-Apply 写入；-Remove -Apply 移除管理块 |
| `scripts/check.ps1` | 环境检查；-Live 联机；-Live -Record 保存环境快照 |
| `scripts/mcp-client-test.mjs` | 原有 34 项真实 stdio 客户端测试 |
| `scripts/regression-test.mjs` | 30 项回归测试，使用模拟服务和临时配置文件 |
| `scripts/live-test.mjs` | 显式带 --generate 才会实际生成一张 512×512、20 步图片 |
| `state`、`logs` | PID、检查与实测记录、单份滚动补丁备份、日志 |

工作流：GGUF 加载器 → 文字编码 → KSampler(euler/simple) → 专用 VAE 解码 → SaveImage。配置的三个文件名分别为：

- `qwen_image_2.1-Q4_K.gguf`
- `qwen3vl_8b_w4a8.safetensors`
- `qwen_image_2.1_vae_bf16.safetensors`

ComfyUI 根目录：`E:\ComfyUI\ComfyUI_windows_portable`。
本机地址：`http://127.0.0.1:8188`。
输出目录：`E:\ComfyUI\ComfyUI_windows_portable\ComfyUI\output`。

`comfy_pre_args` 放 Python 参数（本次为 `-s`），写在 main.py 之前；`comfy_args` 放 ComfyUI 参数：`--windows-standalone-build --reserve-vram 1 --disable-auto-launch`。
`generate` 可以自动启动隐藏的 ComfyUI 进程；同一 MCP 进程内的并发调用共享一次启动。MCP 退出后 ComfyUI 继续运行。

环境变量可覆盖配置，例如 `QWENIMG_MODELS_UNET`、`QWENIMG_DEFAULTS_STEPS`；数组字段须使用 JSON 数组字符串，例如 `QWENIMG_COMFY_PRE_ARGS=["-s"]`。补丁不设置额外环境覆盖。修改配置后重启 MCP/DSH。

## 注册到鲸鱼娘 DSH

1. 正常退出 DSH。
2. 打开 PowerShell，先预览：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File 'E:\aiworkplace\codexworkplace\dsh\qwen-image-mcp\scripts\install-patch.ps1'
```

3. 应用：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File 'E:\aiworkplace\codexworkplace\dsh\qwen-image-mcp\scripts\install-patch.ps1' -Apply
```

4. 双击桌面“DSH 鲸鱼娘”，让模型先调用 `mcp__qwenimg__status`，再生成一张 512×512 图片。超时后的同一任务应调用 `get_result`。

注册目标是当前用户的 `%USERPROFILE%\.dsh-pack-better\profiles\desktop\cordis.patch.yml`。该 profile 名称与工具命名仅用于兼容性配置；本项目不分发宿主程序或社区桌面素材。
注册块使用 `command: !!js process.execPath`、`transport: stdio`、服务名 `qwenimg`、调用超时 **900000 毫秒**。等待预算覆盖最多 180 秒启动、600 秒取图等待和 HTTP 操作。当前宿主的内置 Node 为 24.18.1，已单独验证。

脚本保留块外字节、BOM、混合换行和原有块位置，拒绝重复/残缺标记及手写 ID 冲突；写前备份一份，使用同目录临时文件原子替换并自校验。原文件不以换行结尾时，新块放到文件开头，以便移除后精确恢复原字节。

回退只移除管理块：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File 'E:\aiworkplace\codexworkplace\dsh\qwen-image-mcp\scripts\install-patch.ps1' -Remove -Apply
```

## 检查与测试

在本项目目录中执行：

```powershell
& 'E:\nodejs\node.exe' server.mjs --self-test
& 'E:\nodejs\node.exe' scripts\mcp-client-test.mjs
& 'E:\nodejs\node.exe' --test scripts\regression-test.mjs
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\check.ps1 -Live -Record
```

前三项分别通过 162 项、34 项和 30 项。回归测试只使用本机模拟 HTTP 服务与临时文件，未调用真实 ComfyUI；安装脚本的写入测试指向临时副本。

实际出图测试必须显式执行，会消耗显卡资源，并在结束时请求释放模型：

```powershell
& 'E:\nodejs\node.exe' scripts\live-test.mjs --generate
```

本次经真实 MCP stdio 完成自动启动、generate 短等待、get_result 取回图片与内容、status 和 free_vram，512×512、20 步成功，整轮约 43 秒（含冷启动及检查，不是纯采样时间）。见 `state/review-live-test.json`。

之前的单次记录：768×768 冷启动约 60 秒，1024×1024 已加载约 80 秒。更长连续任务与 DSH 界面内工具调用仍待验证；这些耗时不保证每次相同。
`check.ps1 -Record` 保存的是环境核对，`dshToolsVerified=false`；**不把检查通过当成 DSH 内实测通过**。

## 升级与排错

- 工具不出现：先检查管理块和项目路径。退出 DSH 后重新预览/应用补丁。
- 宿主更新：check.ps1 会检查内置 Node、启动器版本保护与本次核对版本；启动器拦截新版本时，按 DSH 笔记库的“启动与更新”处理。
- 模型/量化变化：改 config.json 的模型名；工作流结构变化时同步模板与 NODE_MAP。配置错误会在启动时明确报错。
- 未运行：status 只报告，不启动；generate 可自动启动。
- BUSY：等队列结束，再释放显存。
- OOM：回到 512×512、批量 1；等任务结束后释放模型，再检查其他显卡软件。
- 自动启动没有命令窗口：最近 PID 在 state/comfy.pid。不要仅凭旧 PID 结束进程，先核对可执行路径和命令行确实属于这份 ComfyUI；PID 可能复用。

HTTP 请求限制为本机 HTTP 地址，不跟随重定向；超时覆盖整个响应体，响应大小有上限。图片仅允许输出目录内的 PNG，禁止路径穿越及指向目录外的链接。提示词日志只记长度和哈希，ComfyUI 异常原文也不会复制进日志。stdout 只输出协议消息；未捕获的异常会记录事件类型并结束 MCP 服务，不继续运行未知状态。
