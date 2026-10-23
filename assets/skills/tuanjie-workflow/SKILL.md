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
- **参数名错了不会告诉你可选值。** 桥本身对不认识的键一律静默丢弃，报错通常也只说"缺少 xxx 必填参数"，不列合法参数名。**v0.1.1 起插件 CLI 会在发送前按工具白名单校验，并给出拼写建议与全部合法参数名**（例：`'--filterTypo' is not a parameter of 'manage_asset', so the bridge would ignore it and still report success. Did you mean '--filterType'? Accepted: ...`）。看到这条就按提示改名，不要怀疑是工具不支持。
- **改完场景记得保存**：`tuanjie_command` + `command: "save_scene"`，或 `manage_scene` + `args: ["save"]`。

## 核心概念：命令是「工具名 + action」两段式

这是最容易踩的坑。**不存在** `create_gameobject` / `set_transform` / `add_component` / `screenshot` 这类独立命令。真实写法是把 action 放在 `args` 的第一个元素：

```
tuanjie_command  command: "manage_gameobject"  args: ["create", "--name", "Player"]
tuanjie_command  command: "manage_gameobject"  args: ["modify", "--target", "Player", "--position", "[1.5,3,0]"]
tuanjie_command  command: "manage_scene"       args: ["get_hierarchy"]
```

## 参数命名的大坑：`--name` vs `--target`

实测确认：`create` 用 `--name` 指新物体名，而 `modify` / `delete` / `find` / `get_components` 等操作用 **`--target`** 指向已有物体（也可以改用 `--instanceId`）。

用错参数名的历史症状是返回 `Target GameObject(s) ('') not found using method 'default'.`，看起来像物体不存在，实际是参数名没被识别。**v0.1.1 起插件 CLI 会直接拦下并告诉你改用 `--target`**，看到这条报错先检查是不是把 `--target` 写成了 `--name`。

## 参数速查表（2026-10-23 修订版：CLI 已做类型归一化与假阳性拦截）

**v0.1.1 起，插件 CLI 层会替你把这些坑堵掉**：`--position/--rotation/--scale` 接受 `"1,2,3"` 或 `"[1,2,3]"` 并自动转成数组；`--componentsToAdd BoxCollider` 自动包装成数组；`--types warning` 之类数组参数同样生效；`--ops` 里的嵌套 params 同样归一化；`--propertyValue "1,2,3"` 会转成数组而不再把向量清零；`--imports` 并入默认命名空间而非覆盖；`--name` 当 `--target` 用、无写入字段的 `modify`、`--output` 之类不存在的 flag、重复传同一个 flag、`apply_text_edits` 缺行列坐标，都会**直接报错**而不是假成功；`--flag=value` 与 `--flag value` 等价。下表「错误写法」列保留旧行为说明，便于识别历史输出。

### `manage_gameobject`

