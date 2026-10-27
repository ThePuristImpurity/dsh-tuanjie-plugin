#!/usr/bin/env node
/**
 * unity CLI shim for Tuanjie (团结引擎) Editor.
 *
 * Speaks the Codely Bridge TCP protocol instead of Unity's official CLI:
 *   8-byte big-endian length header + UTF-8 JSON payload
 *   server greeting: "WELCOME UNITY-TCP 1 FRAMING=1 SERVER_VERSION=2\n"
 *   client must send framed "CLIENT_VERSION=2" when server_version >= 2
 *   request:  {"type":"<command>","params":{...},"request_id":"ntb-N"}
 *   response: {"success":bool,"message":str,"result"|"data":{...},"request_id":"ntb-N"}
 *
 * Emulates the subset of `unity` that @opdsh/unity-plugin drives:
 *   unity status --format json
 *   unity command [<cmd> [args...]] --project-path <p> --format json
 *   unity command eval <csharp> --project-path <p> --format json
 *   unity shell --protocol ndjson
 * Every invocation prints one JSON envelope: { success, command, data, errors, warnings }.
 */
'use strict';

const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');

const MAX_FRAME = 64 * 1024 * 1024;
const CONNECT_TIMEOUT_MS = 5000;
const DEFAULT_TIMEOUT_MS = 120000;

/* ------------------------------------------------------------------ */
/* Bridge port discovery                                               */
/* ------------------------------------------------------------------ */

/**
 * Read `unity_port` from the project's .com-unity-codely.json heartbeat.
 *
 * The heartbeat moved to `Temp/` in Codely bridge 1.0.86 ("端口注册文件改到项目
 * Temp/"), but older editors still drop it at the project root and some builds
 * mirror it under `Library/`. All three are checked so discovery keeps working
 * whichever bridge version the editor ships.
 */
const HEARTBEAT_CANDIDATES = [
  '.com-unity-codely.json',
  path.join('Temp', '.com-unity-codely.json'),
  path.join('Library', '.com-unity-codely.json'),
];

function readHeartbeat(cfg) {
  try {
    const json = JSON.parse(fs.readFileSync(cfg, 'utf8'));
    if (Number.isInteger(json.unity_port) && json.unity_port > 0) {
      return { port: json.unity_port, reloading: json.reloading === true };
    }
  } catch {
    /* not present or unreadable */
  }
  return undefined;
}

function portFromProject(projectPath) {
  if (!projectPath) return undefined;
  for (const relative of HEARTBEAT_CANDIDATES) {
    const heartbeat = readHeartbeat(path.join(projectPath, relative));
    if (heartbeat) return heartbeat.port;
  }
  return undefined;
}

/** Walk up from cwd looking for a project heartbeat. */
function portFromCwd(cwd) {
  let dir = cwd;
  for (let i = 0; i < 6; i += 1) {
    const port = portFromProject(dir);
    if (port !== undefined) return port;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

function resolvePort(explicit, projectPath) {
  const fromArg = Number.parseInt(explicit ?? '', 10);
  if (Number.isInteger(fromArg) && fromArg > 0) return fromArg;
  const fromEnv = Number.parseInt(process.env.UNITY_BRIDGE_PORT ?? '', 10);
  if (Number.isInteger(fromEnv) && fromEnv > 0) return fromEnv;
  // An explicit --project / --project-path wins over the cwd walk, so the CLI
  // works from any directory (CI, a parent folder, or an unrelated shell).
  const fromProject = portFromProject(projectPath);
  if (fromProject !== undefined) return fromProject;
  return portFromCwd(process.cwd());
}

/* ------------------------------------------------------------------ */
/* Framing                                                             */
/* ------------------------------------------------------------------ */

function writeFrame(socket, text) {
  const payload = Buffer.from(text, 'utf8');
  const header = Buffer.allocUnsafe(8);
  header.writeBigUInt64BE(BigInt(payload.length), 0);
  socket.write(Buffer.concat([header, payload]));
}

/**
 * Read exactly one framed message from a rolling buffer.
 * @returns {{ message: string, rest: Buffer } | undefined} undefined while incomplete.
 */
function readFrame(buffer) {
  if (buffer.length < 8) return undefined;
  const length = Number(buffer.readBigUInt64BE(0));
  if (length === 0) return { message: '', rest: buffer.subarray(8) };
  if (length > MAX_FRAME) throw new Error(`invalid frame length: ${length}`);
  if (buffer.length < 8 + length) return undefined;
  return {
    message: buffer.subarray(8, 8 + length).toString('utf8'),
    rest: buffer.subarray(8 + length),
  };
}

/* ------------------------------------------------------------------ */
/* Connection                                                          */
/* ------------------------------------------------------------------ */

let requestCounter = 0;
function nextRequestId() {
  requestCounter += 1;
  return `ntb-shim-${requestCounter}`;
}

/**
 * Open a bridge connection, perform the handshake, and resolve with a
 * `send(type, params)` function plus a `close()`.
 */
function connect(port, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    let buffer = Buffer.alloc(0);
    let greeted = false;
    let settled = false;
    const waiters = new Map();

    const fail = (error) => {
      if (settled) return;
      settled = true;
      for (const waiter of waiters.values()) waiter(undefined, error);
      waiters.clear();
      socket.destroy();
      reject(error);
    };

    const settle = () => {
      if (settled) return;
      settled = true;
      keepAliveTimer.unref?.();
      resolve({
        async send(type, params) {
          const requestId = nextRequestId();
          const body = JSON.stringify({ type, params: params ?? {}, request_id: requestId });
          const response = await new Promise((res, rej) => {
            const timer = setTimeout(() => {
              waiters.delete(requestId);
              rej(new Error(`Unity response timeout for ${type} (request_id=${requestId})`));
            }, timeoutMs);
            waiters.set(requestId, (text, error) => {
              clearTimeout(timer);
              if (error) rej(error);
              else res(text);
            });
            writeFrame(socket, body);
          });
          return response;
        },
        close() {
          socket.destroy();
        },
      });
    };

    socket.setNoDelay(true);
    socket.on('error', (error) => {
      if (!settled) {
        fail(new Error(`Unity TCP not reachable at 127.0.0.1:${port} (${error.message})`));
      }
    });
    socket.setTimeout(CONNECT_TIMEOUT_MS, () => {
      if (!settled) fail(new Error(`Unity TCP handshake timeout at 127.0.0.1:${port}`));
    });

    // keepalive: the bridge drops idle connections, so ping every 15s
    const keepAliveTimer = setInterval(() => {
      if (!settled) return;
      const requestId = nextRequestId();
      waiters.set(requestId, () => {});
      try {
        writeFrame(socket, JSON.stringify({ type: 'ping', params: {}, request_id: requestId }));
      } catch {
        /* ignore */
      }
    }, 15000);

    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);

      if (!greeted) {
        const newline = buffer.indexOf(0x0a);
        if (newline === -1 && buffer.length < 512) return;
        const greeting = buffer.subarray(0, newline === -1 ? buffer.length : newline).toString('ascii').trim();
        buffer = newline === -1 ? Buffer.alloc(0) : buffer.subarray(newline + 1);
        if (!greeting.includes('WELCOME UNITY-TCP') || !greeting.includes('FRAMING=1')) {
          fail(new Error(`Unity TCP handshake failed, expected "WELCOME UNITY-TCP ... FRAMING=1", got: ${greeting}`));
          return;
        }
        greeted = true;
        const versionMatch = greeting.match(/SERVER_VERSION=(\d+)/);
        const serverVersion = versionMatch ? Number.parseInt(versionMatch[1], 10) : 1;
        if (serverVersion >= 2) writeFrame(socket, 'CLIENT_VERSION=2');
        socket.setTimeout(0);
        settle();
      }

      for (;;) {
        const frame = readFrame(buffer);
        if (frame === undefined) break;
        buffer = frame.rest;
        if (frame.message === '') continue;
        let parsed;
        try {
          parsed = JSON.parse(frame.message);
        } catch {
          continue;
        }
        if (parsed && typeof parsed === 'object' && typeof parsed.request_id === 'string') {
          const waiter = waiters.get(parsed.request_id);
          if (waiter) {
            waiters.delete(parsed.request_id);
            waiter(frame.message);
            continue;
          }
        }
        // unmatched frames (notifications/pongs) are dropped
      }
    });

    socket.on('close', () => {
      for (const waiter of waiters.values()) waiter(undefined, new Error('bridge connection closed'));
      waiters.clear();
    });
  });
}

