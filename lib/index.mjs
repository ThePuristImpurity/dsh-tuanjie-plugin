import Schema from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { fileURLToPath } from "node:url";
import * as skillFilesystem from "@deepseek-ai/dsh-skill-filesystem";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
//#region src/launcher.ts
/** Bundled Codely-bridge CLI, shipped inside this package and run by this Node. */
const BUNDLED_BRIDGE = fileURLToPath(new URL("../bin/tuanjie-bridge.cjs", import.meta.url));
/** Values of `tuanjieBin` that mean "use the bundled bridge" rather than a user binary. */
const AUTO_BIN_VALUES = /* @__PURE__ */ new Set(["", "auto", "tuanjie", "tuanjie-bridge"]);
/**
* Resolve how to launch the CLI. The bundled bridge needs no installation: it
* runs under the harness's own Node, so a fresh install works without the user
* providing any executable. An explicit `tuanjieBin` still wins, which keeps
* custom wrappers (and the old external adapter) usable.
* @param bin - the configured `tuanjieBin` value.
* @returns the executable plus any argv prefix that precedes the CLI arguments.
*/
function resolveLauncher(bin) {
	const trimmed = (bin ?? "").trim();
	if (trimmed === "" || AUTO_BIN_VALUES.has(trimmed.toLowerCase())) return { bin: process.execPath, prefixArgs: [BUNDLED_BRIDGE] };
	return { bin: trimmed, prefixArgs: [] };
}
/**
* Identity of the CLI file a warm session was spawned from. A live shell keeps
* running whatever code it loaded at spawn, so editing the bridge — or
* re-syncing the installed copy — left every later request on the old build with
* no diagnostic at all, which reads as "the fix did nothing". Hashing the content
* (rather than mtime+size) also catches a rewrite that lands in the same
* millisecond with the same length, which a copy-then-test loop hits easily; the
* bridge is tens of kilobytes, so the read costs nothing next to the round trip.
* @param path - the CLI file the session runs (the bundled bridge, or the user binary).
* @returns a comparable identity string, or undefined when the file cannot be read.
*/
function cliFingerprint(path) {
	try {
		return createHash("sha1").update(readFileSync(path)).digest("hex");
	} catch {
		return void 0;
	}
}
//#endregion
//#region src/tuanjie-cli.ts
/**
* Run one `tuanjie` CLI invocation to completion and collect both streams.
* Throws only for process-level failures (spawn failure, abort); a non-zero
* exit code is a result, not an error — the CLI reports failures in-band.
* @param ctx - plugin context carrying the `subprocess` service.
* @param spec - the fully-resolved invocation.
* @returns exit facts and the collected output tails.
*/
async function runTuanjie(ctx, spec) {
	if (spec.signal.aborted) throw new Error("tuanjie CLI run was aborted before start (tool timeout or caller cancellation)");
	let handle;
	try {
		handle = ctx.subprocess.spawn({
			argv: [spec.bin, ...spec.prefixArgs ?? [], ...spec.args],
			cwd: spec.cwd,
			stdio: {
				stdin: "ignore",
				stdout: { maxBytes: spec.outputMaxBytes },
				stderr: { maxBytes: spec.outputMaxBytes }
			},
			graceMs: spec.graceMs,
			signal: spec.signal,
			env: spec.env
		});
	} catch (error) {
		throw new Error(`tuanjie CLI failed to start — is ${JSON.stringify(spec.bin)} installed and on PATH?`, { cause: error });
	}
	let outcome;
	try {
		outcome = await handle.done;
	} catch (error) {
		throw new Error(`tuanjie CLI failed to start (is ${JSON.stringify(spec.bin)} installed and on PATH? See the Tuanjie CLI documentation)`, { cause: error });
	}
	const stdout = handle.collected.stdout?.readFrom(0);
	const stderr = handle.collected.stderr?.readFrom(0);
	if (spec.signal.aborted) throw new Error("tuanjie CLI run was aborted (tool timeout or caller cancellation)");
	return {
		exitCode: outcome.exitCode,
		signal: outcome.signal,
		stdout: stdout?.text ?? "",
		stderr: stderr?.text ?? "",
		stdoutTruncated: stdout?.lossy ?? false,
		stderrTruncated: stderr?.lossy ?? false
	};
}
/** Tail of a stream kept in a thrown diagnostic, in characters. */
const DIAGNOSTIC_TAIL_CHARS$1 = 2e3;
/** @returns the last {@link DIAGNOSTIC_TAIL_CHARS} characters of `text`. */
function diagnosticTail$1(text) {
	return text.length > DIAGNOSTIC_TAIL_CHARS$1 ? text.slice(-2e3) : text;
}
/**
* Run one `tuanjie ... --format json` invocation and parse its stdout envelope.
* The caller appends `--format json` itself; this helper owns only the exit
* and parse checks. Throws when the process was killed by a signal, stdout
* overflowed the cap (the envelope would be incomplete), or stdout is not JSON.
* @param ctx - plugin context carrying the `subprocess` service.
* @param spec - the fully-resolved invocation, already carrying `--format json`.
* @returns the exit code and the parsed envelope.
*/
async function runTuanjieJson(ctx, spec) {
	const result = await runTuanjie(ctx, spec);
	if (result.exitCode === null) throw new Error(`tuanjie CLI was killed by signal ${result.signal ?? "(unknown)"}; stderr tail:\n${diagnosticTail$1(result.stderr)}`);
	if (result.stdoutTruncated) throw new Error("tuanjie CLI JSON output exceeded the configured outputMaxBytes cap; raise it in the plugin config");
	let envelope;
	try {
		envelope = JSON.parse(result.stdout);
	} catch {
		throw new Error(`tuanjie CLI did not return JSON (exit code ${result.exitCode}).\nstdout tail:\n${diagnosticTail$1(result.stdout)}\nstderr tail:\n${diagnosticTail$1(result.stderr)}`);
	}
	return {
		exitCode: result.exitCode,
		envelope
	};
}
//#endregion
//#region src/tuanjie-shell.ts
/** Tail of collected stderr kept in a thrown diagnostic, in characters. */
const DIAGNOSTIC_TAIL_CHARS = 2e3;
/** @returns the last {@link DIAGNOSTIC_TAIL_CHARS} characters of `text`. */
function diagnosticTail(text) {
	return text.length > DIAGNOSTIC_TAIL_CHARS ? text.slice(-2e3) : text;
}
/**
* One live `tuanjie shell` process. Requests are serialized: a request is
* written only after the previous response line arrived, so response-to-id
* matching can never interleave. Any protocol breach — a non-JSON line, an
* id mismatch, an oversized line, process exit — is fatal to the session:
* every pending request rejects and the pool discards the session.
*/
var TuanjieShellSession = class {
	spec;
	handle;
	stdin;
	buffer = "";
	queue = [];
	inflight;
	nextId = 1;
	deadError;
	/** Fires after each settled request that leaves the session idle. */
	onIdle;
	/**
	* Spawn the shell process and wire protocol decoding.
	* @param ctx - plugin context carrying the `subprocess` service.
	* @param spec - constant spawn facts.
	* @param cwd - working directory of the shell process.
	*/
	constructor(ctx, spec, cwd) {
		this.spec = spec;
		this.handle = ctx.subprocess.spawn({
			argv: [
				spec.bin,
				...spec.prefixArgs ?? [],
				"shell",
				"--protocol",
				"ndjson",
				...spec.baseArgs ?? [],
				"--non-interactive",
				"--no-banner",
				"--quiet"
			],
			cwd,
			stdio: {
				stdin: "pipe",
				stdout: "pipe",
				stderr: { maxBytes: spec.outputMaxBytes }
			},
			graceMs: spec.graceMs,
			env: spec.env
		});
		const stdout = this.handle.stdout;
		const stdin = this.handle.stdin;
		if (stdout === void 0 || stdin === void 0) {
			this.handle.terminate();
			throw new Error("tuanjie shell spawn returned no piped stdio (subprocess provider contract breach)");
		}
		this.stdin = stdin;
		stdin.on("error", () => {});
		stdout.on("error", () => {});
		stdout.setEncoding("utf8");
		stdout.on("data", (chunk) => {
			this.onStdout(chunk);
		});
		this.handle.done.then((outcome) => {
			const exit = outcome.exitCode === null ? `killed by ${outcome.signal ?? "signal"}` : `exit code ${outcome.exitCode}`;
			this.fail(/* @__PURE__ */ new Error(`tuanjie shell session ended (${exit}). If this tuanjie CLI version lacks \`tuanjie shell\`, set warmShell: false in the tuanjie-plugin config.${this.stderrTailSuffix()}`));
		}, (error) => {
			this.fail(new Error(`tuanjie shell failed to start (is ${JSON.stringify(this.spec.bin)} installed and on PATH? See the Tuanjie CLI documentation)${this.stderrTailSuffix()}`, { cause: error }));
		});
	}
	/** True once the session rejected and must be discarded. */
	get dead() {
		return this.deadError !== void 0;
	}
	/** True while no request is in flight or queued. */
	get idle() {
		return this.inflight === void 0 && this.queue.length === 0;
	}
	/**
	* Run one envelope command through the warm process.
	* @param argv - CLI argv after `tuanjie`, sent verbatim as the request's argv array.
	* @param signal - abort (tool timeout or caller cancellation); aborting an in-flight request kills the session.
	* @returns the response's exit code and parsed envelope.
	*/
	request(argv, signal) {
		return new Promise((resolve, reject) => {
			if (this.deadError !== void 0) {
				reject(this.deadError);
				return;
			}
			if (signal.aborted) {
				reject(/* @__PURE__ */ new Error("tuanjie shell request was aborted before start (tool timeout or caller cancellation)"));
				return;
			}
			const pending = {
				id: this.nextId++,
				argv,
				signal,
				resolve,
				reject,
				unlisten: () => {}
			};
			const onAbort = () => {
				this.abort(pending);
			};
			signal.addEventListener("abort", onAbort, { once: true });
			pending.unlisten = () => {
				signal.removeEventListener("abort", onAbort);
			};
			this.queue.push(pending);
			this.pump();
		});
	}
	/** Idempotently end the session: close stdin, reject outstanding requests, and start the TERM-to-KILL escalation. */
	dispose() {
		try {
			this.stdin.end();
		} catch {}
		this.fail(/* @__PURE__ */ new Error("tuanjie shell session was disposed"));
	}
	/** Write the next queued request when none is in flight. */
	pump() {
		if (this.deadError !== void 0 || this.inflight !== void 0) return;
		const next = this.queue.shift();
		if (next === void 0) return;
		this.inflight = next;
		try {
			this.stdin.write(`${JSON.stringify({
				id: next.id,
				argv: next.argv
			})}\n`, () => {});
		} catch {}
	}
	/** Decode complete response lines from a stdout chunk. */
	onStdout(chunk) {
		if (this.deadError !== void 0) return;
		this.buffer += chunk;
		let newline = this.buffer.indexOf("\n");
		while (newline !== -1) {
			const line = this.buffer.slice(0, newline);
			this.buffer = this.buffer.slice(newline + 1);
			if (line.trim().length > 0) this.onLine(line);
			if (this.deadError !== void 0) return;
			newline = this.buffer.indexOf("\n");
		}
		if (this.buffer.length > this.spec.outputMaxBytes) this.fail(/* @__PURE__ */ new Error(`tuanjie shell response exceeded the configured outputMaxBytes cap (${this.spec.outputMaxBytes}); raise it in the plugin config`));
	}
	/** Match one response line to the in-flight request and settle it. */
	onLine(line) {
		let parsed;
		try {
			parsed = JSON.parse(line);
		} catch {
			this.fail(/* @__PURE__ */ new Error(`tuanjie shell wrote a non-JSON line: ${diagnosticTail(line)}`));
			return;
		}
		const inflight = this.inflight;
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed) || inflight === void 0 || parsed.id !== inflight.id || typeof parsed.exitCode !== "number" || !("envelope" in parsed)) {
			this.fail(/* @__PURE__ */ new Error(`tuanjie shell wrote an unexpected response line: ${diagnosticTail(line)}`));
			return;
		}
		this.inflight = void 0;
		inflight.unlisten();
		inflight.resolve({
			exitCode: parsed.exitCode,
			envelope: parsed.envelope
		});
		this.pump();
		if (this.idle) this.onIdle?.();
	}
	/** Settle one request's abort: dequeue a waiting request, kill the session for an in-flight one. */
	abort(pending) {
		const queued = this.queue.indexOf(pending);
		if (queued !== -1) {
			this.queue.splice(queued, 1);
			pending.unlisten();
			pending.reject(/* @__PURE__ */ new Error("tuanjie shell request was aborted (tool timeout or caller cancellation)"));
			if (this.idle) this.onIdle?.();
			return;
		}
		if (this.inflight === pending) this.fail(/* @__PURE__ */ new Error("tuanjie shell request was aborted (tool timeout or caller cancellation); the warm session was killed and will respawn on the next call"));
	}
	/** Mark the session dead, reject everything outstanding, and terminate the tree. */
	fail(error) {
		if (this.deadError !== void 0) return;
		this.deadError = error;
		const outstanding = [...this.inflight === void 0 ? [] : [this.inflight], ...this.queue];
		this.inflight = void 0;
		this.queue.length = 0;
		for (const pending of outstanding) {
			pending.unlisten();
			pending.reject(error);
		}
		this.handle.terminate();
		this.onIdle?.();
	}
	/** @returns a `\nstderr tail:` suffix for diagnostics, empty when nothing was captured. */
	stderrTailSuffix() {
		const tail = this.handle.collected.stderr?.readFrom(0).text ?? "";
		return tail.length === 0 ? "" : `\nstderr tail:\n${diagnosticTail(tail)}`;
	}
};
/**
* Warm-session pool: at most one live shell per working directory, created
* lazily, replaced after death on the next request, and disposed after
* {@link TuanjieShellPoolSpec.idleMs} without queued work. The pool never
* falls back to cold spawns itself — a dead session's error surfaces to the
* caller, keeping degraded environments loud.
*/
var TuanjieShellPool = class {
	ctx;
	spec;
	sessions = /* @__PURE__ */ new Map();
	/**
	* Build the pool.
	* @param ctx - plugin context carrying the `subprocess` service.
	* @param spec - constant spawn facts shared by every session.
	*/
	constructor(ctx, spec) {
		this.ctx = ctx;
		this.spec = spec;
	}
	/**
	* Run one envelope command through the cwd's warm session, spawning or
	* respawning it as needed.
	* @param cwd - working directory keying (and hosting) the session.
	* @param argv - CLI argv after `tuanjie`, sent verbatim.
	* @param signal - abort forwarded to the request (and, in flight, the session).
	* @returns the response's exit code and parsed envelope.
	*/
	async runJson(cwd, argv, signal, baseArgs) {
		const extra = baseArgs ?? [];
		const key = extra.length === 0 ? cwd : `${cwd}\u0000${extra.join("\u001f")}`;
		const spawnSpec = extra.length === 0 ? this.spec : {
			...this.spec,
			baseArgs: extra
		};
		let entry = this.sessions.get(key);
		// A session runs the code it loaded at spawn. When the CLI on disk has been
		// rewritten since, retire it instead of silently serving the old build for
		// the rest of the idle window — that silent staleness is exactly what made
		// an updated bridge look like it had no effect.
		if (entry !== void 0 && entry.fingerprint !== cliFingerprint(this.spec.fingerprintPath)) {
			this.drop(key);
			entry = this.sessions.get(key);
		}
		if (entry === void 0 || entry.session.dead) {
			if (entry !== void 0) this.drop(key);
			const session = new TuanjieShellSession(this.ctx, spawnSpec, cwd);
			entry = {
				session,
				fingerprint: cliFingerprint(this.spec.fingerprintPath),
				idleTimer: void 0
			};
			session.onIdle = () => {
				this.onSessionIdle(key);
			};
			this.sessions.set(key, entry);
		}
		if (entry.idleTimer !== void 0) {
			clearTimeout(entry.idleTimer);
			entry.idleTimer = void 0;
		}
		return await entry.session.request(argv, signal);
	}
	/** Dispose every session; the pool remains usable and respawns on demand. */
	disposeAll() {
		for (const cwd of [...this.sessions.keys()]) this.drop(cwd);
	}
	/** Arm (or run) the idle reaper for one session that just went quiet. */
	onSessionIdle(cwd) {
		const entry = this.sessions.get(cwd);
		if (entry === void 0) return;
		if (entry.session.dead) {
			this.drop(cwd);
			return;
		}
		if (entry.idleTimer !== void 0) clearTimeout(entry.idleTimer);
		entry.idleTimer = setTimeout(() => {
			const current = this.sessions.get(cwd);
			if (current?.session.idle === true || current?.session.dead === true) this.drop(cwd);
		}, this.spec.idleMs);
		entry.idleTimer.unref();
	}
	/** Remove and dispose one session. */
	drop(cwd) {
		const entry = this.sessions.get(cwd);
		if (entry === void 0) return;
		this.sessions.delete(cwd);
		if (entry.idleTimer !== void 0) clearTimeout(entry.idleTimer);
		entry.session.dispose();
	}
};
//#endregion
//#region src/tools.ts
/** The Config keys the tools consume; a live edit to any of them remounts the tools. */
const TOOL_CONFIG_KEYS = [
	"tuanjieBin",
	"projectPath",
	"commandTimeoutMs",
	"cliTimeoutMs",
	"graceMs",
	"outputMaxBytes",
	"warmShell",
	"shellIdleMs"
];
/** Shared output declaration of the envelope-returning tools. */
const ENVELOPE_OUTPUT_SCHEMA = {
	type: "object",
	additionalProperties: false,
	properties: {
		exitCode: {
			type: "integer",
			required: true,
			description: "命令行进程的退出码（0 表示成功；失败详情见返回信封）。"
		},
		envelope: {
			type: "json",
			required: true,
			description: "解析后的命令行 JSON 信封：{ success, command, data, errors, warnings }。使用 data 之前请先检查 success。"
		}
	}
};
/** Raw output declaration of the `tuanjie_cli` escape hatch. */
const RAW_OUTPUT_SCHEMA = {
	type: "object",
	additionalProperties: false,
	properties: {
		exitCode: {
			oneOf: [{ type: "integer" }, { type: "null" }],
			required: true,
			description: "进程退出码；被信号终止时为 null。"
		},
		signal: {
			oneOf: [{ type: "string" }, { type: "null" }],
			required: true,
			description: "终止信号名；正常退出时为 null。"
		},
		stdout: {
			type: "string",
			required: true
		},
		stderr: {
			type: "string",
			required: true
		},
		stdoutTruncated: {
			type: "boolean",
			required: true,
			description: "stdout 超出上限、头部内容被丢弃时为 true。"
		},
		stderrTruncated: {
			type: "boolean",
			required: true,
			description: "stderr 超出上限、头部内容被丢弃时为 true。"
		}
	}
};
/** Optional per-call project override shared by the live-Editor tools. */
const PROJECT_PATH_PARAMETER = {
	type: "string",
	description: "目标团结工程的绝对路径；省略则使用插件配置的默认工程（或当前唯一在运行的编辑器）。"
};
/**
* Register the five `tuanjie_*` tools on `ctx.tools`, remounting them whenever
* the Loader commits a live edit to a field they consume, as the settings
* form on the Plugins page writes them. A remount also disposes the warm
* shell pool, so in-flight warm requests reject and sessions respawn with the
* new values. The Config schema refuses non-positive timeouts and caps, and
* the Loader keeps the running values when a candidate fails it, so every
* mount sees values `defineTool` accepts.
* @param ctx - registrant context carrying the tool registry and subprocess service.
* @param config - the deployment's Tuanjie CLI configuration.
* @param watch - live-edit subscriptions on the plugin entry.
*/
function registerTuanjieTools(ctx, config, watch) {
	let dispose;
	const mount = () => {
		dispose?.();
		dispose = mountTuanjieTools(ctx, {
			tuanjieBin: config.tuanjieBin.get(),
			projectPath: config.projectPath.get(),
			commandTimeoutMs: config.commandTimeoutMs.get(),
			cliTimeoutMs: config.cliTimeoutMs.get(),
			graceMs: config.graceMs.get(),
			outputMaxBytes: config.outputMaxBytes.get(),
			env: config.env,
			warmShell: config.warmShell.get(),
			shellIdleMs: config.shellIdleMs.get()
		});
	};
	ctx.effect(() => () => {
		dispose?.();
		dispose = void 0;
	}, "tuanjie tools");
	mount();
	ctx.effect(() => watch(TOOL_CONFIG_KEYS, mount), "tuanjie tools: live config");
}
/**
* Register the tools and warm pool for one resolved configuration.
* @param ctx - registrant context carrying the tool registry and subprocess service.
* @param settings - the configuration this mount runs with.
* @returns the disposer unregistering the five tools and disposing the pool.
*/
function mountTuanjieTools(ctx, settings) {
	const disposers = [];
	/** How to reach the CLI: the bundled bridge unless the user pointed at a binary. */
	const launcher = resolveLauncher(settings.tuanjieBin);
	/** The calling agent's session cwd, else the harness process cwd. */
	const cwdOf = (exec) => exec.agent?.session.header.cwd ?? process.cwd();
	/** `--project-path` flags for the effective target project, empty when none is known. */
	const projectFlags = (override) => {
		const path = override ?? settings.projectPath;
		return path === void 0 ? [] : ["--project-path", path];
	};
	/**
	* One fully-resolved spec for a JSON-envelope invocation. `prefixArgs` rides
	* alongside argv rather than inside it: a cold spawn needs it in front of the
	* arguments, while a warm shell already carries it on its own command line
	* and must not see it repeated inside a request.
	*/
	const jsonSpec = (exec, args) => ({
		bin: launcher.bin,
		prefixArgs: launcher.prefixArgs,
		args: [
			...args,
			"--format",
			"json",
			"--non-interactive"
		],
		cwd: cwdOf(exec),
		env: settings.env,
		graceMs: settings.graceMs,
		outputMaxBytes: settings.outputMaxBytes,
		signal: exec.signal
	});
	/** Warm-session pool behind the live-Editor tools; absent when `warmShell` is off. */
	const pool = settings.warmShell ? new TuanjieShellPool(ctx, {
		bin: launcher.bin,
		prefixArgs: launcher.prefixArgs,
		// `tuanjie shell` resolves its editor port once, at startup, before it
		// reads a single request. Without this the warm session dies with
		// "no Editor bridge heartbeat found" whenever the agent's cwd is not
		// inside a Tuanjie project — even though projectPath is configured.
		baseArgs: projectFlags(void 0),
		fingerprintPath: launcher.prefixArgs.length > 0 ? launcher.prefixArgs[0] : launcher.bin,
		env: settings.env,
		graceMs: settings.graceMs,
		outputMaxBytes: settings.outputMaxBytes,
		idleMs: settings.shellIdleMs
	}) : void 0;
	if (pool !== void 0) disposers.push(() => {
		pool.disposeAll();
	});
	/** Run one envelope invocation through the warm session, or per-call when `warmShell` is off. */
	const runJson = async (exec, args, projectPath) => {
		const spec = jsonSpec(exec, args);
		if (pool === void 0) return await runTuanjieJson(ctx, spec);
		return await pool.runJson(spec.cwd, spec.args, spec.signal, projectFlags(projectPath));
	};
	disposers.push(ctx.tools.register(defineTool({
		name: "tuanjie_status",
		description: "查看团结引擎编辑器状态：列出当前能连上的编辑器实例。返回 success=false 且错误为 STATUS_NO_INSTANCES，表示没有正在运行、且已加载 Codely 桥（cn.tuanjie.codely.bridge）的编辑器——此时本插件无法驱动任何编辑器操作，需要请用户手动打开团结编辑器并加载工程。做实时编辑器操作之前、以及直接改 .unity/.prefab/.asset 文件之前都要先调它：编辑器在跑的时候绝不能手改这些文件，改了会被编辑器覆盖。",
		parameters: { projectPath: PROJECT_PATH_PARAMETER },
		output: {
			schema: ENVELOPE_OUTPUT_SCHEMA,
			render: (_args, value) => [{
				type: "text",
				text: JSON.stringify(value.envelope, null, 2)
			}]
		},
		timeoutMs: settings.commandTimeoutMs,
		isConcurrencySafe: () => true,
		async execute(args, exec) {
			return await runJson(exec, ["status"], args.projectPath);
		},
		presentCall: () => ({
			card: "generic",
			title: "查看团结编辑器状态",
			kind: "read"
		})
	})));
	disposers.push(ctx.tools.register(defineTool({
		name: "tuanjie_list_commands",
		description: "列出当前连接的团结编辑器提供的所有命令，含各命令支持的 action 列表。返回值里既有内置桥工具（manage_* / editor_* / save_scene / get_scene_hierarchy / read_console 等），也有工程自己注册的 custom.* 工具（团结编辑器的 TJGenerators 插件注册了大量 AI 生成工具，如 custom.generate_image、custom.generate_3d_model_by_rodin）。**调用 tuanjie_command 之前必须先查这里**，不要凭印象猜命令名——错误提示不会告诉你可选参数。",
		parameters: { projectPath: PROJECT_PATH_PARAMETER },
		output: {
			schema: ENVELOPE_OUTPUT_SCHEMA,
			render: (_args, value) => [{
				type: "text",
				text: JSON.stringify(value.envelope, null, 2)
			}]
		},
		timeoutMs: settings.commandTimeoutMs,
		isConcurrencySafe: () => true,
		async execute(args, exec) {
			return await runJson(exec, ["command", ...projectFlags(args.projectPath)], args.projectPath);
		},
		presentCall: () => ({
			card: "generic",
			title: "列出团结编辑器命令",
			kind: "read"
		})
	})));
	disposers.push(ctx.tools.register(defineTool({
		name: "tuanjie_command",
		description: "在正在运行的团结编辑器上执行一个具名命令。命令名必须与 tuanjie_list_commands 返回的完全一致，**不存在 set_transform / add_component / create_gameobject 这类独立命令**——编辑器操作几乎都是「工具名 + action」两段式，action 作为 args 的第一个元素传入。常用形式：manage_gameobject [create|modify|delete|find|list_children|get_components|add_component|remove_component|set_component_property|select|create_batch|edit_batch]、manage_scene [create|load|save|get_hierarchy|get_active|get_build_settings|ensure_scene_open|ensure_scene_saved]、manage_editor [get_state|play|pause|resume|stop|step|refresh|request_compile|wait_for_compile|wait_for_stop|wait_for_idle|get_compilation_summary|get_windows|get_active_tool|set_active_tool|get_selection|get_tags|add_tag|get_layers|add_layer|focus_window]、manage_asset [import|create|modify|delete|duplicate|move|search|get_info|create_folder|ensure_has_meta|ensure_meta_integrity]、manage_screenshot [capture_scene_view|capture_main_camera|capture_specific_camera|capture_asset|capture]（capture_game_view 已被禁用，Play Mode 验证请用 manage_gameview 或 exec_runtime_script 的 record_game_view）、manage_input [mouse_click|mouse_move|mouse_drag|mouse_scroll|key_press|type_text|sequence]、manage_script / manage_package / manage_bake / manage_dialog / manage_job / manage_window_bridge / execute_menu_item [execute|get_available_menus] / execute_csharp_script。另有单段别名可直接用：editor_play、editor_pause、editor_stop、editor_step、save_scene、get_scene_hierarchy、read_console [get|clear]。工程还可注册 custom.* 自定义工具（见 tuanjie_list_commands）。执行前先用 tuanjie_list_commands 查清 action 与参数名，不要凭空假设。这类调用不到一秒即可往返，且不会触发域重载。参数按原始命令行 flag 逐项放进 `args`，例如 [\"create\", \"--name\", \"Player\"]；参数名不合法时报错信息通常只说明缺哪个必填项，不会列出可选值，所以务必先查。**特别注意 --name 与 --target 的区别**：create 用 --name 表示新物体名，modify/delete/find/get_components 等操作则用 --target（或 --instanceId）指向已有物体；用错时不会报参数非法，只会报 Target GameObject(s) ('') not found using method 'default'，看起来像物体不存在。添加组件用 --componentName（或 componentsToAdd）。",
		parameters: {
			command: {
				type: "string",
				required: true,
				description: "编辑器命令名，必须与 tuanjie_list_commands 返回的完全一致。"
			},
			args: {
				type: "array",
				items: { type: "string" },
				description: "附加在命令名之后的原始命令行参数，逐项原样传入（不经 shell 引号处理）。命令无参数时省略。"
			},
			projectPath: PROJECT_PATH_PARAMETER
		},
		output: {
			schema: ENVELOPE_OUTPUT_SCHEMA,
			render: (_args, value) => [{
				type: "text",
				text: JSON.stringify(value.envelope, null, 2)
			}]
		},
		timeoutMs: settings.commandTimeoutMs,
		isConcurrencySafe: () => false,
		async execute(args, exec) {
			return await runJson(exec, [
				"command",
				args.command,
				...args.args ?? [],
				...projectFlags(args.projectPath)
			], args.projectPath);
		},
		presentCall: (args) => ({
			card: "generic",
			title: `团结: ${args.command}`,
			kind: "execute",
			rawInput: args.args
		})
	})));
	disposers.push(ctx.tools.register(defineTool({
		name: "tuanjie_eval",
		description: "在正在运行的团结编辑器里执行 C# 并返回结果。代码在编辑器进程内运行，可完全访问 UnityEngine / UnityEditor API，且不触发域重载；结尾写 `return` 语句即可产出值（例如 `return Application.unityVersion;`）。实际上走的是 Codely 桥的 execute_csharp_script 命令（tuanjie_list_commands 里能查到），不依赖 Pipeline 包。**代码里不要用反斜杠转义**（会被命令行层吃掉并报 CS1009），字符串请用双引号正常书写；含复杂引号的代码建议改用 tuanjie_command 传 args 数组。",
		parameters: {
			code: {
				type: "string",
				required: true,
				description: "要在编辑器里执行的 C# 语句；以 `return <表达式>;` 结尾即可产出返回值。"
			},
			projectPath: PROJECT_PATH_PARAMETER
		},
		output: {
			schema: ENVELOPE_OUTPUT_SCHEMA,
			render: (_args, value) => [{
				type: "text",
				text: JSON.stringify(value.envelope, null, 2)
			}]
		},
		timeoutMs: settings.commandTimeoutMs,
		isConcurrencySafe: () => false,
		async execute(args, exec) {
			return await runJson(exec, [
				"command",
				"eval",
				args.code,
				...projectFlags(args.projectPath)
			], args.projectPath);
		},
		presentCall: (args) => ({
			card: "generic",
			title: "在团结编辑器中执行 C#",
			kind: "execute",
			rawInput: args.code
		})
	})));
	disposers.push(ctx.tools.register(defineTool({
		name: "tuanjie_cli",
		description: "执行桥适配器的原始命令行子命令（即 `tuanjie` 之后的 argv）。本适配器只转发到团结引擎的 Codely 桥，**只支持 5 个子命令**：[\"status\"]（列出在线编辑器实例与 state）、[\"editors\"] 或 [\"editors\", \"--installed\"]（同上，精简版）、[\"command\", <命令名>, ...参数]（等于 tuanjie_command）、[\"shell\", \"--protocol\", \"ndjson\"]（热会话，多条请求一次进程）。**不支持** Unity Hub 那一套 `projects create` / `templates list` / `open` / `pipeline install` / `test` / `build` / `auth status` / `license status` / `logs` / `doctor`——这些会明确返回 `subcommand 'X' is not supported by the Tuanjie bridge`，不要尝试。加 \"--non-interactive\" 会由本工具自动追加；加 \"--format\", \"json\" 可获得机器可读信封。**凡是要驱动编辑器的操作，请优先用 tuanjie_command / tuanjie_eval；这个工具只留给查状态和需要自定义 argv 的边角场景。**",
		parameters: { args: {
			type: "array",
			required: true,
			items: { type: "string" },
			description: "命令行参数数组，即 `tuanjie` 之后的 argv，逐项原样追加（不经 shell 引号处理）。"
		} },
		output: {
			schema: RAW_OUTPUT_SCHEMA,
			render: (_args, value) => {
				const parts = [`${value.exitCode === null ? `killed by ${value.signal ?? "signal"}` : `exit code ${value.exitCode}`}`];
				if (value.stdout.length > 0) parts.push(`stdout${value.stdoutTruncated ? " (truncated to tail)" : ""}:\n${value.stdout}`);
				if (value.stderr.length > 0) parts.push(`stderr${value.stderrTruncated ? " (truncated to tail)" : ""}:\n${value.stderr}`);
				return [{
					type: "text",
					text: parts.join("\n")
				}];
			}
		},
		timeoutMs: settings.cliTimeoutMs,
		isConcurrencySafe: () => false,
		async execute(args, exec) {
			const argv = args.args.includes("--non-interactive") ? args.args : [...args.args, "--non-interactive"];
			return await runTuanjie(ctx, {
				bin: launcher.bin,
				args: [...launcher.prefixArgs, ...argv],
				cwd: cwdOf(exec),
				env: settings.env,
				graceMs: settings.graceMs,
				outputMaxBytes: settings.outputMaxBytes,
				signal: exec.signal
			});
		},
		presentCall: (args) => ({
			card: "terminal",
			title: `tuanjie ${args.args.join(" ")}`
		})
	})));
	return () => {
		for (const dispose of disposers) dispose();
	};
}
//#endregion