| 意图 | 正确写法 | 旧版错误写法 → 后果（v0.1.1 起已报错/已修正） |
| --- | --- | --- |
| 创建 | `["create", "--name", "X"]` | — |
| 创建时加组件 | `["create","--name","X","--componentsToAdd","BoxCollider"]`（v0.1.1 可用）或分开调 `add_component` | 旧版：**静默忽略**，`componentNames` 只有 Transform |
| 改位置 | `["modify","--target","X","--position","[1,2,3]"]` 或 `"1,2,3"`（均可） | 旧版 `"1,2,3"` 返回 success 但**位置不变**（假阳性） |
| 加组件 | `["add_component","--target","X","--componentName","BoxCollider"]` | `["modify",...,"--componentName",...]` → 无效，必须独立 action |
| 改组件属性 | `["set_component_property","--target","X","--componentName","BoxCollider","--propertyName","isTrigger","--propertyValue","true"]` | 把 `--propertyValue` 写成 `--value` → 报 `'componentProperties' dictionary or 'propertyName'/'propertyValue' pair is required.` |
| 改 Vector / Color 属性 | `--propertyName center --propertyValue "1,2,3"`（v0.1.1 自动转数组），或直接写 `"[1,2,3]"`；`Color` 用四元组 `"0.2,0.4,0.6,1"` | **旧版会把值清零**：桥的 `ParseJTokenToVector3` 遇纯字符串直接 `return Vector3.zero`，`center`/`size`/`offset` 被写成 0 而回包仍 `success: true`。这不是「没生效」而是「写坏了」 |
| 设字面量字符串属性 | `--propertyValue "'1,2,3'"`（套一层引号） | 不加引号会被当成三元组转成数组，字符串属性就写不进去 |
| 批量改组件属性 | `["modify","--target","X","--componentProperties",'{"BoxCollider":{"center":"1,2,3"}}']` | 旧版嵌套字符串走同一条清零路径；v0.1.1 起递归归一化，`--ops` 里的对象也一样 |
| 改名 | `["modify","--target","Old","--name","New"]` | 旧版曾被「空写入」校验误拦，v0.1.1 已修（只有 `--name` 与 target 同名才算定位参数） |
| 挂父物体 / 改层 / 改 tag | `["modify","--target","X","--parent","Canvas","--layer","UI","--tag","UI"]` | `--layer` **只认层名不认索引**，写 `--layer 5` 报 `Invalid layer specified: '5'. Use a valid layer name.`；`--parent` 传父物体**名字**即可，返回体的 `parentInstanceID` 会变成非 0 |
| 删物体 | `["delete","--target","X"]`（多目标逐个调用） | `["delete","--name","X"]` → v0.1.1 起本地直接报错并提示改用 `--target`（旧版报 `Target GameObject(s) ('') not found`）；`--target A --target B` **只处理最后一个**，别指望一次删多个 |
| 查询 | `["find","--target","X"]` / `["get_components","--target","X"]` / `["list_children","--target","X"]` / `["select","--target","X"]` | — |
| 按 instanceID 定位 | `["modify","--instanceId","-4182","--position","0,0,0"]`（v0.1.1 起会转成 `--target` + `--searchMethod by_id`） | 旧版直接写 `--instanceId` 会被忽略，报 `Target GameObject ('') not found`；等价的老写法是 `--target -4182 --searchMethod by_id` |
| 批量 | `["create_batch","--ops",'[{"action":"create","params":{"name":"A"}}]']` | op 缺 `params` 包装 → 报 `'name' parameter is required for 'create' action.` |
| 批量编辑 | `["edit_batch","--ops",'[{"action":"find","params":{"target":"B"},"captureAs":"$b"},{"action":"modify","params":{"target":"$b","position":"[3,3,3]"}}]']` | 用 `"as"` 代替 `captureAs` → 报 `find op must provide captureAs starting with '$'`；不 find 直接写 → 报 `edit_batch write ops must target a $alias captured by a previous find op.` |

### `manage_asset`

- `search` 的参数名是 **`--searchPattern` / `--filterType` / `--path` / `--pageSize`**，不是 `--query` / `--typeFilter`。旧版写错时会**静默返回全部资产**（本工程 4352 条），不报错；v0.1.1 起会被白名单校验拦下并提示 `Did you mean '--filterType'?`。
  例：`["search","--searchPattern","Enemy-Base","--filterType","UnitDefinition"]`。

### `manage_scene`

- 加载场景：`["load","--name","战斗场景","--path","Scenes"]`。桥按 `Assets/<path>/<name><ext>` 拼路径，`path` 里的文件名会被丢掉。
- **v0.1.1 起可以直接给完整路径**：`["load","--path","Assets/Scenes/战斗场景.scene"]` 会自动拆成 `--name 战斗场景 --path Scenes`。旧版这样写会报 `Either 'name'/'path' or 'buildIndex' must be provided`——明明给了 `path` 却说没有，因为 `name` 为空导致拼出的 `relativePath` 为 null。
- 只给 `--name` 不给 `--path` 会拼成 `Assets/战斗场景.scene`（缺目录），报 `Scene file not found at 'Assets/战斗场景.scene'`。
- 保存：`["ensure_scene_saved"]` 或别名 `save_scene`。返回 `{"scenePath":...,"dirty":false}` 才算真存住。

### 其它命令的动作清单（实测有效的）