/* ------------------------------------------------------------------ */
/* Result normalisation                                                */
/* ------------------------------------------------------------------ */

/**
 * The bridge nests a tool payload inside `data`; unwrap the tool's own
 * `{success,message,data}` layer when present so callers see one flat object.
 */
function unwrap(rawText) {
  let envelope;
  try {
    envelope = JSON.parse(rawText);
  } catch {
    return { success: false, raw: rawText, errors: ['bridge returned non-JSON response'] };
  }
  const inner = envelope && typeof envelope.data === 'object' && envelope.data !== null ? envelope.data : envelope;
  return { envelope, inner };
}

function toEnvelope(command, rawText) {
  const { envelope, inner } = unwrap(rawText);
  if (envelope === undefined) {
    return { success: false, command, data: null, errors: inner.errors ?? ['invalid bridge response'], warnings: [] };
  }
  const success = inner && inner.success !== false && envelope.success !== false;
  const errors = [];
  if (!success) {
    const message = inner?.message ?? inner?.error ?? envelope?.message ?? 'unknown bridge error';
    errors.push(String(message));
  }
  const data = inner?.data !== undefined ? inner.data : inner ?? null;
  // `manage_editor` replies carry a sibling `state` next to `data`; keep it so
  // status can report the live editor/scene facts without a second round-trip.
  const state = inner && typeof inner.state === 'object' && inner.state !== null ? inner.state : null;
  return { success: Boolean(success), command, data, state, errors, warnings: [] };
}

function emit(envelope) {
  process.stdout.write(`${JSON.stringify(envelope)}\n`);
}

/* ------------------------------------------------------------------ */
/* Argument parsing                                                    */
/* ------------------------------------------------------------------ */

