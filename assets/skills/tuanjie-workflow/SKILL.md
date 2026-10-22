---
name: tuanjie-workflow
description: 用 tuanjie_* 工具驱动团结引擎（Tuanjie）编辑器 —— 连接正在运行的编辑器、搭建场景与 GameObject、给组件改属性、执行 C#、保存成果。凡是要做团结游戏、或任务涉及团结工程、场景、预制体、编辑器时都用它。注意它只能连接**已在运行**的编辑器，不能代为启动引擎。
---

# 团结引擎编辑器工作流

通过 `tuanjie_*` 一组工具驱动团结引擎。底层走的是团结编辑器内置的 `cn.tuanjie.codely.bridge` 包提供的本地 TCP 协议，所以场景操作往返在毫秒级，不重新编译、不触发域重载。

**这个适配器不会启动编辑器。** 它只连接已经在运行的实例；编辑器没开就什么都做不了，需要先请用户手动打开团结编辑器并加载工程。

## 铁律

- **永远先调 `tuanjie_status`。** 不要假设编辑器正在运行。编辑器在线时**绝不能**手改 `.unity`、`.prefab`、`.asset` 这类 YAML 文件——编辑器的内存状态会把你的手改静默覆盖。只有确认没有编辑器连接之后，才退回到直接改文件。
- **命令要现查现用。** 先调 `tuanjie_list_commands`，不要凭印象猜。返回的清单里既有内置桥工具（`manage_*` 等），也有工程自定义的 `custom.*`（本工程装了 TJGenerators，注册了几十个 AI 生成工具）。
- **参数名错了不会告诉你可选值。** 报错通常只说"缺少 xxx 必填参数"，不列合法参数名，所以务必先查清单。
- **改完场景记得保存**：`tuanjie_command` + `command: "save_scene"`，或 `manage_scene` + `args: ["save"]`。

## 核心概念：命令是「工具名 + action」两段式

这是最容易踩的坑。**不存在** `create_gameobject` / `set_transform` / `add_component` / `screenshot` 这类独立命令。真实写法是把 action 放在 `args` 的第一个元素：

```
tuanjie_command  command: "manage_gameobject"  args: ["create", "--name", "Player"]
tuanjie_command  command: "manage_gameobject"  args: ["modify", "--target", "Player", "--x", "1.5"]
tuanjie_command  command: "manage_scene"       args: ["get_hierarchy"]
```

## 参数命名的大坑：`--name` vs `--target`

实测确认：`create` 用 `--name` 指新物体名，而 `modify` / `delete` / `find` / `get_components` 等操作用 **`--target`** 指向已有物体（也可以改用 `--instanceId`）。

用错参数名**不会**报"参数名非法"，只会报：

```
Target GameObject(s) ('') not found using method 'default'.
```

看起来像是物体不存在，实际是你的参数名没被识别。遇到这个报错，先检查是不是把 `--target` 写成了 `--name`。

## 参数速查表（全部实测通过，2026-10-23 校验）

**最需要注意的一点：参数写错往往不报错，直接返回 `success: true` 但什么都没做。** 写完务必用 `tuanjie_eval` 回读真实值确认，别信返回码。

### `manage_gameobject`

| 意图 | 正确写法 | 错误写法 → 后果 |
| --- | --- | --- |
| 创建 | `["create", "--name", "X"]` | — |
| 创建时加组件 | 分开调 `add_component` | `["create","--name","X","--componentsToAdd","BoxCollider"]` → **静默忽略**，`componentNames` 只有 Transform |
| 改位置 | `["modify","--target","X","--position","[1,2,3]"]` | `"--position","1,2,3"` → 返回 success 但**位置不变**（假阳性） |
| 加组件 | `["add_component","--target","X","--componentName","BoxCollider"]` | `["modify",...,"--componentName",...]` → 无效，必须独立 action |
| 改组件属性 | `["set_component_property","--target","X","--componentName","BoxCollider","--propertyName","isTrigger","--propertyValue","true"]` | 把 `--propertyValue` 写成 `--value` → 报 `'componentProperties' dictionary or 'propertyName'/'propertyValue' pair is required.` |
| 删物体 | `["delete","--target","X"]` | `["delete","--name","X"]` → `Target GameObject(s) ('') not found` |
| 查询 | `["find","--target","X"]` / `["get_components","--target","X"]` / `["list_children","--target","X"]` / `["select","--target","X"]` | — |