- `manage_window_bridge`：`list_windows` `focus_window` `resolve_native_window` `input` `start_stream_server` `stop_stream_server` `get_stream_server_status` `start_offscreen_stream` `stop_offscreen_stream`。**没有** `get_info`。
- `manage_job`：`["list"]` 返回 `{"jobs":[]}`（当前无后台任务）。
- `get_custom_tools`：`["list"]` 返回 77 个 `custom.*` AI 生成工具及其完整参数说明。**返回体极大（几十 KB）**，只在你确实要用某个生成工具时查，别为了「看看有哪些」整份拉。
- `execute_menu_item`：`["get_available_menus"]` 返回全部菜单路径（本工程含大量 `AI/*` 自定义菜单）；执行用 `["execute","--menu_path","Assets/Refresh"]`（参数名是 `--menu_path`/`--menuPath`，写 `--path` 会报 `Required parameter 'menu_path' or 'menuPath' is missing or empty.`）。

### `manage_script`

- 建脚本：`["create","--name","Foo","--path","Assets/Scripts","--contents","public class Foo {}"]`。**只给 `--path` 不给 `--name` 会报 `Name parameter is required.`**
  - `path` 是**目录**不是文件，文件名由 `name + ".cs"` 拼出来；写 `--path Assets/Scripts/Foo.cs` 会被当成目录。
- **所有 `manage_script` 动作都要求 `--name`**，不只是 `create`：`read` / `update` / `delete` / `edit` / `apply_text_edits` / `validate` / `get_sha` 一律要 `--name Foo --path Assets/Scripts`。根因是 `ManageScript.cs:154-157` 在 action 路由之前就无条件校验 `name`，缺了直接 `Name parameter is required.`，跟你传的 `path` 对不对无关。
- 改脚本：`apply_text_edits` **必须给行列坐标**，字段是 `startLine` / `startCol` / `endLine` / `endCol`（1-based），配 `--edits '[{"startLine":1,"startCol":39,"endLine":1,"endCol":40,"newText":"42"}]'`。
  - **不要用 `oldText`/`newText`** —— 那是 `anchor_insert` 一类 action 的字段。桥读到缺坐标会回落到 1 行 1 列，把新文本插到文件最开头，还照样报 `editsApplied: 1`。（v0.1.1 起缺坐标会直接被 CLI 拦下。）
  - 第一次调用不给 `--precondition_sha256` 会返回 `{"status":"precondition_required","current_sha256":"..."}`，拿这个 sha 再调一次即可，避免改错版本。

### `exec_editor_script` / `exec_runtime_script` / `execute_csharp_script` 的 `--imports`

- 参数名是 `--script`（不是 `--code`），缺了报 `'script' parameter is required.`
- `--imports` 的值是**覆盖**而不是追加（`ExecuteCSharpScript.cs:334` 注释原话 "imports overrides rather than extends the default list"）。默认列表是 `System, System.Linq, System.Collections.Generic, UnityEngine, UnityEditor, UnityEditor.SceneManagement, UnityEngine.SceneManagement`。
  - 旧版只传 `--imports System.Text` 会顶掉 `UnityEngine`，脚本报 `CS0103: The name 'Application' does not exist in the current context`——看起来像脚本写错，其实是命名空间被覆盖。
  - **v0.1.1 起会自动并入默认列表再去重**，`--imports System.Text` 是安全的。
  - 旧版传 `--imports "System.Text,System.Linq"` 这种扁平字符串还会让整条命令失败：`Error converting value "..." to type 'System.String[]'`。
- 合法参数共 13 项：`action` `capture_logs` `description` `enable_repl` `execution_mode` `imports` `record_game_view` `script` `script_path` `script_session_id` `summary` `timeoutSeconds` `unlock_domain_reload`。

### `manage_screenshot` 的 `--focus_object`

- 聚焦某个物体再截图：`["capture_scene_view","--focus_object","Player","--path","screenshots","--filename","p.png"]`。
- 桥读的是 `p["focus_object"] as JObject`，内层真实键名是**全小写** `focusobject`。旧版传裸字符串会被强转成 null、整块跳过，截图照样 `success: true` 且 `warning: null`——看起来聚焦了其实拍的是全景。
- **v0.1.1 起裸名称会自动包成 `{focusobject: <name>}`**；目标不存在时桥回 `focus_object not found: path='X' index=0. Falling back to scene bounds.`，看到这条说明名字打错了。