function parseArgs(argv) {
  const positional = [];
  const flags = { projectPath: undefined, port: undefined, format: undefined };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--project-path' || arg === '--project') {
      flags.projectPath = argv[++i];
    } else if (arg === '--port') {
      flags.port = argv[++i];
    } else if (arg === '--format') {
      flags.format = argv[++i];
    } else if (arg === '--non-interactive' || arg === '--no-banner' || arg === '--quiet') {
      /* accepted and ignored */
    } else if (arg === '--protocol') {
      flags.protocol = argv[++i];
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

/* ------------------------------------------------------------------ */
/* Live-Editor command routing (Codely bridge tools)                   */
/* ------------------------------------------------------------------ */

/** Well-known UI-level command names mapped to a bridge tool + action. */
const COMMAND_ALIASES = {
  editor_play: { type: 'manage_editor', params: { action: 'play' } },
  editor_pause: { type: 'manage_editor', params: { action: 'pause' } },
  editor_stop: { type: 'manage_editor', params: { action: 'stop' } },
  editor_step: { type: 'manage_editor', params: { action: 'step' } },
  save_scene: { type: 'manage_scene', params: { action: 'save' } },
  get_scene_hierarchy: { type: 'manage_scene', params: { action: 'get_hierarchy' } },
  read_console: { type: 'read_console', params: { action: 'get' } },
};

/**
 * Bridge parameters the tools deserialize through `as JArray` / `as JObject`.
 * A flat string makes that cast yield null, after which the parameter is
 * skipped while the reply still reports success — the silent-success trap that
 * {@link coerceParam} and {@link assertSupportedFlags} exist to close.
 */
const VECTOR3_PARAMS = new Set([
  'position', 'rotation', 'scale',
  'localPosition', 'localRotation', 'localScale',
  'center', 'size', 'velocity', 'eulerAngles',
]);
const STRING_ARRAY_PARAMS = new Set([
  'componentsToAdd', 'componentsToRemove',
  // Batch/selection lists the bridge also reads through `as JArray`. A single
  // bare value here used to fall back to the full unfiltered set, so
  // `read_console --types warning` returned errors and logs as well.
  'types', 'paths', 'assets', 'keywords', 'include_passes',
  'shader_names', 'material_paths',
  // `imports` is a `string[]` on the C# side, so a flat string fails to
  // deserialize the whole call ("Error converting value ... to type
  // 'System.String[]'"). It also *replaces* the default using list rather than
  // extending it — see the SKILL note before reaching for it.
  'imports',
]);
const OBJECT_PARAMS = new Set([
  'componentProperties', 'properties', 'options', 'focus_object', 'record_game_view',
]);

/** Keys the bridge reads out of a `focus_object` object (ManageScreenshot.cs:1347-1362). */
function normalizeFocusObject(value) {
  if (typeof value === 'string') {
    // `--focus_object Page` is the only shape a CLI can express without JSON,
    // and it used to be dropped: the cast to JObject yields null, the whole
    // block is skipped, and the capture silently frames the full scene bounds.
    return { focusobject: value };
  }
  return value;
}

/**
 * Target parameters the command line accepts but the bridge never reads, mapped
 * to the pair that actually addresses an object. `manage_gameobject` only looks
 * at `target` plus `searchMethod`; `--instanceId 123` therefore left `target`
 * empty and the reply was "Target GameObject ('') not found".
 */
const TARGET_ALIASES = {
  instanceId: (value) => ({ target: value, searchMethod: 'by_id' }),
  instanceID: (value) => ({ target: value, searchMethod: 'by_id' }),
  targetPath: (value) => ({ target: value, searchMethod: 'by_path' }),
};

/**
 * Rewrite the alias target flags into the `target` + `searchMethod` pair the
 * bridge understands, keeping an explicit `searchMethod` if one was given.
 * @param command - the bridge tool name.
 * @param params - the resolved params object, mutated in place.
 */
function applyTargetAliases(command, params) {
  if (command !== 'manage_gameobject') return;
  for (const [alias, build] of Object.entries(TARGET_ALIASES)) {
    if (params[alias] === undefined) continue;
    const mapped = build(params[alias]);
    delete params[alias];
    if (params.target === undefined) params.target = mapped.target;
    if (params.searchMethod === undefined) params.searchMethod = mapped.searchMethod;
  }
}

/** Bridge tools that run C# through `ExecuteCSharpScript`. */
const SCRIPT_COMMANDS = new Set(['execute_csharp_script', 'exec_editor_script', 'exec_runtime_script']);

/** Extensions the bridge accepts for scene files. */
const SCENE_EXTENSIONS = ['.scene', '.unity'];

/**
 * The `using` list `ExecuteCSharpScript.cs:323-332` falls back to when
 * `imports` is omitted.
 *
 * The bridge *replaces* that list with whatever the caller sends (see the
 * comment at `:334`), so `--imports System.Text` alone made even `Application`
 * unresolvable and the whole script failed to compile — the opposite of what
 * "add an import" is taken to mean.
 */
const DEFAULT_SCRIPT_IMPORTS = [
  'System',
  'System.Linq',
  'System.Collections.Generic',
  'UnityEngine',
  'UnityEditor',
  'UnityEditor.SceneManagement',
  'UnityEngine.SceneManagement',
];

/**
 * Merge caller-supplied `imports` with the bridge defaults instead of replacing
 * them, so adding one namespace does not quietly drop `UnityEngine`.
 * @param command - the bridge tool name.
 * @param params - the resolved params object, mutated in place.
 */
function applyScriptImports(command, params) {
  if (!SCRIPT_COMMANDS.has(command)) return;
  const supplied = params.imports;
  if (!Array.isArray(supplied)) return;
  const merged = [...DEFAULT_SCRIPT_IMPORTS];
  for (const entry of supplied) {
    const name = String(entry);
    if (name.length > 0 && !merged.includes(name)) merged.push(name);
  }
  params.imports = merged;
}

/**
 * Split a full scene file path into the `name` + `path` directory pair the
 * bridge actually builds a path from.
 *
 * ManageScene.cs:143-152 assembles `Assets/<path>/<name><ext>` and ignores the
 * file name inside `path`, so `--path Assets/Scenes/Foo.scene` without `--name`
 * left `sceneFileName` null, produced a null `relativePath`, and the `load`
 * handler reported "Either 'name'/'path' or 'buildIndex' must be provided" --
 * an error that points at a parameter the caller did supply.
 * @param value - the raw `--path` value.
 * @returns the split, or undefined when the value is not a scene file path.
 */
function splitScenePath(value) {
  const normalized = String(value).replace(/\\/gu, '/').trim();
  const lower = normalized.toLowerCase();
  const extension = SCENE_EXTENSIONS.find((candidate) => lower.endsWith(candidate));
  if (extension === undefined) return undefined;
  const withoutExtension = normalized.slice(0, normalized.length - extension.length);
  const slash = withoutExtension.lastIndexOf('/');
  const name = slash === -1 ? withoutExtension : withoutExtension.slice(slash + 1);
  if (name.length === 0) return undefined;
  let directory = slash === -1 ? '' : withoutExtension.slice(0, slash);
  if (directory.toLowerCase().startsWith('assets/')) {
    directory = directory.slice('assets/'.length);
  } else if (directory.toLowerCase() === 'assets') {
    directory = '';
  }
  return { name, path: directory };
}

/**
 * The extension `manage_screenshot` captures actually write.
 *
 * Verified against bridge 1.0.80: the C# side appends `.png` to `filename`
 * unconditionally — `--filename ext__C.jpg` produced `ext__C.jpg.png` — so a
 * capture is always a PNG no matter what extension the caller names. Only
 * `.png` is therefore treated as "this `--path` is a file"; renaming
 * `Foo.jpg` to `Foo.png` behind the caller's back would misreport the format.
 */
const SCREENSHOT_EXTENSION = '.png';

/**
 * Image extensions that look like a capture output but cannot be one, because
 * the bridge appends `.png` to `filename` no matter what it was given.
 */
const NON_PNG_IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.tga', '.exr'];

/**
 * Split a full file path into the `path` directory + `filename` basename pair
 * `manage_screenshot` actually builds a path from.
 *
 * ManageScreenshot.cs reads `path` as a directory and joins `filename` onto it,
 * so `--path screenshots/Foo.png` with no `--filename` wrote
 * `screenshots/Foo.png/SceneView_<timestamp>.png`: the file name became a
 * directory, and the reply's `path` pointed at the wrong place. This is the same
 * trap `splitScenePath` fixes for `manage_scene`.
 *
 * The file name is only lifted out of `path` when it ends in `.png`, so
 * `--path screenshots/latest` keeps naming a directory and a recording path
 * such as `rec.gif` is left for the bridge to interpret.
 * @param value - the raw `--path` value.
 * @returns the split, or undefined when the value names no file.
 */
function splitScreenshotPath(value) {
  const normalized = String(value).replace(/\\/gu, '/').trim();
  if (!normalized.toLowerCase().endsWith(SCREENSHOT_EXTENSION)) return undefined;
  const withoutExtension = normalized.slice(0, normalized.length - SCREENSHOT_EXTENSION.length);
  const slash = withoutExtension.lastIndexOf('/');
  const filename = slash === -1 ? withoutExtension : withoutExtension.slice(slash + 1);
  if (filename.length === 0) return undefined;
  return { filename: `${filename}${SCREENSHOT_EXTENSION}`, path: slash === -1 ? '' : withoutExtension.slice(0, slash) };
}

/**
 * Rewrite a full path into the `path` + file-name form the tool needs, so
 * `--path Assets/Scenes/Foo.scene` works on load/create/save and
 * `--path screenshots/Foo.png` writes `Foo.png` instead of a directory.
 * @param command - the bridge tool name.
 * @param params - the resolved params object, mutated in place.
 */
function applyScenePath(command, params) {
  if (command === 'manage_screenshot') {
    // Only the capture actions take a `path` + `filename` pair; the recording
    // actions keep their own naming, so leave them alone.
    const action = typeof params.action === 'string' ? params.action.toLowerCase() : '';
    if (!action.startsWith('capture')) return;
    // `capture_game_view` is rejected outright by `assertSupportedFlags`, which
    // runs after this; leaving it alone keeps that more accurate error first.
    if (action === 'capture_game_view') return;
    if (typeof params.path !== 'string' || params.filename !== undefined) return;
    const lowered = params.path.toLowerCase();
    const unusable = NON_PNG_IMAGE_EXTENSIONS.find((extension) => lowered.endsWith(extension));
    if (unusable !== undefined) {
      throw new Error(
        `'--path ${params.path}' looks like a file, but capture actions always write PNG: the bridge appends '.png' to --filename regardless of the extension it is given. Use --path <same name>.png, or pass a directory and let the timestamped name stand.`,
      );
    }
    const screenshot = splitScreenshotPath(params.path);
    if (screenshot === undefined) return;
    params.filename = screenshot.filename;
    params.path = screenshot.path;
    return;
  }
  if (command !== 'manage_scene') return;
  const action = typeof params.action === 'string' ? params.action.toLowerCase() : undefined;
  if (action !== 'load' && action !== 'create' && action !== 'save') return;
  if (typeof params.path !== 'string') return;
  const split = splitScenePath(params.path);
  if (split === undefined) return;
  if (params.name === undefined) params.name = split.name;
  params.path = split.path;
}

/** Flags no bridge tool reads, mapped to the parameter that actually works. */
const FLAG_REDIRECTS = {
  output: "'--output' is not a bridge parameter and is ignored; use --path <directory> and --filename <name>, then read data.path from the reply",
  out: "'--out' is not a bridge parameter and is ignored; use --path <directory> and --filename <name>",
  file: "'--file' is not a bridge parameter and is ignored; use --filename",
  dir: "'--dir' is not a bridge parameter and is ignored; use --path",
  save: "'--save' is not a bridge parameter and is ignored; use manage_scene --action save, or --filename for screenshots",
};

/** Actions that address an existing object, where `--name` matches nothing. */
const TARGETING_ACTIONS = new Set([
  'modify', 'delete', 'find', 'get_components', 'add_component',
  'remove_component', 'set_component_property', 'list_children',
]);

/** Parse "1,2,3" / "1 2 3" / "[1,2,3]" into a number triple. */
function parseVector3(text) {
  const cleaned = String(text).trim().replace(/^\[/u, '').replace(/\]$/u, '');
  const parts = cleaned.split(/[,;\s]+/u).filter((part) => part.length > 0);
  if (parts.length !== 3) return undefined;
  const numbers = parts.map((part) => Number(part));
  if (numbers.some((value) => !Number.isFinite(value))) return undefined;
  return numbers;
}

/**
 * Coerce one flag value to the JSON type its tool deserializes, so `--position
 * "1,2,3"` and `--componentsToAdd BoxCollider` reach the bridge as the array it
 * expects instead of being dropped. Values that cannot be converted raise an
 * actionable error rather than being forwarded as a silently ignored string.
 * @param key - the flag name without its leading dashes.
 * @param raw - the raw string the caller supplied.
 * @returns the JSON value to place in the request params.
 */
function coerceParam(key, raw) {
  const text = String(raw);
  if (VECTOR3_PARAMS.has(key)) {
    const triple = parseVector3(text);
    if (triple === undefined) {
      throw new Error(`'--${key}' expects three numbers, e.g. --${key} "[1,2,3]" (got ${JSON.stringify(text)}); the bridge would otherwise ignore it and still report success`);
    }
    return triple;
  }
  if (STRING_ARRAY_PARAMS.has(key)) {
    if (text.startsWith('[')) {
      try {
        const parsed = JSON.parse(text);
        if (Array.isArray(parsed)) return parsed;
      } catch {
        /* fall through to the comma-separated form */
      }
    }
    // `--types warning,log` is the natural way to write a multi-value flag; a
    // value containing no separator stays a single-element array.
    const parts = text.split(',').map((part) => part.trim()).filter((part) => part.length > 0);
    return parts.length > 1 ? parts : [coerce(text)];
  }
  if (OBJECT_PARAMS.has(key)) {
    try {
      const parsed = JSON.parse(text);
      if (parsed !== null && typeof parsed === 'object') {
        if (key === 'focus_object') return normalizeFocusObject(parsed);
        if (key === 'componentProperties') return normalizeComponentProperties(parsed);
        return parsed;
      }
    } catch {
      /* fall through */
    }
    // `--focus_object <object name>` is a natural thing to type and the bridge
    // silently ignores it as a non-object, so accept the bare name.
    if (key === 'focus_object' && text.length > 0) return normalizeFocusObject(text);
    throw new Error(`'--${key}' expects a JSON object, e.g. --${key} '{"m_LocalPosition.x":0}'; the bridge would otherwise ignore it and still report success`);
  }
  if (key === 'ops') return coerceOps(text);
  if (key === 'propertyValue') return coercePropertyValue(text);
  return coerce(text);
}

/**
 * Normalize the `--propertyValue` of `set_component_property` / `modify`.
 *
 * The bridge resolves the value through `SetProperty` → `ConvertJTokenToType`,
 * whose struct fast-paths only accept `JObject{x,y,z}` or `JArray`
 * (`ManageGameObject.cs:2944-2953`). A plain string therefore falls through to
 * `return Vector3.zero` and the assignment *succeeds with a zeroed value* —
 * `--propertyValue "1,2,3"` wipes `center`/`size`/`offset` while still replying
 * `success: true`. Hand the bridge the array form it can actually read.
 *
 * Only a bare numeric tuple is rewritten; anything JSON-looking is parsed as-is
 * and everything else keeps its scalar type. To set a *string* property whose
 * text happens to look like a tuple, quote it: --propertyValue '"1,2,3"'.
 * @param text - the raw value string.
 * @returns the JSON value to send.
 */
function coercePropertyValue(text) {
  const trimmed = text.trim();
  const quote = trimmed.charAt(0);
  if (quote === '"' || quote === "'") {
    // A caller that quotes a tuple wants the literal string, not an array; strip
    // the surrounding quotes so the property receives `1,2,3` rather than
    // `"1,2,3"`. Both quote styles are accepted because documentation examples
    // use either.
    const doubleQuoted = quote === '"';
    try {
      const parsed = doubleQuoted ? JSON.parse(trimmed) : undefined;
      if (typeof parsed === 'string') return parsed;
    } catch {
      /* not valid JSON quoting — strip manually below */
    }
    const body = trimmed.slice(1, -1);
    return doubleQuoted ? body.replace(/\\"/gu, '"') : body.replace(/''/gu, "'");
  }
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    return coerce(trimmed);
  }
  const parts = trimmed.split(/[,;\s]+/u).filter((part) => part.length > 0);
  if (parts.length >= 2 && parts.length <= 4) {
    const numbers = parts.map((part) => Number(part));
    if (numbers.every((value) => Number.isFinite(value))) return numbers;
  }
  return coerce(trimmed);
}

/**
 * @returns whether `text` is a bare numeric tuple such as `1,2,3`.
 */
function looksLikeTuple(text) {
  const parts = String(text).trim().split(/[,;\s]+/u).filter((part) => part.length > 0);
  if (parts.length < 2 || parts.length > 4) return false;
  return parts.every((part) => Number.isFinite(Number(part)));
}

/**
 * Rewrite tuple-looking strings buried inside `--componentProperties`.
 *
 * `modify` reads `componentProperties[<ComponentName>]` as a nested object
 * (`ManageGameObject.cs:846-857`), so `{"BoxCollider":{"center":"1,2,3"}}`
 * reaches the same `ParseJTokenToVector3` that zeroes plain strings. Recursing
 * here keeps the two containers consistent — otherwise the same value works via
 * `set_component_property` but silently zeroes via `modify`.
 * @param value - the parsed `--componentProperties` value.
 * @returns a copy with nested tuple strings converted to arrays.
 */
function normalizeComponentProperties(value) {
  if (value === null || typeof value !== 'object') return value;
  const walk = (node) => {
    if (Array.isArray(node)) return node.map((entry) => walk(entry));
    if (node === null || typeof node !== 'object') return node;
    const out = {};
    for (const [key, entry] of Object.entries(node)) {
      if (typeof entry === 'string') {
        // Only touch tuple-looking strings. Coercing every string would turn
        // `{"mode":"2"}` into a number and `{"enabled":"true"}` into a bool,
        // which the bridge already handles — but it would also mangle a string
        // property whose text is a bare number.
        out[key] = looksLikeTuple(entry) ? coercePropertyValue(entry) : entry;
      } else {
        out[key] = walk(entry);
      }
    }
    return out;
  };
  return walk(value);
}

/**
 * Parse a batch `--ops` array and normalize each op's nested params.
 * Batch ops are deserialized by the same per-action handlers as single calls,
 * so a vector written as `"position":"3,3,3"` inside an op is dropped exactly
 * like a top-level one — the batch reply then reports "No modifications
 * applied" while `success` stays true.
 * @param text - the raw JSON array given to `--ops`.
 * @returns the parsed ops with every nested param coerced.
 */
function coerceOps(text) {
  let ops;
  try {
    ops = JSON.parse(text);
  } catch (error) {
    throw new Error(`'--ops' expects a JSON array of {action, params, captureAs} objects (${error.message})`);
  }
  if (!Array.isArray(ops)) throw new Error("'--ops' expects a JSON array of {action, params, captureAs} objects");
  return ops.map((op, index) => {
    if (op === null || typeof op !== 'object' || Array.isArray(op)) {
      throw new Error(`'--ops' entry ${index} must be an object, got ${JSON.stringify(op)}`);
    }
    const nested = op.params;
    if (nested !== undefined && nested !== null && typeof nested === 'object' && !Array.isArray(nested)) {
      const normalized = {};
      for (const [nestedKey, nestedValue] of Object.entries(nested)) {
        if (typeof nestedValue === 'string' && needsCoercion(nestedKey)) {
          normalized[nestedKey] = coerceParam(nestedKey, nestedValue);
        } else if (nestedKey === 'componentProperties') {
          // Inside `--ops` the caller usually writes the object literally, so it
          // arrives already parsed and never reaches coerceParam's string path.
          normalized[nestedKey] = normalizeComponentProperties(nestedValue);
        } else {
          normalized[nestedKey] = nestedValue;
        }
      }
      return { ...op, params: normalized };
    }
    return op;
  });
}

/** @returns whether `key` is one whose string form loses information. */
function needsCoercion(key) {
  return VECTOR3_PARAMS.has(key) || STRING_ARRAY_PARAMS.has(key) || OBJECT_PARAMS.has(key)
    || key === 'ops' || key === 'propertyValue';
}

function coerce(text) {
  if (text === 'true') return true;
  if (text === 'false') return false;
  if (/^-?\d+$/u.test(text)) return Number.parseInt(text, 10);
  if (/^-?\d*\.\d+$/u.test(text)) return Number.parseFloat(text);
  if ((text.startsWith('{') && text.endsWith('}')) || (text.startsWith('[') && text.endsWith(']'))) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  return text;
}

/** Collect `--flag value` / `--flag` / `--flag=value` pairs, rejecting repeats. */
function collectFlags(rawArgs) {
  const params = {};
  const seen = new Set();
  for (let i = 0; i < rawArgs.length; i += 1) {
    const token = rawArgs[i];
    if (!token.startsWith('--')) continue;
    const body = token.slice(2);
    // `--name=X` used to be stored whole as a flag called `name=X`, so the real
    // parameter stayed absent and the tool reported a missing-parameter error
    // (or silently ignored it). Split the equals form before anything else.
    const equals = body.indexOf('=');
    const key = equals === -1 ? body : body.slice(0, equals);
    // A repeated flag used to overwrite the earlier value, so
    // `--target A --target B` silently processed only B. Fail instead.
    if (seen.has(key)) {
      throw new Error(`'--${key}' was given more than once; the bridge keeps only the last value, so call the command once per target (or pass a JSON array where the tool documents one)`);
    }
    seen.add(key);
    if (equals !== -1) {
      params[key] = coerceParam(key, body.slice(equals + 1));
      continue;
    }
    const next = rawArgs[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      params[key] = coerceParam(key, next);
      i += 1;
    } else {
      params[key] = true;
    }
  }
  return params;
}

/**
 * Reject flag/action combinations the bridge accepts but silently does nothing
 * with, so a mistyped call fails loudly instead of returning a false success.
 * @param command - the bridge tool name.
 * @param action - its action positional, when one was given.
 * @param params - the resolved params object.
 */
function assertSupportedFlags(command, action, params) {
  if (command === 'manage_screenshot' && action === 'capture_game_view') {
    throw new Error("'capture_game_view' is disabled by the bridge; use manage_gameview, or exec_runtime_script with record_game_view, for Play Mode capture");
  }
  for (const key of Object.keys(params)) {
    const redirect = FLAG_REDIRECTS[key];
    if (redirect !== undefined) throw new Error(redirect);
  }
  if (command === 'manage_gameobject' && action !== undefined && TARGETING_ACTIONS.has(action)) {
    const hasTarget = params.target !== undefined || params.instanceId !== undefined;
    if (!hasTarget && params.name !== undefined) {
      throw new Error(`'${action}' addresses an existing object: use --target "<name>" (or --instanceId <id>), not --name. '--name' only applies to create, so it was ignored and the lookup matched nothing.`);
    }
  }
}

/** Actions that rewrite state, where a call carrying no writable field is a no-op. */
const WRITE_ACTIONS = new Set(['modify']);

/**
 * Reject `apply_text_edits` entries the bridge would silently apply at the top
 * of the file. Each edit is read as `startLine`/`startCol`/`endLine`/`endCol`
 * plus `newText`; a missing or non-numeric field falls back to line 1 column 1,
 * so an edit written as `{oldText, newText}` (a plausible guess, and what the
 * `anchor_insert`/`replace` actions use elsewhere) inserts its text at the very
 * start of the file and still reports `editsApplied: 1`.
 * @param command - the bridge tool name.
 * @param action - its action positional, when one was given.
 * @param params - the resolved params object.
 */
function assertTextEdits(command, action, params) {
  if (command !== 'manage_script' || action !== 'apply_text_edits') return;
  const edits = params.edits;
  if (!Array.isArray(edits)) return;
  if (edits.length === 0) {
    throw new Error(`'--edits' is an empty array, so nothing would be written; pass at least one {startLine,startCol,endLine,endCol,newText} entry`);
  }
  edits.forEach((edit, index) => {
    if (edit === null || typeof edit !== 'object' || Array.isArray(edit)) {
      throw new Error(`'--edits' entry ${index} must be an object with startLine/startCol/endLine/endCol and newText`);
    }
    const missing = ['startLine', 'startCol', 'endLine', 'endCol'].filter(
      (field) => typeof edit[field] !== 'number' || !Number.isInteger(edit[field]),
    );
    if (missing.length === 0) return;
    const hint = Object.keys(edit).length > 0 ? `; got ${JSON.stringify(edit)}` : '';
    throw new Error(`'--edits' entry ${index} is missing an integer ${missing.join('/')}${hint}. The bridge falls back to line 1 column 1 for missing coordinates, so this edit would be inserted at the top of the file instead of in place.`);
  });
}

/** Flags the CLI itself consumes; they never travel to the bridge. */
const CLI_ONLY_FLAGS = new Set(['port', 'projectPath']);

/**
 * Accepted flags per bridge tool, taken from the bridge sources' own
 * `params["..."]` reads (bridge 1.0.80). A mistyped flag used to be forwarded
 * verbatim and dropped by the bridge: `manage_asset search --filterTypo X`
 * looked up nothing and returned every asset in the project instead of failing.
 *
 * The list is deliberately a little over-permissive — it also carries keys the
 * tools only ever emit — because rejecting a flag the bridge really reads would
 * be worse than letting one typo through.
 */
const BRIDGE_TOOL_PARAMS = {
  manage_editor: [
    'action', 'clearCache', 'include_console', 'includeConsole', 'layerName', 'singleFrame',
    'tagName', 'targetPaused', 'timeoutSeconds', 'toolName', 'windowType',
  ],
  manage_scene: [
    'action', 'build_index', 'buildIndex', 'loadAdditive', 'name', 'path',
  ],
  manage_gameobject: [
    'action', 'allowFailure', 'captureAs', 'component', 'component_type', 'componentName',
    'componentProperties', 'componentsToAdd', 'componentsToRemove', 'componentType', 'depth',
    'find', 'findAll', 'hierarchy_path', 'id', 'includeInactive', 'includeNonPublicSerialized',
    'inlineLimit', 'instanceID', 'layer', 'material', 'maxDepth', 'maxInlineItems', 'mesh',
    'mode', 'name', 'ops', 'outputPath', 'params', 'parent', 'path', 'position', 'prefab',
    'prefabPath', 'primitiveType', 'properties', 'propertyName', 'propertyValue', 'ref',
    'resultMode', 'rotation', 'saveAsPrefab', 'scale', 'searchInChildren', 'searchInactive',
    'searchMethod', 'searchTerm', 'selectAll', 'setActive', 'sprite', 'tag', 'target',
    'targetRef', 'typeName',
  ],
  manage_asset: [
    'action', 'assetType', 'bounceCombine', 'bounciness', 'color', 'destination',
    'dynamicFriction', 'filterDateAfter', 'filterType', 'float', 'frictionCombine',
    'generatePreview', 'metallic', 'name', 'pageNumber', 'pageSize', 'path', 'properties',
    'scriptClass', 'searchPattern', 'shader', 'smoothness', 'staticFriction', 'texture', 'value',
  ],
  manage_script: [
    'action', 'applyMode', 'className', 'contents', 'contentsEncoded', 'edits', 'encodedContents',
    'level', 'methodName', 'mode', 'name', 'namespace', 'options', 'path', 'precondition_sha256',
    'refresh', 'replacement', 'scriptType', 'validate', 'validationLevel',
  ],
  manage_shader: [
    'action', 'frames', 'include_passes', 'keywords', 'material', 'material_guid',
    'material_path', 'material_paths', 'mesh', 'paths', 'resolution', 'shader',
    'shader_for_srp', 'shader_names', 'timeout_seconds', 'variant_mode',
  ],
  manage_screenshot: [
    'action', 'allow_static_in_play_mode', 'allowStaticInPlayMode', 'as_gif', 'assets',
    'camera_name', 'document_path', 'duration_seconds', 'durationSeconds', 'ffmpeg_path',
    'filename', 'focus_object', 'focusobject', 'fps', 'height', 'index', 'orthographic',
    'over_time', 'path', 'recording_id', 'render_mode', 'scale', 'scene', 'start_delay',
    'startDelay', 'static_reason', 'staticReason', 'view', 'width',
  ],
  manage_input: [
    'action', 'button', 'delay_after', 'drag_speed', 'from_x', 'from_y', 'key', 'scroll_x',
    'scroll_y', 'start_delay', 'step', 'step_delay', 'steps', 'stop_on_error', 'target', 'text',
    'x', 'y',
  ],
  manage_package: ['action', 'id_or_url', 'package_name', 'timeoutSeconds', 'version'],
  manage_bake: ['action', 'async', 'timeoutSeconds'],
  manage_dialog: ['action', 'button', 'title'],
  manage_job: ['action', 'id', 'job_id', 'reason'],
  manage_window_bridge: [
    'action', 'allowPortFallback', 'alt', 'button', 'code', 'ctrl', 'deltaX', 'deltaY',
    'eventType', 'fps', 'height', 'instanceID', 'key', 'meta', 'port', 'shift', 'text', 'title',
    'width', 'windowId', 'windowType', 'x', 'y',
  ],
  manage_gameview: ['action', 'height', 'width'],
  read_console: [
    'action', 'count', 'filterText', 'format', 'includeStacktrace', 'scope', 'sinceTimestamp', 'types',
  ],
  execute_menu_item: [
    'action', 'alias', 'filter', 'include_separators', 'includeSeparators', 'menu_path',
    'menuPath', 'parameters', 'search', 'timeout_ms',
  ],
};
/** Every `exec_*_script` variant reads the same parameter set. */
for (const name of ['execute_csharp_script', 'exec_editor_script', 'exec_runtime_script']) {
  BRIDGE_TOOL_PARAMS[name] = [
    'action', 'capture_logs', 'description', 'enable_repl', 'execution_mode', 'imports',
    'record_game_view', 'script', 'script_path', 'script_session_id', 'summary',
    'timeoutSeconds', 'unlock_domain_reload',
  ];
}

/** @returns the Levenshtein distance between two short strings. */
function editDistance(a, b) {
  const rows = Array.from({ length: b.length + 1 }, (_, i) => [i]);
  for (let i = 1; i <= a.length; i += 1) {
    rows[0][i] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1].toLowerCase() === b[j - 1].toLowerCase() ? 0 : 1;
      rows[j][i] = Math.min(rows[j - 1][i] + 1, rows[j][i - 1] + 1, rows[j - 1][i - 1] + cost);
    }
  }
  return rows[b.length][a.length];
}