//#region src/skill.ts
/**
* Skill roots. Mounts the dsh filesystem skill provider over this package's
* own `assets/skills/` directory (the plugin's `tuanjie-workflow` skill).
* Reusing the filesystem provider keeps SKILL.md frontmatter, bundle-directory
* resources, and invocation-policy conventions identical to user- and
* project-level skills; the `bundled` source rank keeps the mounted skill
* overridable by a same-named project- or user-level skill.
* @module tuanjie-plugin/skill
*/
/** Absolute path of the plugin's own skill root shipped in the package. */
const BUNDLED_SKILL_DIR = fileURLToPath(new URL("../assets/skills/", import.meta.url));
function registerTuanjieSkills(ctx) {
	ctx.plugin(skillFilesystem, {
		providerName: "tuanjie-plugin",
		includeDefaultRoots: false,
		bundledSkillDir: BUNDLED_SKILL_DIR,
		watch: false
	});
}

//#endregion
//#region src/live-config.ts
/**
* Listen for live edits on the plugin entry's context.
* @param ctx - the plugin entry's own context (the one `apply` receives).
* @returns the key-routed subscription function.
*/
function watchConfig(ctx) {
	const subscriptions = /* @__PURE__ */ new Set();
	ctx.on("loader/volatile-update", (paths) => {
		const touched = new Set(paths.map((path) => path[0]));
		for (const subscription of [...subscriptions]) if ([...subscription.keys].some((key) => touched.has(key))) subscription.listener();
	});
	return (keys, listener) => {
		const subscription = {
			keys: new Set(keys),
			listener
		};
		subscriptions.add(subscription);
		return () => {
			subscriptions.delete(subscription);
		};
	};
}
//#endregion
//#region src/index.ts
const name = "tuanjie";
const inject = ["tools", "subprocess"];
/** Longest delay a Node timer honours; a larger one fires immediately. */
const MAX_TIMER_MS = 2147483647;
/**
* Schemastery configuration; defaults suit a local interactive install of the
* `tuanjie` CLI. Every field but `env` is volatile, so the settings form on the
* Plugins page edits it live; `env` carries CI credentials and stays in
* cordis.patch.yml. Timeouts and caps reject non-positive values because
* defineTool refuses a timeout of zero or less, and every duration is capped
* at the longest delay a Node timer honours.
*/
const Config = Schema.object({
	tuanjieBin: Schema.string().default("auto").description("团结引擎命令行入口。默认 auto 使用插件内置的桥适配器（无需安装任何东西）；只有想换成自己的 CLI 包装程序时才填绝对路径。").volatile(),
	projectPath: Schema.string().description("实时编辑器工具默认作用的团结工程路径；单次调用可另行指定其他工程。").volatile(),
	commandTimeoutMs: Schema.number().min(1).max(MAX_TIMER_MS).default(12e4).description("实时编辑器工具（tuanjie_status / tuanjie_command / tuanjie_eval）的超时时间，单位毫秒。").volatile(),
	cliTimeoutMs: Schema.number().min(1).max(MAX_TIMER_MS).default(6e5).description("tuanjie_cli 的超时时间，单位毫秒；安装、测试、构建耗时较长，故默认更宽松。").volatile(),
	graceMs: Schema.number().min(0).max(MAX_TIMER_MS).default(5e3).description("请求结束团结进程树之后、强制终止之前的宽限等待，单位毫秒。").volatile(),
	outputMaxBytes: Schema.number().min(1).default(512e3).description("每条命令输出流在内存中保留的字节上限，超出会被截断。").volatile(),
	env: Schema.dict(Schema.string()).default({}),
	warmShell: Schema.boolean().default(true).description("为每个工程保留一个常驻会话以加速实时编辑器工具；关闭后每次调用都要重新启动进程。").volatile(),
	shellIdleMs: Schema.number().min(1).max(MAX_TIMER_MS).default(3e5).description("常驻会话空闲多久后自动关闭，单位毫秒。").volatile(),
});
/**
* Register the `tuanjie_*` tools and, when a skills registry is composed, the
* skill roots. The skill child activates lazily so assemblies without the
* skills seam stay unaffected.
* @param ctx - registrant context carrying the tool registry and subprocess service.
* @param config - the deployment's Tuanjie CLI configuration.
*/
function apply(ctx, config) {
	const watch = watchConfig(ctx);
	registerTuanjieTools(ctx, config, watch);
	ctx.inject(["settings"], (settingsCtx) => {
		settingsCtx.effect(() => settingsCtx.settings.configure({ auto: false }, ctx.fiber), "tuanjie settings page policy");
	});
	ctx.inject(["skills"], (skillsCtx) => {
		registerTuanjieSkills(skillsCtx);
	});
}
//#endregion
export { Config, apply, inject, name };
