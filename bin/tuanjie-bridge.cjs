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

/** Read `unity_port` from the project's .com-unity-codely.json heartbeat. */
function portFromProject(projectPath) {
  if (!projectPath) return undefined;
  const cfg = path.join(projectPath, '.com-unity-codely.json');
  try {
    const json = JSON.parse(fs.readFileSync(cfg, 'utf8'));
    if (Number.isInteger(json.unity_port) && json.unity_port > 0) return json.unity_port;
  } catch {
    /* not present or unreadable */
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

function resolvePort(explicit) {
  const fromArg = Number.parseInt(explicit ?? '', 10);
  if (Number.isInteger(fromArg) && fromArg > 0) return fromArg;
  const fromEnv = Number.parseInt(process.env.UNITY_BRIDGE_PORT ?? '', 10);
  if (Number.isInteger(fromEnv) && fromEnv > 0) return fromEnv;
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
    if (arg === '--project-path') {
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
const STRING_ARRAY_PARAMS = new Set(['componentsToAdd', 'componentsToRemove']);
const OBJECT_PARAMS = new Set(['componentProperties']);

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
        /* fall through to the single-element form */
      }
    }
    return [coerce(text)];
  }
  if (OBJECT_PARAMS.has(key)) {
    try {
      const parsed = JSON.parse(text);
      if (parsed !== null && typeof parsed === 'object') return parsed;
    } catch {
      /* fall through to the error below */
    }
    throw new Error(`'--${key}' expects a JSON object, e.g. --${key} '{"m_LocalPosition.x":0}'; the bridge would otherwise ignore it and still report success`);
  }
  if (key === 'ops') return coerceOps(text);
  return coerce(text);
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
        normalized[nestedKey] = typeof nestedValue === 'string' && needsCoercion(nestedKey)
          ? coerceParam(nestedKey, nestedValue)
          : nestedValue;
      }
      return { ...op, params: normalized };
    }
    return op;
  });
}

/** @returns whether `key` is one whose string form loses information. */
function needsCoercion(key) {
  return VECTOR3_PARAMS.has(key) || STRING_ARRAY_PARAMS.has(key) || OBJECT_PARAMS.has(key);
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

/** Collect `--flag value` / `--flag` pairs, reporting the flag names seen. */
function collectFlags(rawArgs) {
  const params = {};
  for (let i = 0; i < rawArgs.length; i += 1) {
    const token = rawArgs[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
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
  const writable = Object.keys(params).filter((key) => !LOCATOR_PARAMS.has(key));
  if (writable.length > 0) return;
  throw new Error(`'${action}' was given no writable parameter, so nothing would change; pass at least one of --position/--rotation/--scale/--name/--tag/--layer/--setActive/--parent/--componentName/--componentProperties`);
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
function annotateNoOp(command, envelope) {
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
      envelope.errors = [...(envelope.errors ?? []), `${message} — ${rule.reason}`];
      break;
    }
  }
  if (warnings.length !== (envelope.warnings ?? []).length) envelope.warnings = warnings;
  return envelope;
}

/** Build a bridge request from a CLI command name plus `--flag value` pairs. */
function commandToRequest(command, rawArgs) {
  const alias = COMMAND_ALIASES[command];
  if (alias !== undefined) {
    // Aliases still accept overrides, e.g. `read_console --count 50`.
    const params = { ...alias.params, ...collectFlags(rawArgs) };
    assertSupportedFlags(command, alias.params.action, params);
    return { type: alias.type, params, warnings: [] };
  }

  // A bare `action` positional (e.g. `unity command manage_scene get_hierarchy`)
  const action = rawArgs.length > 0 && !rawArgs[0].startsWith('--') ? rawArgs[0] : undefined;
  const params = collectFlags(rawArgs);
  if (action !== undefined && params.action === undefined) params.action = action;
  assertSupportedFlags(command, action ?? params.action, params);
  assertWritable(command, action ?? params.action, params);
  return { type: command, params, warnings: [] };
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
  const port = resolvePort(flags.port);
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

/** Known actions per bridge tool, discovered by probing each tool once. */
const BRIDGE_TOOL_ACTIONS = {
  manage_editor: [
    'get_state', 'get_current_state', 'get_project_root', 'play', 'pause', 'resume', 'stop', 'step',
    'refresh', 'request_compile', 'wait_for_compile', 'wait_for_stop', 'wait_for_idle',
    'get_compilation_summary', 'get_windows', 'get_active_tool', 'set_active_tool',
    'get_selection', 'get_tags', 'add_tag', 'remove_tag', 'ensure_tag',
    'get_layers', 'add_layer', 'remove_layer', 'ensure_layer', 'focus_window',
    'drain_agent_input', 'publish_dirty_state_if_needed',
  ],
  manage_scene: ['create', 'load', 'save', 'get_hierarchy', 'get_active', 'get_build_settings', 'ensure_scene_open', 'ensure_scene_saved'],
  manage_gameobject: [
    'create', 'modify', 'delete', 'find', 'list_children', 'get_components', 'add_component',
    'remove_component', 'set_component_property', 'select', 'create_batch', 'edit_batch',
  ],
  manage_asset: [
    'import', 'create', 'modify', 'delete', 'duplicate', 'move', 'search', 'get_info',
    'create_folder', 'get_components', 'ensure_has_meta', 'ensure_meta_integrity',
  ],
  manage_screenshot: [
    'capture_game_view', 'capture_scene_view', 'capture_main_camera', 'capture_specific_camera',
    'capture_asset', 'capture_ui_toolkit', 'capture', 'capture_scene_camera',
  ],
  manage_input: [
    'mouse_click', 'mouse_move', 'mouse_drag', 'mouse_scroll', 'mouse_down', 'mouse_up',
    'key_press', 'key_down', 'key_up', 'type_text', 'sequence',
  ],
  read_console: ['get', 'clear'],
  execute_menu_item: ['execute', 'get_available_menus'],
  execute_csharp_script: [],
  manage_script: [],
  manage_shader: [],
  manage_package: [],
  manage_bake: [],
  manage_window_bridge: [],
  manage_gameview: [],
  manage_dialog: [],
  manage_job: [],
};

async function runCommand(positional, flags) {
  const port = resolvePort(flags.port);
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
    if (name.startsWith('custom.')) {
      const toolName = name.slice('custom.'.length);
      const params = {};
      for (let i = 0; i < rest.length; i += 1) {
        if (rest[i].startsWith('--')) {
          const key = rest[i].slice(2);
          const next = rest[i + 1];
          if (next !== undefined && !next.startsWith('--')) {
            params[key] = coerce(next);
            i += 1;
          } else {
            params[key] = true;
          }
        }
      }
      const text = await connection.send('execute_custom_tool', { tool_name: toolName, arguments: params });
      return emit(toEnvelope(name, text));
    }

    const request = commandToRequest(name, rest);
    const text = await connection.send(request.type, request.params);
    emit(annotateNoOp(name, toEnvelope(name, text)));
  } catch (error) {
    emit({ success: false, command: 'command', data: null, errors: [error.message], warnings: [] });
  } finally {
    connection.close();
  }
}

/** `unity shell --protocol ndjson`: one JSON request per stdin line, one response per stdout line. */
function runShell(flags) {
  const port = resolvePort(flags.port);
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
    const effectivePort = resolvePort(innerFlags.port) ?? port;
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
          const text = await connection.send(request.type, request.params);
          envelope = toEnvelope(positional[0], text);
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
    const port = resolvePort(flags.port);
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
