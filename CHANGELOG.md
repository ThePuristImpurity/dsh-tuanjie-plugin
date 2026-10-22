# CHANGELOG

## 0.1.1

修复 CLI 适配层的「假成功」问题：参数类型不对时桥会静默跳过该参数，却仍然回 `success: true`，调用方以为写进去了。

### 修复

- **向量参数自动归一化。** `--position` / `--rotation` / `--scale` / `--localPosition` / `--localRotation` / `--localScale` / `--center` / `--size` / `--velocity` / `--eulerAngles` 现在接受 `"1,2,3"`、`"1 2 3"`、`"[1,2,3]"` 三种写法，统一转成 JSON 数组再发给桥。此前写成 `"1,2,3"` 会被桥的 `as JArray` 强转丢掉，位置纹丝不动但仍报成功。
- **数组参数自动包装。** `--componentsToAdd BoxCollider` 会转成 `["BoxCollider"]`。此前 `create --componentsToAdd` 会被静默忽略，物体建出来只有 Transform。
- **批量 ops 内嵌参数同样归一化。** `edit_batch --ops` 里每个 op 的 `params` 走同一套规则，`"position":"3,3,3"` 现在会真的生效。
- **`componentProperties` 校验。** 非 JSON 对象直接报错，不再让桥静默丢弃。
- **不存在的 flag 直接报错。** `--output` / `--out` / `--file` / `--dir` / `--save` 桥根本不读，现在会提示改用 `--path` / `--filename` / `manage_scene save`。
- **targeting action 误用 `--name` 直接报错。** `modify` / `delete` / `find` / `get_components` / `add_component` / `remove_component` / `set_component_property` / `list_children` 只认 `--target` / `--instanceId`，写 `--name` 会立刻提示，而不是返回 `Target GameObject(s) ('') not found`。
- **空写入的 `modify` 直接报错。** 只给 target 不给任何可写字段时提前拦截。
- **回包降级。** 桥回 `No modifications applied`、`0 targets found`、`not found using method`、`is required`、`is missing or empty` 这类内容时，即使 `success: true` 也把信封降级为失败，并把原因追加到 `errors`。

### 文档

- `tuanjie-workflow` 技能按实测修订：向量/数组参数已自动归一化；`execute_menu_item` 参数名是 `--menu_path`；`manage_asset search` 用 `--searchPattern` / `--filterType`；`capture_scene_view` 认 `--path` + `--filename`；`tuanjie_eval` 的引号与反斜杠实测不会被吃掉。

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