### `manage_scene`

- 加载场景认 **`--name`**，不认 `--path`：`["load","--name","战斗场景"]`。给 `--path` 会报 `Either 'name'/'path' or 'buildIndex' must be provided`（措辞有误导性）。
- 要按完整路径打开，用 `tuanjie_eval`：`UnityEditor.SceneManagement.EditorSceneManager.OpenScene("Assets/Scenes/战斗场景.scene", OpenSceneMode.Single);`
- 保存：`["ensure_scene_saved"]` 或别名 `save_scene`。返回 `{"scenePath":...,"dirty":false}` 才算真存住。

### 其它命令的动作清单（实测有效的）

- `manage_window_bridge`：`list_windows` `focus_window` `resolve_native_window` `input` `start_stream_server` `stop_stream_server` `get_stream_server_status` `start_offscreen_stream` `stop_offscreen_stream`。**没有** `get_info`。
- `manage_job`：`["list"]` 返回 `{"jobs":[]}`（当前无后台任务）。
- `get_custom_tools`：`["list"]` 返回 77 个 `custom.*` AI 生成工具及其完整参数说明。
- `execute_menu_item`：`["get_available_menus"]` 返回全部菜单路径（本工程含大量 `AI/*` 自定义菜单）；执行用 `["execute","--path","Assets/Refresh"]`。

## 三个硬限制（本机实测，绕不过去）

1. **Play 模式画面抓不到。** `capture_game_view` 被禁用（提示 `'capture_game_view' is disabled. Use record_game_view ...`），`capture` 同样被禁用；退路 `exec_runtime_script --record_game_view` 报 `ffmpeg was not found. Install ffmpeg on PATH, or set CODELY_FFMPEG_PATH`。**结论：运行时验证只能靠 `read_console` 的日志与堆栈**，不要浪费轮次去试截图。
2. **`manage_input` 只能在 PlayMode 用。** 编辑态调用直接失败：`manage_input requires PlayMode. Enter Play mode before dispatching 'key_press'.`
3. **`capture_scene_view` 忽略 `--output`。** 固定写到工程根 `screenshots/`，文件名 `SceneView_<时间戳>.png`。真实落盘路径看返回体的 `data.path`，别自己拼。

## 常用命令与 action

| 命令 | action |
| --- | --- |
| `manage_editor` | `get_state` `get_current_state` `get_project_root` `play` `pause` `resume` `stop` `step` `refresh` `request_compile` `wait_for_compile` `wait_for_stop` `wait_for_idle` `get_compilation_summary` `get_windows` `get_active_tool` `set_active_tool` `get_selection` `get_tags` `add_tag` `ensure_tag` `get_layers` `add_layer` `remove_layer` `ensure_layer` `focus_window` |
| `manage_scene` | `create` `load` `save` `get_hierarchy` `get_active` `get_build_settings` `ensure_scene_open` `ensure_scene_saved` |
| `manage_gameobject` | `create` `modify` `delete` `find` `list_children` `get_components` `add_component` `remove_component` `set_component_property` `select` `create_batch` `edit_batch` |
| `manage_asset` | `import` `create` `modify` `delete` `duplicate` `move` `search` `get_info` `create_folder` `get_components` `ensure_has_meta` `ensure_meta_integrity` |
| `manage_screenshot` | `capture_scene_view` `capture_main_camera` `capture_specific_camera` `capture_asset` `capture_ui_toolkit` `capture_scene_camera`（`capture_game_view` 已禁用） |
| `manage_input` | `mouse_click` `mouse_move` `mouse_drag` `mouse_scroll` `mouse_down` `mouse_up` `key_press` `key_down` `key_up` `type_text` `sequence` |
| `execute_menu_item` | `execute` `get_available_menus` |
| `read_console` | `get` `clear` |