## 四个硬限制（本机实测，绕不过去）

1. **Play 模式画面抓不到。** `capture_game_view` 被禁用（提示 `'capture_game_view' is disabled. Use record_game_view ...`），`capture` 同样被禁用；退路 `exec_runtime_script --record_game_view` 报 `ffmpeg was not found. Install ffmpeg on PATH, or set CODELY_FFMPEG_PATH`。**结论：运行时验证只能靠 `read_console` 的日志与堆栈**，不要浪费轮次去试截图。
2. **`manage_input` 只能在 PlayMode 用。** 编辑态调用直接失败：`manage_input requires PlayMode. Enter Play mode before dispatching 'key_press'.`
   - 本机**没装 Input System**，所以 `key_press` / `mouse_move` 会报 `This operation requires the Input System package, but it is not available (CODELY_INPUT_SYSTEM is not defined).`
   - **但点 uGUI 不需要 Input System**：`["mouse_click","--x","567","--y","62"]` 走 EventSystem 分支，命中后返回 `hitGameObject` 与 `method: "EventSystem"`。所以 Play 模式下**能真的点按钮**，不必只靠日志。
   - 坐标要自己算（屏幕像素，左上原点）。可先在 Play 模式下用 `tuanjie_eval` 换算：`var rt = GameObject.Find("Canvas/Attack").GetComponent<RectTransform>(); var c = rt.GetComponentInParent<Canvas>(); var p = RectTransformUtility.WorldToScreenPoint(c.worldCamera, rt.position); return p.x + "," + p.y;`
   - `manage_input` 的有效 action：`mouse_click` `mouse_move` `mouse_drag` `mouse_scroll` `mouse_down` `mouse_up` `key_press` `key_down` `key_up` `type_text` `create_virtual_devices` `destroy_virtual_devices` `sequence`。**没有 `click`。**
3. **`capture_scene_view` 不认 `--output`。** 它认的是 `--path <目录>` + `--filename <文件名>`；两者都不给就固定写到工程根 `screenshots/`，文件名 `SceneView_<时间戳>.png`。真实落盘路径看返回体的 `data.path`，别自己拼。（v0.1.1 起误用 `--output` 会直接报错并提示改用 `--path`/`--filename`。）
   - **未发布版起 `--path` 可以直接写完整文件名**：`["capture_scene_view","--path","screenshots/Foo.png"]` 会自动拆成 `path=screenshots` + `filename=Foo.png`。旧版这样写会把 `Foo.png` 当**目录**，实际落到 `screenshots/Foo.png/SceneView_<时间戳>.png`，而回包 `data.path` 还指着一半——看着像成功，文件却不在你以为的地方。
   - 只有末尾是 `.png` 才会拆；`--path screenshots/latest` 这种不带扩展名的仍然按目录处理、由桥自动命名。显式给了 `--filename` 则不拆。
   - **capture 动作只可能产出 PNG。** 桥会把 `.png` 无条件追加到 `--filename`（实测 `--filename ext__C.jpg` 得到 `ext__C.jpg.png`），所以 `.jpg` / `.jpeg` / `.gif` / `.webp` / `.bmp` / `.tga` / `.exr` 这类"看着像文件"的 `--path` 现在直接报错并提示改用 `.png`，不再静默把文件名建成目录。`start_game_view_recording` / `finish_game_view_recording` 不做拆分。
4. **`--focus_object` 旧版形同不存在。** 裸字符串会被 `as JObject` 强转成 null，整个聚焦分支跳过，回包 `success: true` 且 `warning: null`。v0.1.1 起自动包装成桥认识的 `{focusobject: <name>}`；名字打错会回 `focus_object not found: ...`。

## 常用命令与 action