/**
 * Reject flags the target tool never reads. The bridge ignores unknown keys
 * silently, so `--filterTypo UnitDefinition` looked like a working filter while
 * the call returned all 4352 assets, and `--position` misspelled as `--postion`
 * left the object where it was.
 * @param command - the bridge tool name.
 * @param params - the resolved params object.
 */
function assertKnownFlags(command, params) {
  const known = BRIDGE_TOOL_PARAMS[command];
  if (known === undefined) return;
  const accepted = new Set(known);
  for (const key of Object.keys(params)) {
    if (accepted.has(key) || CLI_ONLY_FLAGS.has(key)) continue;
    const suggestion = known
      .map((candidate) => ({ candidate, distance: editDistance(key, candidate) }))
      .filter((entry) => entry.distance <= Math.max(2, Math.floor(key.length / 3)))
      .sort((left, right) => left.distance - right.distance)[0];
    const hint = suggestion === undefined ? '' : ` Did you mean '--${suggestion.candidate}'?`;
    throw new Error(`'--${key}' is not a parameter of '${command}', so the bridge would ignore it and still report success.${hint} Accepted: ${known.join(', ')}`);
  }
}

/** Parameters that only locate the target, never change it. */
const LOCATOR_PARAMS = new Set([
  'action', 'target', 'instanceId', 'targetRef', 'name' /* for create */,
  'searchMethod', 'findAll', 'includeInactive', 'searchInactive', 'maxDepth',
  'inlineLimit', 'resultMode', 'mode', 'ops', 'projectPath', 'port',
]);

