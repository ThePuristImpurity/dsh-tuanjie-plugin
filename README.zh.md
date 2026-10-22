# dsh-tuanjie-plugin · 团结引擎编辑器控制插件

把团结引擎（Tuanjie）编辑器接进 DeepSeek Harness：AI 可以直接查编辑器状态、读命令表、执行引擎命令、在编辑器进程里跑 C#。

**装上就能用，不需要另外安装任何适配器程序。**

## 安装

```bash
dsh plugin add dsh-tuanjie-plugin
```

或在 DeepSeek Harness 的插件市场里搜索 `tuanjie`。

## 前提

1. 团结引擎编辑器已打开目标工程，且工程装了 Codely 桥（`cn.tuanjie.codely.bridge`）——团结引擎默认自带。本插件**不能代为启动编辑器**，只能连接已在运行的实例。
2. 工程根目录存在 `.com-unity-codely.json`，且其中的 `unity_port` 可连通。

## 它解决什么

团结引擎内置了 Codely 桥，会在工程根目录写 `.com-unity-codely.json` 暴露本地 TCP 端口，讲一套 8 字节大端长度头 + JSON 的私有帧协议。本插件内置了这个协议的客户端（`bin/tuanjie-bridge.cjs`，用宿主自带的 Node 运行），把它翻译成命令行，再暴露成五个 `tuanjie_*` 工具。

## 五个工具

| 工具 | 作用 |
| --- | --- |
| `tuanjie_status` | 查看当前可连的编辑器实例（端口、工程路径、状态） |
| `tuanjie_list_commands` | 列出编辑器暴露的全部命令及其支持的 action |
| `tuanjie_command` | 执行一条具名命令，形如 `manage_gameobject` + `["create", "--name", "Player"]` |
| `tuanjie_eval` | 在编辑器进程里执行 C#，完整访问 UnityEngine / UnityEditor |
| `tuanjie_cli` | 跑底层桥子命令（仅 `status` / `editors` / `command` / `shell`） |

覆盖的命令包括 `manage_editor`、`manage_scene`、`manage_gameobject`、`manage_asset`、`manage_screenshot`、`manage_input`、`read_console`、`execute_menu_item`、`manage_window_bridge` 等 100 余条。

### 命令是「工具名 + action」两段式

不存在 `create_gameobject`、`set_transform`、`screenshot` 这类独立命令。真实写法是把 action 放进 `args` 的第一个元素：

```
manage_gameobject  + ["create", "--name", "Player"]
manage_gameobject  + ["modify", "--target", "Player", "--x", "1.5"]
manage_scene       + ["get_hierarchy"]
```

可用的工具名与 action 见 `tuanjie_list_commands` 返回的清单，或本插件自带技能 `tuanjie-workflow` 里的表格。

## 已知限制

- 桥**不能启动编辑器**，只能连接已在运行的实例。先手动打开团结引擎并加载工程。
- `manage_screenshot` 的 `capture_game_view` 已被桥禁用；Play Mode 动态验证需用 `manage_gameview` 或 `exec_runtime_script` 的 `record_game_view`（后者需要本机装了 ffmpeg）。
- `manage_screenshot` 的 `--output` 参数会被忽略，图固定落在工程根目录的 `screenshots/` 下，真实路径见返回体的 `data.path`。
- 参数命名：`create` 用 `--name`（新物体名），`modify` / `delete` / `find` / `get_components` 用 `--target`（已有物体）。用错不报「参数非法」，只报 `Target GameObject(s) ('') not found`。加组件用 `--componentName`。
- 写错参数名常常仍返回 `success: true` 却没有实际动作（静默失败），改完建议用 `tuanjie_eval` 回读确认。
- `tuanjie_eval` 的代码是拼进 argv 的，反斜杠转义会被吃掉（报 `CS1009`）；复杂代码请改用 `tuanjie_command` 传 args 数组。
- `tuanjie_cli` 不是 Unity Hub CLI，`projects create` / `templates list` / `open` / `pipeline install` / `test` / `build` / `logs` 等一律不支持。

## 配置

在设置页的「团结引擎」分组里填。通常只需要改两项：

- **命令行入口**（`tuanjieBin`）：默认 `auto`，即使用插件内置的桥客户端，无需安装任何东西。只有想换成自己的 CLI 包装程序时才填绝对路径（此时不传任何前缀参数，由该程序自行解析 `status` / `command` / `shell` 等子命令）。
- **默认工程路径**（`projectPath`）：实时工具默认作用的工程。

其余为超时、输出上限、暖会话等调优项，留空即用默认值。

## 注意

- 编辑器在线时**不要**手改 `.unity` / `.prefab` / `.asset`，会被静默覆盖。
- 改动后记得 `tuanjie_command` 调 `save_scene` 或 `manage_scene ensure_scene_saved`。
- 改了插件自身代码后，如果开着暖会话，需要杀掉旧的 node 进程，否则会继续跑旧代码。

## 许可

MIT。

本项目派生自 [`@opdsh/unity-plugin`](https://www.npmjs.com/package/@opdsh/unity-plugin) 0.1.7（MIT，Copyright (c) 2026 vibotaku），针对团结引擎的 Codely 桥重写了传输层与界面文案。原始版权声明保留在 `LICENSE` 中。