| 命令 | action |
| --- | --- |
| `manage_editor` | `get_state` `get_current_state` `get_project_root` `play` `pause` `resume` `stop` `step` `refresh` `request_compile` `start_compilation_pipeline` `wait_for_compile` `wait_for_stop` `wait_for_idle` `get_compilation_summary` `get_windows` `get_active_tool` `set_active_tool` `get_selection` `drain_agent_input` `get_tags` `add_tag` `remove_tag` `ensure_tag` `get_layers` `add_layer` `remove_layer` `ensure_layer` `focus_window` `publish_dirty_state_if_needed` |
| `manage_scene` | `create` `load` `save` `get_hierarchy` `get_active` `get_build_settings` `ensure_scene_open` `ensure_scene_saved` |
| `manage_gameobject` | `create` `modify` `delete` `find` `list_children` `get_components` `add_component` `remove_component` `set_component_property` `select` `create_batch` `edit_batch` `ensure_component` `ensure_renderer_material` `ensure_mesh_collider_mesh` `ensure_prefab_default_sprite` |
| `manage_asset` | `import` `create` `modify` `delete` `duplicate` `move` `search` `get_info` `create_folder` `get_components` `ensure_has_meta` `ensure_meta_integrity` |
| `manage_screenshot` | `capture_scene_view` `capture_main_camera` `capture_specific_camera` `capture_asset` `capture_ui_toolkit` `capture_scene_camera` `start_game_view_recording` `finish_game_view_recording`（`capture_game_view` 已禁用） |
| `manage_input` | `mouse_click` `mouse_move` `mouse_drag` `mouse_scroll` `mouse_down` `mouse_up` `key_press` `key_down` `key_up` `type_text` `create_virtual_devices` `destroy_virtual_devices` `sequence` |
| `manage_script` | `create` `read` `update` `delete` `edit` `apply_text_edits` `validate` `get_sha` |
| `manage_shader` | `detect_render_pipeline` `ensure_material_shader_for_srp` `compile` `preview` |
| `manage_package` | `install_package` `remove_package` `list_packages` |
| `manage_bake` | `bake_navmesh` `bake_lighting` `wait_for_bake` `clear_navmesh` `clear_baked_data` |
| `manage_window_bridge` | `list_windows` `focus_window` `resolve_native_window` `input` `start_stream_server` `stop_stream_server` `get_stream_server_status` `start_offscreen_stream` `stop_offscreen_stream` |
| `manage_gameview` | `get_resolution` `set_resolution` `list_resolutions`（**没有 capture**） |
| `manage_dialog` | `click` |
| `manage_job` | `status` `list` `cancel` |
| `execute_menu_item` | `execute` `get_available_menus` |
| `read_console` | `get` `clear` |

单段别名（不用 action，直接当命令名用）：`editor_play`、`editor_pause`、`editor_stop`、`editor_step`、`save_scene`、`get_scene_hierarchy`、`read_console`。

Play Mode 下的动态验证不能用 `manage_screenshot capture_game_view`（已被禁用），改用 `manage_gameview` 或 `exec_runtime_script` 的 `record_game_view`；两者本机都因缺 ffmpeg 不可用，**实战路线是 `read_console` 看日志 + `manage_input mouse_click` 点 UI 触发逻辑**。

Play 模式下写场景会被拦：`manage_gameobject create` 返回 `success: false`、`data.code = "write_blocked_in_play_mode"`，message 为 `Cannot perform manage_gameobject.create in Play/Paused mode. Stop Play mode first, or change write guard policy to 'allow_with_warning' (experimental).` 要改场景先 `editor_stop`。`tuanjie_eval` 不受此限制（可直接在 Play 模式下跑 C# 读状态）。

## 典型的场景循环

1. `tuanjie_command` → `get_scene_hierarchy`，先摸清现有结构。
2. 建物体：`manage_gameobject` + `["create", "--name", "Player"]`。
3. 改物体的 Transform：`manage_gameobject` + `["modify", "--target", "Player", "--position", "[1.5,3,0]"]`（注意是 `--target`，不是 `--name`）。
4. 改组件的字段：`set_component_property --target X --componentName Y --propertyName Z --propertyValue V`。
5. 没有专门 action 的活儿用 `tuanjie_eval` 写 C#，结尾 `return <表达式>;`。
6. 收工前 `save_scene`。

## 关于 tuanjie_eval

**2026-10-23 实测修正：引号和反斜杠不会被吃掉。** 在 Tuanjie 2022.3.62t14 + bridge 1.0.80 上，`var s = "带引号的\"测试\""; return s;` 原样返回；`"path=C:\\Temp\\x"` 也正确得到 `C:\Temp\x`。argc 是逐项传的，不经 shell。

