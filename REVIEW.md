# 生图 MCP 检查与优化结果

核对日期：2026-10-07，Asia/Shanghai。服务由 1.0.0 修订为 **1.1.0**。

## GitHub 上传前复核：1.1.1

- 新增配置与注册模板、Git 忽略规则和运行命令。上传源代码、模板、说明与测试；本机 config.json、snippet、logs、state、备份、模型与图片均不纳入版本管理。
- 没有本机注册副本时，安装器/体检用通用模板自动填入当前项目路径；鲸鱼娘目标目录从 USERPROFILE 获取，支持其他用户名和项目位置。
- 修复非法 Content-Length 头会残留并影响下一帧的问题，增加针对它的测试，回归总数为 **30 项**。实际出图脚本记录当前服务版本和上海日期，避免未来运行仍标成旧版本/旧日期。
- 上传版本的本机验证：30 项回归、162 项自测、34 项真实 stdio 客户端通过。另从 Git 暂存内容建立干净副本，只复制 config.example.json 为 config.json，验证无本机 snippet 时的模板注册及上述测试。
- 1.1.1 未另行生成第二张图片；下方真实出图记录对应此前 1.1.0。真实 DSH profile 注册仍待用户按 README 的原流程完成。

下面保留 1.1.0 的审查与真实出图证据。

实际项目：`E:\aiworkplace\codexworkplace\dsh\qwen-image-mcp`，不是 codex1 目录。按 DSH 项目 AGENTS.md 读取了环境与项目笔记，并同步维护记录。

## 结论

现有架构可以继续使用，无需重写或增加第三方依赖。已修复等待、任务状态、取图、并发启动和安装脚本方面的问题，并通过真实 MCP stdio 生成图片。

原方案明确采用用户手动注册。**真实鲸鱼娘 profile 补丁尚未应用，DSH 聊天界面内调用尚未验证**；当前程序已经完成独立接口验证，不应将它写成“DSH 内已可用”。注册步骤在 [README](README.md)。

## 修复与优化

| 原问题 | 影响 | 修订 |
| --- | --- | --- |
| 宿主超时 300 秒，小于最多 180 秒启动 + 600 秒等待 | 后台可能出图，但客户端先失败 | 注册副本的调用超时改为 900 秒；配置校验等待预算 |
| fetch 超时在收到响应头后清除 | 响应体不结束时可无限等待 | 超时覆盖整个响应体，限制大小、禁止重定向 |
| 同一服务的并发调用各自启动 ComfyUI | 重复进程、端口冲突与 PID 混乱 | 同一 MCP 进程的并发请求共享启动 Promise |
| 历史和队列都无任务时默认 queued | 无效 ID、清除历史后会永远“排队” | 返回 unknown，并提示检查输出和任务 ID |
| 历史 HTTP 错误当作历史不存在 | 掩盖服务异常 | 明确错误，不冒充 queued |
| 提交后查询失败，错误未保留任务 ID | 用户容易重提交，重复生图 | 返回已提交的 prompt_id，提示继续 get_result |
| 存在图片输出就先报成功 | 部分输出后失败或中断被误判 | 执行错误优先；只读取节点 8；识别中断和结束但无图片 |
| 取图失败/写盘失败仍能返回路径 | 返回并不存在的“成功图片” | 保存存在且非空才返回成功；不会覆盖已存在文件 |
| 图片元数据直接拼路径 | 可能读写输出目录外文件 | 限制 output PNG，阻止路径穿越与目录外链接 |
| get_result 再查一次相同历史且无法返回图片内容 | 重复请求、超时后无法按相同方式回图 | 只查一次；支持 return_image |
| status 将节点端点的 HTTP 200 视为节点存在 | ComfyUI 返回空对象时假健康 | 检查节点对象；模型查询并行，移除重复请求 |
| free_vram 不检查队列 | 活跃任务期间产生不必要的卸载请求 | 队列有任务时返回 BUSY；队列不可确认时不卸载 |
| 安装器先统一换行、忽略 BOM 并移动原块 | “块外字节不变”与实际行为不符 | 保留原字节、BOM、混合换行、块位置；原子替换并校验 |
| 标记检查不拒绝多个完整块 | 可能修改错误的重复块 | 拒绝重复/残缺/倒置标记，识别带注释的手写 ID 冲突 |
| check.ps1 先同步读 stdout，再读 stderr，最后才等待 | 管道堵塞或进程挂住时超时不起作用 | 同时异步读取两条管道，60 秒进程等待上限 |
| `$record` 与 `-Record` 参数在 PowerShell 中同名 | 保存检查结果直接报类型错误 | 改为 `$checkRecord`；实际 -Live -Record 验证保存成功 |
| 自测暂时改写真实工作流模板 | 并发自测/生成可能遇到模板缺损 | 改为内存中的模板漂移测试 |
| 协议盲目回显任意版本、坏帧阻塞后续消息 | 兼容协商不实，后续请求可能无回复 | 支持的版本协商、请求结构校验、错误帧隔离、输入大小限制 |
| ComfyUI 错误原文进入日志 | 异常中可能含提示词 | 持久日志只记错误码；异常原文留在调用结果中 |
| 内置体检记录名叫 dshVersionVerified | 容易把文件检查当作 DSH 内工具实测 | 改为 dshVersionChecked，明确 dshToolsVerified=false |