/**
 * Reject a write call that carries no writable parameter. `modify` with only a
 * target returns success and the object's current state, which reads exactly
 * like a successful edit that happened to change nothing.
 * @param command - the bridge tool name.
 * @param action - its action positional, when one was given.
 * @param params - the resolved params object.
 */
function assertWritable(command, action, params) {
  if (command !== 'manage_gameobject' || action === undefined || !WRITE_ACTIONS.has(action)) return;
  const target = params.target === undefined ? '' : String(params.target);
  const writable = Object.keys(params).filter((key) => {
    // `name` locates the object on create but renames it on modify, so it only
    // counts as a locator when it is the target being addressed.
    if (key === 'name') return target.length === 0 || String(params.name) !== target;
    return !LOCATOR_PARAMS.has(key);
  });
  if (writable.length > 0) return;
  throw new Error(`'${action}' was given no writable parameter, so nothing would change; pass at least one of --position/--rotation/--scale/--name/--tag/--layer/--setActive/--parent/--componentName/--componentProperties`);
}

/**
 * `modify` silently ignores component property writes given as
 * `--componentName X --propertyName Y --propertyValue Z`. Measured on bridge
 * 1.0.80 with a *valid* component (BoxCollider on a live object): the call
 * returns `success: true`, the envelope even echoes the object, and the field
 * keeps its old value. Only `set_component_property` (one field) and
 * `modify --componentProperties {"Component":{"prop":value}}` are wired to the
 * property writer. Reject the shape instead of letting it read as an edit.
 * @param command - the bridge tool name.
 * @param action - its action positional.
 * @param params - the resolved params object.
 */
