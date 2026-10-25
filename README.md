# dsh-tuanjie-plugin

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin that drives the **Tuanjie (团结引擎)** editor — connect to a running editor's Codely bridge, build and modify scenes and GameObjects, edit component properties, run editor commands, and execute C# inside the editor process.

**Docs: [README.zh.md](README.zh.md)** (中文文档)

## Install

```bash
dsh plugin add github:ThePuristImpurity/dsh-tuanjie-plugin
```

Or search for `tuanjie` in the DeepSeek Harness plugin marketplace.

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

## Reliability (0.1.1)

The 0.1.0 line had one nasty failure mode: **a wrong argument type was silently dropped by the bridge while it still answered `success: true`**. 0.1.1 normalizes and validates arguments in the CLI adapter, so these either work or fail loudly:

| Invocation | 0.1.0 | 0.1.1 |
| --- | --- | --- |
| `--position "1,2,3"` | silently dropped, nothing moves | coerced to an array, actually applies |
| `--componentsToAdd BoxCollider` | silently dropped, Transform only | wrapped into an array |
| `--propertyValue "1,2,3"` | **zeroes out the vector** | coerced to an array, no longer zeroed |
| `--types warning` | ignored, returns every type | returns warnings only |
| `--name=X` (equals form) | stored as a key literally named `name=X` | equivalent to the space form |
| `delete --name X` | `Target GameObject ('') not found` | rejected, tells you to use `--target` |
| `--output out.png` | silently ignored | rejected, points at `--path` / `--filename` |
| misspelled flag (e.g. `--filterTypo`) | silently ignored | rejected with a spelling suggestion |
| `apply_text_edits` without line/column | inserts at the top of the file, still reports success | rejected before sending |
| `--imports System.Text` | overrides the default namespaces, `CS0103` | merged into the defaults |
| `modify --componentName X --propertyName Y --propertyValue Z` | reports success, **field keeps its old value** | rejected, points at `set_component_property` / `--componentProperties` |
| `modify --componentProperties '{"Typo":{…}}'` | `One or more component property operations failed`, no hint which | names the missing component and lists the ones the object really has |
| `modify --componentProperties '{"m_LocalPosition.x":5}'` | `success: true`, **nothing written** | rejected, tells you to nest it under a component |
| `apply_text_edits --edits '[]'` | bridge answers `No edits provided.` | rejected before sending |

An unknown argument is now caught **before the request is sent**, and the error lists every parameter that tool accepts. If the bridge answers with `No modifications applied`, `0 targets found`, or `not found using method`, the envelope is downgraded to a failure.

Even so, **verify writes with `tuanjie_eval`** — the plugin cannot change the bridge's own behaviour.

`tuanjie_eval` accepts quotes and backslashes as written (no escaping needed), and `Debug.Log` output comes back in `data.logs`.

## Known limitations

- The bridge **cannot launch the editor**; it only attaches to a running instance.
- `capture_game_view` is disabled by the bridge. Use `manage_gameview`, or `record_game_view` on `exec_runtime_script` (requires `ffmpeg`).
- Screenshots land where `--path` + `--filename` say (relative paths resolve against the project root); read the real path from `data.path`. `--path` may name the file directly when it ends in `.png` (`--path screenshots/Foo.png`): the value is split into directory + file name, while an extension-less `--path` still means a directory that the bridge names itself. Captures always write PNG — the bridge appends `.png` to `--filename` whatever it is given — so other image extensions (`.jpg`, `.gif`, …) are rejected with an error instead of silently turning into a directory.
- Keyboard and mouse-move input via `manage_input` needs the Input System package (`com.unity.inputsystem`). Clicking uGUI elements does not — it goes through the EventSystem.
- `tuanjie_cli` is not the Unity Hub CLI: `projects create`, `templates list`, `open`, `pipeline install`, `test`, `build`, `logs` are all unsupported.

## License

MIT. Derived from [`@opdsh/unity-plugin`](https://www.npmjs.com/package/@opdsh/unity-plugin) 0.1.7 (MIT, Copyright (c) 2026 vibotaku); the transport layer was rewritten for Tuanjie's Codely bridge. Original copyright notice is preserved in [LICENSE](LICENSE).