工具仍为 generate、get_result、status、free_vram 四个；模型、分辨率默认值和八节点工作流保持原设置。终端和 stdio 退出仍保留 Windows 所需的短暂排空过程。

## 验证证据

- 原有离线自测 **162 项通过**。
- 原有真实 stdio 客户端测试 **34 项通过**，包括换行 JSON 与 Content-Length 兼容分帧。
- 新增回归测试 **29 项通过**，涵盖超时响应体、错误状态、路径及链接、并发启动、补丁字节精确恢复等。
- DSH 内置 Node 24.18.1 下自测、客户端测试和新增回归测试单独执行；结果见 `logs/review-embedded-*.log`。
- `check.ps1 -Live -Record` 成功保存 `state/last-check.json`；环境核对无 FAIL。未应用注册块仍是预期 WARN。
- **真实 MCP 出图**：512×512、20 步、CFG 1、seed 42。先 generate(wait_seconds=1)，再 get_result(return_image=true)，成功返回真实 PNG 与相同的图片内容，随后 status 和 free_vram 成功。整轮约 **43 秒**，包含服务冷启动和检查，不是纯生成时间。

实测任务：`bfd4e6ea-4cfa-4ef1-8528-37514441f169`。

输出：`E:\ComfyUI\ComfyUI_windows_portable\ComfyUI\output\DSH_Qwen21_review_k3ofmuxtzqnb_00001_.png`。

机器记录：`state/review-live-test.json`。

安装测试全部针对新建临时文件，真实 `cordis.patch.yml` 的 SHA256 保持为：

```text
CCFF5118D11547EDA75453242221C293A6FADB4FFB4C338B881B88F76EEAFA7C
```

原代码备份：`E:\aiworkplace\codexworkplace\codex1\.review\qwen-image-mcp-before-review.zip`。

## 范围和限制

未修改实际 DSH profile、DSH 安装、启动器、ComfyUI 主程序或模型权重。生成测试会新增 PNG，MCP 自动启动会保留独立的 ComfyUI 进程。结束测试后已请求释放模型。

DSH 内的加载、展示图片和会话中实际调用，仍需应用注册块后验证。本轮没有重新验证 768/1024 的长期连续任务；此前单张测试成功记录不能当作长期稳定性保证。多个不同 MCP 进程的跨进程启动竞争也不在本次同进程启动锁的保证范围内。

协议核对参考：[MCP stdio 传输规范](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports)、[初始化与版本协商](https://modelcontextprotocol.io/specification/2025-06-18/basic/lifecycle)。默认使用标准换行 JSON，保留 Content-Length 作为已有客户端的兼容能力。