function assertComponentWriteShape(command, action, params) {
  if (command !== 'manage_gameobject' || action !== 'modify') return;
  const used = ['componentName', 'propertyName', 'propertyValue'].filter((key) => params[key] !== undefined);
  if (used.length === 0) return;
  const flagged = used.map((key) => `--${key}`).join('/');
  throw new Error(`'modify' ignores ${flagged}, so this call would report success and change nothing; write one field with the 'set_component_property' action, or several with 'modify --componentProperties {"Component":{"prop":value}}'`);
}

/**
 * Bridge messages that mean "the call was accepted but nothing was written".
 * They arrive with `success: true`, so a caller that trusts only the flag
 * believes a write landed. Each pattern here downgrades the envelope.
 */
const NO_OP_MESSAGES = [
  { pattern: /No modifications applied/iu, reason: 'the target matched but no parameter changed it' },
  { pattern: /0 targets found/iu, reason: 'the target lookup matched nothing' },
  { pattern: /early-stopped \(0 targets found\)/iu, reason: 'the batch stopped because no target matched' },
  { pattern: /not found using method/iu, reason: 'the target lookup matched nothing' },
  { pattern: /is required/iu, reason: 'a required parameter was missing' },
  { pattern: /is missing or empty/iu, reason: 'a required parameter was missing' },
];

/**
 * Turn a "reported success, wrote nothing" reply into a failure and collect the
 * nested per-op failures a batch hides behind its own top-level `success`.
 * @param command - the command name, echoed into the rewritten envelope.
 * @param envelope - the envelope built from the bridge reply.
 * @returns the same envelope, possibly downgraded, with warnings attached.
 */
function annotateNoOp(command, envelope, request) {
  if (envelope === null || typeof envelope !== 'object') return envelope;
  const warnings = Array.isArray(envelope.warnings) ? envelope.warnings : [];
  const candidates = [];
  const data = envelope.data;
  if (data !== null && typeof data === 'object') {
    if (Array.isArray(data.results)) {
      for (const result of data.results) {
        if (result !== null && typeof result === 'object') candidates.push(result.message);
      }
    }
    candidates.push(data.message);
  }
  for (const message of candidates) {
    if (typeof message !== 'string' || message.length === 0) continue;
    for (const rule of NO_OP_MESSAGES) {
      if (!rule.pattern.test(message)) continue;
      envelope.success = false;
      const errors = Array.isArray(envelope.errors) ? envelope.errors : [];
      const annotated = `${message} — ${rule.reason}`;
      // toEnvelope already pushed the raw message when the bridge itself failed;
      // rewrite that entry in place so one failure reads as one line, not two
      // near-identical ones.
      const index = errors.indexOf(message);
      envelope.errors = index === -1 ? [...errors, annotated] : errors.map((entry, i) => (i === index ? annotated : entry));
      break;
    }
  }
  // `find` answers with an empty array when nothing matched — a legal result
  // shape that carries no message, so the rules above never see it and a typo'd
  // object name came back as a plain success with an empty list.
  if (request?.params?.action === 'find' && envelope.success === true && Array.isArray(envelope.data) && envelope.data.length === 0) {
    const target = request?.params?.target;
    warnings.push(`no object matched ${typeof target === 'string' && target.length > 0 ? `'${target}'` : 'the given search'}`);
  }
  if (warnings.length !== (envelope.warnings ?? []).length) envelope.warnings = warnings;
  return envelope;
}

/** Build a bridge request from a CLI command name plus `--flag value` pairs. */
function commandToRequest(command, rawArgs) {
  // `custom.*` tools are not bridge command types; they go through
  // execute_custom_tool, and ExecuteCustomTool.cs:74 reads the argument object
  // from `parameters` — the old cold path sent `arguments`, which the bridge
  // ignores, so every custom tool received an empty argument set and reported
  // its own "'x' parameter is required" no matter what the caller passed.
  if (command.startsWith('custom.')) {
    const toolName = command.slice('custom.'.length);
    const params = collectFlags(rawArgs);
    return {
      type: 'execute_custom_tool',
      params: { tool_name: toolName, parameters: params },
      warnings: [],
    };
  }

  const alias = COMMAND_ALIASES[command];
  if (alias !== undefined) {
    // Aliases still accept overrides, e.g. `read_console --count 50`.
    const params = { ...alias.params, ...collectFlags(rawArgs) };
    applyTargetAliases(command, params);
    applyScenePath(alias.type, params);
    applyScriptImports(alias.type, params);
    assertKnownFlags(alias.type, params);
    // Keyed on the bridge tool (`alias.type`), not the UI alias: keyed on the
    // alias name, the `capture_game_view` guard below never fired for any
    // alias, because no alias is literally named `manage_screenshot`.
    assertSupportedFlags(alias.type, alias.params.action, params);
    assertComponentWriteShape(alias.type, alias.params.action, params);
    assertTextEdits(alias.type, alias.params.action, params);
    return { type: alias.type, params, warnings: [] };
  }

  // A bare `action` positional (e.g. `unity command manage_scene get_hierarchy`)
  const action = rawArgs.length > 0 && !rawArgs[0].startsWith('--') ? rawArgs[0] : undefined;
  const params = collectFlags(rawArgs);
  if (action !== undefined && params.action === undefined) params.action = action;
  applyTargetAliases(command, params);
  applyScenePath(command, params);
  applyScriptImports(command, params);
  assertKnownFlags(command, params);
  assertSupportedFlags(command, action ?? params.action, params);
  assertWritable(command, action ?? params.action, params);
  assertComponentWriteShape(command, action ?? params.action, params);
  assertTextEdits(command, action ?? params.action, params);
  return { type: command, params, warnings: [] };
}

