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
manage_gameobject  + ["modify", "--target", "Player", "--position", "1.5,0,0"]
manage_scene       + ["get_hierarchy"]
```

可用的工具名与 action 见 `tuanjie_list_commands` 返回的清单，或本插件自带技能 `tuanjie-workflow` 里的表格。

## 已知限制

- 桥**不能启动编辑器**，只能连接已在运行的实例。先手动打开团结引擎并加载工程。
- `manage_screenshot` 的 `capture_game_view` 已被桥禁用；Play Mode 动态验证需用 `manage_gameview` 或 `exec_runtime_script` 的 `record_game_view`（后者需要本机装了 ffmpeg）。
- 截图落盘位置由 `--path` + `--filename` 决定（相对路径按工程根解析），真实路径见返回体的 `data.path`。`--path` 末尾是 `.png` 时可以直接写成完整文件名（`--path screenshots/Foo.png`），会被拆成目录 + 文件名；不带扩展名的 `--path` 仍然按目录处理，由桥自动命名。capture 动作**只可能产出 PNG**——桥会把 `.png` 无条件追加到 `--filename`（`--filename x.jpg` 得到 `x.jpg.png`），所以 `.jpg` / `.gif` 等其它图片扩展名现在直接报错，而不是静默把文件名建成目录。
- `tuanjie_cli` 不是 Unity Hub CLI，`projects create` / `templates list` / `open` / `pipeline install` / `test` / `build` / `logs` 等一律不支持。
- `manage_input` 的键盘/鼠标移动需要工程装了 Input System（`com.unity.inputsystem`）；点 uGUI 按钮不需要，走 EventSystem 即可。

## 0.1.1 起：静默失败被堵掉了

0.1.0 有一类问题很坑：**参数类型写错时桥会静默跳过该参数，却仍然回 `success: true`**，调用方以为写进去了。0.1.1 在 CLI 适配层做了统一归一化与校验，现在这些坑要么自动转正、要么直接报错：

| 写法 | 0.1.0 | 0.1.1 |
| --- | --- | --- |
| `--position "1,2,3"` | 静默丢弃，物体不动 | 自动转数组，真的生效 |
| `--componentsToAdd BoxCollider` | 静默丢弃，只有 Transform | 自动包装成数组 |
| `--propertyValue "1,2,3"` | **把向量清零**（比丢弃更糟） | 自动转数组，不再清零 |
| `--types warning` | 忽略，返回全部类型 | 只返回警告 |
| `--name=X`（等号写法） | 存成叫 `name=X` 的键 | 与空格写法等价 |
| `delete --name X` | `Target GameObject ('') not found` | 报错说明该改用 `--target` |
| `--output out.png` | 静默忽略 | 报错并指明用 `--path`/`--filename` |
| `--filterTypo`（拼错参数名） | 静默忽略，返回全部资产 | 报错并给出拼写建议 |
| `apply_text_edits` 缺行列坐标 | 插到文件开头还报成功 | 直接拦下 |
| `--imports System.Text` | 顶掉默认命名空间，报 `CS0103` | 自动并入默认列表 |

参数名写错现在会**在发送前被拦下**，报错附该工具全部可用参数名。桥回 `No modifications applied` / `0 targets found` / `not found using method` 这类内容时，信封也会降级为失败。

即便如此，**写操作后仍建议用 `tuanjie_eval` 回读确认**——桥自身的行为不受本插件控制。

`tuanjie_eval` 的代码实测可以直接写引号和反斜杠，不必额外转义；`Debug.Log` 的输出会回传到 `data.logs`。

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
