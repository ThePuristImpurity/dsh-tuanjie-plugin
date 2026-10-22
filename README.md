# dsh-tuanjie-plugin

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin that drives the **Tuanjie (团结引擎)** editor — connect to a running editor's Codely bridge, build and modify scenes and GameObjects, edit component properties, run editor commands, and execute C# inside the editor process.

**Docs: [README.zh.md](README.zh.md)** (中文文档)

## Install

```bash
dsh plugin add dsh-tuanjie-plugin
```

## Requirements

The Tuanjie editor must already be running with the target project loaded, and that project must ship the Codely bridge (`cn.tuanjie.codely.bridge`, bundled with Tuanjie by default). This plugin cannot launch the editor for you.

## Tools

| Tool | Purpose |
| --- | --- |
| `tuanjie_status` | List connectable editor instances (port, project root, state) |
| `tuanjie_list_commands` | List every command the editor exposes, with supported actions |
| `tuanjie_command` | Run a named command, e.g. `manage_gameobject` + `["create", "--name", "Player"]` |
| `tuanjie_eval` | Execute C# inside the editor process with full `UnityEngine` / `UnityEditor` access |
| `tuanjie_cli` | Run the underlying bridge subcommands (`status` / `editors` / `command` / `shell`) |

## License

MIT. Derived from [`@opdsh/unity-plugin`](https://www.npmjs.com/package/@opdsh/unity-plugin) 0.1.7 (MIT, Copyright (c) 2026 vibotaku); the transport layer was rewritten for Tuanjie's Codely bridge. Original copyright notice is preserved in [LICENSE](LICENSE).