/**
 * Verify that every component a `modify --componentProperties` write addresses
 * actually exists on the object.
 *
 * `modify` reports the vague `One or more component property operations failed
 * on 'X'.` when one of the named components is missing, which does not say
 * which name was wrong — and a typo is the usual cause. This probes the target
 * once with `find` (which returns a compact `componentNames` list, unlike
 * `get_components`, whose reply carries every property of every component) and
 * names the offender.
 *
 * `set_component_property` is deliberately not covered: the bridge already
 * answers `Component 'X' not found on 'Y' to set properties.`, so a probe there
 * would only add a round trip to the most common component write.
 * @param connection - the open bridge connection.
 * @param request - `{type, params}` as produced by `commandToRequest`.
 */
async function verifyComponentTargets(connection, request) {
  if (request === null || typeof request !== 'object') return;
  if (request.type !== 'manage_gameobject') return;
  const params = request.params ?? {};
  if (params.action !== 'modify') return;
  const target = params.target;
  if (typeof target !== 'string' || target.length === 0) return;

  const properties = params.componentProperties;
  if (properties === null || typeof properties !== 'object' || Array.isArray(properties)) return;
  const requested = Object.keys(properties);
  if (requested.length === 0) return;

  let text;
  try {
    const probe = { action: 'find', target };
    if (params.searchMethod !== undefined) probe.searchMethod = params.searchMethod;
    text = await connection.send('manage_gameobject', probe);
  } catch {
    // The lookup itself failed (target gone, connection dropped). Let the real
    // request surface its own error rather than replacing it with this one.
    return;
  }
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    return;
  }
  if (payload === null || payload.success !== true) return;
  // The raw bridge reply nests one extra level: {success, data:{success, data:[...]}}.
  // `toEnvelope` normally unwraps it, but this probe reads the text directly.
  let entries = payload.data;
  if (entries !== null && typeof entries === 'object' && !Array.isArray(entries)) entries = entries.data;
  if (!Array.isArray(entries)) return;
  // An ambiguous `find` can match several objects; only trust an exact name hit.
  const match = entries.find((entry) => entry !== null && typeof entry === 'object' && entry.name === target);
  if (match === undefined) return;
  const typeNames = Array.isArray(match.componentNames)
    ? match.componentNames.filter((name) => typeof name === 'string')
    : [];
  if (typeNames.length === 0) return;
  const shortNames = new Set(typeNames.map((name) => name.slice(name.lastIndexOf('.') + 1)));
  const missing = requested.filter((name) => !typeNames.includes(name) && !shortNames.has(name));
  if (missing.length === 0) return;
  const available = [...shortNames].sort().join(', ');
  // A dotted top-level key is usually a property path someone expected the
  // bridge to resolve (`{"m_LocalPosition.x":5}` — measured to be a no-op that
  // still answers success). Name the likely fix instead of only "no such component".
  const pathLike = missing.filter((name) => name.includes('.'));
  const hint = pathLike.length === 0
    ? ''
    : `; '${pathLike[0]}' looks like a property path — nest it under the component that owns it, e.g. --componentProperties '{"Transform":{"localPosition":"3,0,0"}}'`;
  throw new Error(`component '${missing.join("', '")}' is not on '${target}', so the bridge would report success and write nothing; components there: ${available}${hint}`);
}

/* ------------------------------------------------------------------ */
/* Subcommands                                                         */
/* ------------------------------------------------------------------ */

/**
 * Build the `status` envelope on an already-open connection.
 * Kept separate from `runStatus` so the warm shell can answer `status`
 * without a second connection and without an `emit`.
 */
async function buildStatus(port, flags, connection) {
  const stateText = await connection.send('manage_editor', { action: 'get_state' });
  const state = toEnvelope('status', stateText);
  if (!state.success) return state;
  const inner = state.data ?? {};
  const projectState = state.state ?? inner.state ?? {};
  const editor = projectState.editor ?? {};
  const scene = projectState.scene ?? {};
  const project = projectState.project ?? {};
  return {
    success: true,
    command: 'status',
    data: {
      state: editor.isCompiling === true || inner.isCompiling === true ? 'busy' : 'ready',
      instances: [
        {
          port,
          projectPath: flags.projectPath ?? null,
          projectRoot: (await projectRoot(connection)) ?? null,
          scene: scene.activeScenePath ?? null,
          playMode: editor.playMode ?? (inner.isPlaying ? 'playing' : 'stopped'),
          isCompiling: editor.isCompiling === true,
          isUpdating: editor.isUpdating === true,
          srp: project.srp ?? null,
        },
      ],
      editorState: inner,
    },
    errors: [],
    warnings: [],
  };
}

async function runStatus(flags) {
  const port = resolvePort(flags.port, flags.projectPath);
  if (port === undefined) {
    return emit({
      success: false,
      command: 'status',
      data: null,
      errors: ['STATUS_NO_INSTANCES: no Editor bridge heartbeat found (pass --port or open the project)'],
      warnings: [],
    });
  }
  let connection;
  try {
    connection = await connect(port, 15000);
  } catch (error) {
    return emit({ success: false, command: 'status', data: null, errors: [error.message], warnings: [] });
  }
  try {
    emit(await buildStatus(port, flags, connection));
  } catch (error) {
    emit({ success: false, command: 'status', data: null, errors: [error.message], warnings: [] });
  } finally {
    connection.close();
  }
}

async function projectRoot(connection) {
  try {
    const text = await connection.send('manage_editor', { action: 'get_project_root' });
    const envelope = toEnvelope('get_project_root', text);
    const data = envelope.data ?? {};
    return data.projectRoot ?? data.data?.projectRoot ?? null;
  } catch {
    return null;
  }
}

/** Build the `unity command` (no command name) listing of the bridge surface. */
async function buildListCommands(connection) {
  const customText = await connection.send('get_custom_tools', {});
  const custom = toEnvelope('get_custom_tools', customText);
  const commands = [];
  for (const [name, spec] of Object.entries(COMMAND_ALIASES)) {
    commands.push({
      name,
      description: `Bridge alias -> ${spec.type}/${spec.params.action ?? ''}`.trim(),
      parameters: {},
    });
  }
  for (const [type, actions] of Object.entries(BRIDGE_TOOL_ACTIONS)) {
    commands.push({
      name: type,
      description: `Codely bridge tool; actions: ${actions.join(', ')}`,
      parameters: { action: { type: 'string', required: true, description: actions.join(' | ') } },
    });
  }
  const tools = custom.success && Array.isArray(custom.data?.tools) ? custom.data.tools : [];
  for (const tool of tools) {
    commands.push({
      name: `custom.${tool.name}`,
      description: tool.description ?? 'custom tool',
      parameters: tool.inputSchema?.properties ?? {},
    });
  }
  return {
    success: true,
    command: 'command',
    data: { commands, customToolCount: tools.length },
    errors: [],
    warnings: [],
  };
}

/**
 * Known actions per bridge tool, taken verbatim from each tool's own
 * "Unknown action: ... Valid actions are: ..." reply (bridge 1.0.80).
 * Keep these in sync with the bridge: an action missing here makes the CLI
 * reject a call the editor would have accepted, so err on the side of adding
 * entries rather than trimming them.
 */