- 简单表达式没问题：`return Application.unityVersion;`
- 双引号字符串、反斜杠、中文均可直接写在 `code` 里。
- `Debug.Log` / `Debug.LogWarning` 的输出会回传到返回体的 `data.logs`，同时也能被 `read_console` 读到 —— 这是 Play Mode 下最可靠的验证手段。
- 实测有效的回读写法：`var go = GameObject.Find("X"); return go == null ? "missing" : go.transform.position.ToString("F2") + " comps=" + go.GetComponents<Component>().Length;`

## 写操作必须回读验证

CLI 护栏只能拦住**已知**的静默失败。桥本身在遇到它不认识的参数时仍可能回 `success: true`，所以：

- 每次 `create` / `modify` / `add_component` / `set_component_property` 之后，用 `tuanjie_eval` 回读真实值（位置、组件数、字段值），别只看返回码。
- 批量操作看 `data.summary.failed` 和每个 op 的 `message`，不要只看顶层 `success`。
- 收工前 `manage_scene ["get_active"]`，确认 `isDirty: false`，或显式 `["ensure_scene_saved"]`。

## tuanjie_cli 只支持 5 个子命令

`tuanjie_cli` 不是 Unity Hub 的 CLI。适配器只转发到 Codely 桥，**只支持**：

- `["status"]` —— 列出在线实例与 state
- `["editors"]` / `["editors", "--installed"]` —— 同上精简版
- `["command", <命令名>, ...参数]` —— 等价于 `tuanjie_command`
- `["shell", "--protocol", "ndjson"]` —— 热会话

**不支持** `projects create`、`templates list`、`open`、`pipeline install`、`test`、`build`、`auth status`、`license status`、`logs`、`doctor`。这些会明确返回 `subcommand 'X' is not supported by the Tuanjie bridge`，别试。

要驱动编辑器，优先用 `tuanjie_command` / `tuanjie_eval`；`tuanjie_cli` 只留给查状态。

## 参数名从哪来

桥对不认识的键**一律静默丢弃**，这是本项目最贵的坑的来源。三层防护：

1. `tuanjie_list_commands` 列出每个工具的 action（v0.1.1 起已按桥 1.0.80 实测补齐）。
2. v0.1.1 起 CLI 按工具参数白名单校验，写错直接报错并给拼写建议 + 全部合法参数名，例如：
   `'--filterTypo' is not a parameter of 'manage_asset', so the bridge would ignore it and still report success. Did you mean '--filterType'? Accepted: action, assetType, destination, ...`
3. 拿不准就 `tuanjie_eval` 直接跑 C#，绕过桥的参数解析。

记住几个高频易错：`execute_menu_item` 用 `--menu_path`；`manage_asset search` 用 `--searchPattern`/`--filterType`；截图用 `--path`+`--filename` 而不是 `--output`（未发布版起 `--path` 也可直接写 `xxx.png`）；定位物体用 `--target`（或 v0.1.1 起可用的 `--instanceId`），只有 `create` 用 `--name`；脚本用 `--script`/`--imports`（`--imports` 是覆盖语义，v0.1.1 起自动并入默认值）；Vector/Color 属性既可直接写元组也可写数组，但**别指望字符串会被桥自己解析**——旧版是清零而非忽略。

## 排错

- `tuanjie_status` 返回 `STATUS_NO_INSTANCES`：没有加载桥包的编辑器在运行。请用户先打开团结编辑器并加载工程，再反复查 `tuanjie_status` 直到 `state` 变成 `"ready"`。
- 桥不通时先看工程根目录的 `.com-unity-codely.json`（含 `unity_port` / `stream_port` / `reason: "ready"`），文件在、reason 是 ready，才说明编辑器侧服务起来了。
- 编辑器在导入资源或重编译期间会短暂断连，属正常，等一会儿再查 `tuanjie_status`。
- 包管理：编辑器在线时绝不要手改 `Packages/manifest.json`，用 `tuanjie_eval` 调 `UnityEditor.PackageManager.Client.Add(...)` 并轮询。