单段别名（不用 action，直接当命令名用）：`editor_play`、`editor_pause`、`editor_stop`、`editor_step`、`save_scene`、`get_scene_hierarchy`、`read_console`。

Play Mode 下的动态验证不能用 `manage_screenshot capture_game_view`（已被禁用），改用 `manage_gameview` 或 `exec_runtime_script` 的 `record_game_view`。

**截图输出路径不受控**：实测 `manage_screenshot capture_scene_view --output <路径>` 会忽略 `--output`，固定存到工程根目录的 `screenshots/` 下，文件名形如 `SceneView_2026-10-23_05-58-18-124.png`，返回体里的 `data.path` 是真实落盘路径。要拿图就从这个字段读，不要自己拼路径。

## 典型的场景循环

1. `tuanjie_command` → `get_scene_hierarchy`，先摸清现有结构。
2. 建物体：`manage_gameobject` + `["create", "--name", "Player"]`。
3. 改物体的 Transform：`manage_gameobject` + `["modify", "--target", "Player", "--position", "[1.5,3,0]"]`（注意是 `--target`，不是 `--name`）。
4. 改组件的字段：`set_component_property --target X --componentName Y --propertyName Z --propertyValue V`。
5. 没有专门 action 的活儿用 `tuanjie_eval` 写 C#，结尾 `return <表达式>;`。
6. 收工前 `save_scene`。

## 关于 tuanjie_eval 的坑

代码是拼在 argv 里传给桥的，**引号和反斜杠很容易被吃掉**，典型报错是 `CS1009: Unrecognized escape sequence` 或 `CS0103: The name 'xxx' does not exist`。

- 简单表达式没问题：`return Application.unityVersion;`
- 需要双引号字符串时，优先改用 `tuanjie_command` 传 args 数组（argv 逐项原样传递，不经 shell 解析）。
- 实在要用 eval 做复杂操作，把它拆成多条简单语句。

## tuanjie_cli 只支持 5 个子命令

`tuanjie_cli` 不是 Unity Hub 的 CLI。适配器只转发到 Codely 桥，**只支持**：

- `["status"]` —— 列出在线实例与 state
- `["editors"]` / `["editors", "--installed"]` —— 同上精简版
- `["command", <命令名>, ...参数]` —— 等价于 `tuanjie_command`
- `["shell", "--protocol", "ndjson"]` —— 热会话

**不支持** `projects create`、`templates list`、`open`、`pipeline install`、`test`、`build`、`auth status`、`license status`、`logs`、`doctor`。这些会明确返回 `subcommand 'X' is not supported by the Tuanjie bridge`，别试。

要驱动编辑器，优先用 `tuanjie_command` / `tuanjie_eval`；`tuanjie_cli` 只留给查状态。

## 排错

- `tuanjie_status` 返回 `STATUS_NO_INSTANCES`：没有加载桥包的编辑器在运行。请用户先打开团结编辑器并加载工程，再反复查 `tuanjie_status` 直到 `state` 变成 `"ready"`。
- 桥不通时先看工程根目录的 `.com-unity-codely.json`（含 `unity_port` / `stream_port` / `reason: "ready"`），文件在、reason 是 ready，才说明编辑器侧服务起来了。
- 编辑器在导入资源或重编译期间会短暂断连，属正常，等一会儿再查 `tuanjie_status`。
- 包管理：编辑器在线时绝不要手改 `Packages/manifest.json`，用 `tuanjie_eval` 调 `UnityEditor.PackageManager.Client.Add(...)` 并轮询。