const BRIDGE_TOOL_ACTIONS = {
  manage_editor: [
    'publish_dirty_state_if_needed', 'wait_for_compile', 'wait_for_stop', 'request_compile',
    'start_compilation_pipeline', 'refresh', 'get_compilation_summary', 'wait_for_idle',
    'play', 'pause', 'resume', 'stop', 'step', 'get_state', 'get_current_state',
    'get_project_root', 'get_windows', 'get_active_tool', 'get_selection',
    'drain_agent_input', 'set_active_tool', 'ensure_tag', 'add_tag', 'remove_tag', 'get_tags',
    'ensure_layer', 'add_layer', 'remove_layer', 'get_layers', 'focus_window',
  ],
  manage_scene: [
    'ensure_scene_open', 'ensure_scene_saved', 'create', 'load', 'save',
    'get_hierarchy', 'get_active', 'get_build_settings',
  ],
  manage_gameobject: [
    'create_batch', 'edit_batch', 'ensure_component', 'ensure_renderer_material',
    'ensure_mesh_collider_mesh', 'ensure_prefab_default_sprite', 'create', 'modify', 'delete',
    'find', 'list_children', 'get_components', 'add_component', 'remove_component',
    'set_component_property', 'select',
  ],
  manage_asset: [
    'ensure_has_meta', 'ensure_meta_integrity', 'import', 'create', 'modify', 'delete',
    'duplicate', 'move', 'search', 'get_info', 'create_folder', 'get_components',
  ],
  manage_screenshot: [
    'capture_game_view', 'capture_scene_view', 'capture_main_camera', 'capture_specific_camera',
    'capture_asset', 'capture_ui_toolkit', 'start_game_view_recording',
    'finish_game_view_recording', 'capture', 'capture_scene_camera',
  ],
  manage_input: [
    'mouse_click', 'mouse_move', 'mouse_drag', 'mouse_scroll', 'mouse_down', 'mouse_up',
    'key_press', 'key_down', 'key_up', 'type_text', 'create_virtual_devices',
    'destroy_virtual_devices', 'sequence',
  ],
  read_console: ['get', 'clear'],
  execute_menu_item: ['execute', 'get_available_menus'],
  manage_script: ['create', 'read', 'update', 'delete', 'apply_text_edits', 'validate', 'edit', 'get_sha'],
  manage_shader: ['detect_render_pipeline', 'ensure_material_shader_for_srp', 'compile', 'preview'],
  manage_package: ['install_package', 'remove_package', 'list_packages'],
  manage_bake: ['bake_navmesh', 'bake_lighting', 'wait_for_bake', 'clear_navmesh', 'clear_baked_data'],
  manage_window_bridge: [
    'list_windows', 'focus_window', 'resolve_native_window', 'input', 'start_stream_server',
    'stop_stream_server', 'get_stream_server_status', 'start_offscreen_stream',
    'stop_offscreen_stream',
  ],
  manage_gameview: ['get_resolution', 'set_resolution', 'list_resolutions'],
  manage_dialog: ['click'],
  manage_job: ['status', 'list', 'cancel'],
  // These take no 'action': they read the script straight off --script.
  execute_csharp_script: [],
  exec_editor_script: [],
  exec_runtime_script: [],
};

async function runCommand(positional, flags) {
  const port = resolvePort(flags.port, flags.projectPath);
  if (port === undefined) {
    return emit({
      success: false,
      command: 'command',
      data: null,
      errors: ['STATUS_NO_INSTANCES: no Editor bridge heartbeat found (pass --port or open the project)'],
      warnings: [],
    });
  }
  let connection;
  try {
    connection = await connect(port, 15000);
  } catch (error) {
    return emit({ success: false, command: 'command', data: null, errors: [error.message], warnings: [] });
  }
  try {
    if (positional.length === 0) return emit(await buildListCommands(connection));

    const [name, ...rest] = positional;
    if (name === 'eval') {
      const script = rest.join(' ');
      const text = await connection.send('execute_csharp_script', { script });
      return emit(toEnvelope('eval', text));
    }
    const request = commandToRequest(name, rest);
    await verifyComponentTargets(connection, request);
    const text = await connection.send(request.type, request.params);
    emit(annotateNoOp(name, toEnvelope(name, text), request));
  } catch (error) {
    emit({ success: false, command: 'command', data: null, errors: [error.message], warnings: [] });
  } finally {
    connection.close();
  }
}

/** `unity shell --protocol ndjson`: one JSON request per stdin line, one response per stdout line. */
function runShell(flags) {
  const port = resolvePort(flags.port, flags.projectPath);
  if (port === undefined) {
    process.stderr.write('unity shell: no Editor bridge heartbeat found\n');
    process.exitCode = 1;
    return;
  }

  let queue = Promise.resolve();
  let connectionPromise = null;
  const getConnection = () => {
    if (connectionPromise === null) {
      connectionPromise = connect(port, DEFAULT_TIMEOUT_MS).catch((error) => {
        connectionPromise = null;
        throw error;
      });
    }
    return connectionPromise;
  };

  let pendingText = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    pendingText += chunk;
    let newline = pendingText.indexOf('\n');
    while (newline !== -1) {
      const line = pendingText.slice(0, newline).trim();
      pendingText = pendingText.slice(newline + 1);
      if (line.length > 0) {
        queue = queue.then(() => handleShellLine(line, getConnection));
      }
      newline = pendingText.indexOf('\n');
    }
  });
  process.stdin.on('end', () => {
    queue.then(() => {
      if (connectionPromise !== null) connectionPromise.then((c) => c.close()).catch(() => {});
      process.exit(0);
    });
  });

  const handleShellLine = async (line, getConn) => {
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      process.stdout.write(`${JSON.stringify({ id: null, exitCode: 1, envelope: { success: false, command: 'shell', data: null, errors: ['invalid JSON request line'], warnings: [] } })}\n`);
      return;
    }
    const id = parsed.id;
    const argv = Array.isArray(parsed.argv) ? parsed.argv : [];
    // A caller that launches this script itself may repeat the script path in
    // the request argv; drop it so it cannot be mistaken for a subcommand.
    const isSelf = (token) => typeof token === 'string' && (token === __filename || path.resolve(token) === __filename);
    while (argv.length > 0 && isSelf(argv[0])) argv.shift();
    const { positional, flags: innerFlags } = parseArgs(argv);
    // The warm shell receives the same argv the plugin would pass to `unity`,
    // so a leading subcommand token ("command" / "status") is still present.
    if (positional[0] === 'command') positional.shift();
    while (positional.length > 0 && isSelf(positional[0])) positional.shift();
    const effectivePort = resolvePort(innerFlags.port, innerFlags.projectPath) ?? port;
    try {
      const connection = effectivePort === port ? await getConn() : await connect(effectivePort, DEFAULT_TIMEOUT_MS);
      try {
        let envelope;
        if (positional.length === 0 || positional[0] === 'list_commands') {
          envelope = await buildListCommands(connection);
        } else if (positional[0] === 'status') {
          envelope = await buildStatus(effectivePort, innerFlags, connection);
        } else if (positional[0] === 'eval') {
          const text = await connection.send('execute_csharp_script', { script: positional.slice(1).join(' ') });
          envelope = toEnvelope('eval', text);
        } else {
          const request = commandToRequest(positional[0], positional.slice(1));
          await verifyComponentTargets(connection, request);
          const text = await connection.send(request.type, request.params);
          // The warm shell must apply the same no-op downgrade as the cold
          // path; otherwise every "reported success, wrote nothing" reply
          // slips through whenever the plugin reuses the session.
          envelope = annotateNoOp(positional[0], toEnvelope(positional[0], text), request);
        }
        process.stdout.write(`${JSON.stringify({ id, exitCode: envelope.success ? 0 : 1, envelope })}\n`);
        if (effectivePort !== port) connection.close();
      } catch (error) {
        if (effectivePort !== port) connection.close();
        throw error;
      }
    } catch (error) {
      process.stdout.write(`${JSON.stringify({ id, exitCode: 1, envelope: { success: false, command: positional[0] ?? 'shell', data: null, errors: [error.message], warnings: [] } })}\n`);
      connectionPromise = null;
    }
  };
}

/* ------------------------------------------------------------------ */
/* Entry point                                                         */
/* ------------------------------------------------------------------ */

async function main() {
  const argv = process.argv.slice(2);
  const { positional, flags } = parseArgs(argv);
  const subcommand = positional[0];
  const rest = positional.slice(1);

  if (subcommand === 'status') return runStatus(flags);
  if (subcommand === 'command') return runCommand(rest, flags);
  if (subcommand === 'shell') return runShell(flags);
  if (subcommand === 'editors' || subcommand === 'editors-installed') {
    const port = resolvePort(flags.port, flags.projectPath);
    return emit({
      success: port !== undefined,
      command: 'editors',
      data: port === undefined ? [] : [{ pid: null, port, version: 'Tuanjie (Codely bridge)' }],
      errors: port === undefined ? ['no Editor bridge heartbeat found'] : [],
      warnings: [],
    });
  }

  // Unknown subcommand: report, do not crash the plugin with a bare exit code.
  emit({
    success: false,
    command: subcommand ?? '(none)',
    data: null,
    errors: [`tuanjie bridge: subcommand '${subcommand ?? '(none)'}' is not supported by the Tuanjie bridge`],
    warnings: [],
  });
}

main().catch((error) => {
  emit({ success: false, command: 'shim', data: null, errors: [error.message], warnings: [] });
  process.exitCode = 1;
});
