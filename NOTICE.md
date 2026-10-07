# Notices and attribution

Local Image MCP is an independent community project maintained by fz-liu.
Project contributions are provided under [MIT](LICENSE), to the extent the
maintainer can license them. Third-party rights and model terms remain separate.

## Referenced and adapted work

- Transport framing was adapted with reference to
  [dsh-computer-use-win](https://github.com/Yu-tao-Li/dsh-computer-use-win),
  installed version 0.2.3. Copyright (c) 2026 Yu-tao-Li; Copyright (c) 2026
  cgissing. The full MIT notice is retained in
  [third_party_licenses/dsh-computer-use-win.LICENSE](third_party_licenses/dsh-computer-use-win.LICENSE).
  This project adds validation, bounded buffering, bad-frame recovery and
  error handling; no computer-control backend or plugin bundle is distributed.
- The eight-node API configuration was developed from the local tested workflow;
  earlier deployment referenced
  [toyhank/qwen-image-2.1-8gb](https://github.com/toyhank/qwen-image-2.1-8gb).
  Its MIT notice, Copyright (c) 2026 as written upstream, is retained in
  [third_party_licenses/toyhank-workflow.LICENSE](third_party_licenses/toyhank-workflow.LICENSE).
  Nodes, parameters and output handling were adapted for this MCP bridge.
  License blob checked on 2026-10-07: `14fac913ccf80234b1848540089a3bbcb6e5283d`.

## External software and models (not bundled)

- [ComfyUI](https://github.com/Comfy-Org/ComfyUI) is a separately installed
  program. Its [GPL-3.0 license](https://github.com/Comfy-Org/ComfyUI/blob/master/LICENSE)
  governs its code; this repository does not relicense or package it.
- [ComfyUI-GGUF](https://github.com/leejet/ComfyUI-GGUF) is separately installed.
  Its [Apache-2.0 license](https://github.com/leejet/ComfyUI-GGUF/blob/main/LICENSE)
  remains applicable to that plugin.
- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) is an
  optional separately installed MCP host. Its [source license](https://github.com/deepseek-ai/deepseek-harness/blob/master/LICENSE)
  and [service terms](https://www.deepseek.com/harness/terms-of-use/) are separate.
  This project does not package the host, community desktop assets or logos.
- [Qwen-Image 2.1](https://huggingface.co/Qwen/Qwen-Image-2.1),
  [Comfy-Org files](https://huggingface.co/Comfy-Org/Qwen-Image-2.1), and
  [leejet quantized files](https://huggingface.co/leejet/Qwen-Image-2.1-GGUF)
  must be obtained separately. Their upstream research license is not replaced
  by this repository's MIT license. No model weights are distributed here.

For attribution to the external model:

> Qwen is licensed under the Qwen RESEARCH LICENSE AGREEMENT, Copyright (c) 2026 Hangzhou Tongyi Laboratory Technology Co., Ltd. All Rights Reserved.

Qwen, ComfyUI and DeepSeek names and identifiers are used descriptively to
explain compatibility. This project is not affiliated with, sponsored by,
endorsed by or an official release of those organizations. No trademark rights
are granted by this repository.
