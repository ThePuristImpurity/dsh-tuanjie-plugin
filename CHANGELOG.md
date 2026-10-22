# CHANGELOG

## 0.1.0

首个公开发布版本。

### 能力

- 五个 AI 工具：`tuanjie_status` / `tuanjie_list_commands` / `tuanjie_command` / `tuanjie_eval` / `tuanjie_cli`。
- 通过团结引擎编辑器内置的 Codely 桥（TCP 帧协议：8 字节大端长度头 + JSON）通信，**不需要安装官方 Unity Pipeline 包**。
- 覆盖 `manage_editor` / `manage_scene` / `manage_gameobject` / `manage_asset` / `manage_screenshot` / `manage_input` / `read_console` / `execute_menu_item` / `manage_window_bridge` / `custom.*` 等 100 余条编辑器命令。
- `tuanjie_eval` 可直接在编辑器进程内执行 C#，访问 `UnityEngine` / `UnityEditor` 全量 API。
- 内置桥适配器（`bin/tuanjie-bridge.cjs`），用宿主自带的 Node 运行，**无需额外安装任何可执行文件**。

### 同上游 `@opdsh/unity-plugin` 0.1.7 的差异

- 传输层重写为 Codely 桥的 TCP 帧协议，不再依赖 Unity Hub / Unity CLI / Pipeline 包。
- 五个工具更名：`unity_*` → `tuanjie_*`；配置键 `unityBin` → `tuanjieBin`。
- 设置页与工具描述全部中文化。
- 内置技能为 `tuanjie-workflow`。
- **移除**上游的资产商店技能（其脚本会携带用户 OAuth 令牌调用 Unity Asset Store 私有接口）与从 `github.com/Unity-Technologies/skills` 下载 UCL 授权内容的功能。两者均不参与工具调用链，移除不影响任何功能。
- 修正 peer 依赖版本范围，使其正确匹配团结引擎宿主（含预发布版本）的各个分支。
- 按实测修正工具描述与 `tuanjie-workflow` 技能内容：命令改为「工具名 + action」两段式；纠正 `--name` / `--target` / `--componentName` 的参数名差异；`tuanjie_cli` 明确只支持 `status` / `editors` / `command` / `shell` 四个子命令；记录 `capture_game_view` 被禁用、`record_game_view` 需要 ffmpeg、`manage_input` 需要 Play 模式等限制。

### 许可

派生自 [`@opdsh/unity-plugin`](https://www.npmjs.com/package/@opdsh/unity-plugin) 0.1.7（MIT，Copyright (c) 2026 vibotaku）。本项目的原始版权声明保留在 `LICENSE` 中。
