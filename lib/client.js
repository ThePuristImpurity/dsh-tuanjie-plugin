window.__ModuleLoader__.load({
	id: "dsh-tuanjie-plugin",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let _deepseek_ai_dsh_client_ui_primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		let react_jsx_runtime = require("react/jsx-runtime");
		//#region src/client/controller.ts
		/**
		* Profile entry id of the plugin row this card edits: the id the bundle's
		* cordis.patch.yml inserts, which is also the settings form namespace.
		*/
		const TUANJIE_NS = "tuanjie";
		/** Longest delay a Node timer honours; the Host's schema refuses anything larger. */
		const MAX_TIMER_MS = 2147483647;
		/**
		* A number field bounded like its Host schema. An empty draft clears the
		* field; anything outside the bounds blocks the save here, so the card says
		* so inline instead of the Host refusing the write.
		* @param field - field name inside the entry's form.
		* @param min - smallest accepted value.
		* @param max - largest accepted value.
		* @returns the field's conversion spec.
		*/
		function boundedNumberField(field, min, max = Number.MAX_SAFE_INTEGER) {
			return {
				field,
				format: (value) => typeof value === "number" ? String(value) : "",
				parse: (text) => {
					const trimmed = text.trim();
					if (trimmed === "") return { kind: "clear" };
					const parsed = Number(trimmed);
					return Number.isFinite(parsed) && parsed >= min && parsed <= max ? {
						kind: "set",
						value: parsed
					} : void 0;
				}
			};
		}
		/**
		* An on/off field, staged as the text `true` or `false`; the card renders it
		* as a switch.
		* @param field - field name inside the entry's form.
		* @returns the field's conversion spec.
		*/
		function booleanField(field) {
			return {
				field,
				format: (value) => typeof value === "boolean" ? String(value) : "",
				parse: (text) => {
					if (text === "") return { kind: "clear" };
					return text === "true" || text === "false" ? {
						kind: "set",
						value: text === "true"
					} : void 0;
				}
			};
		}
		/** Every field's spec, in render order. */
		const FIELD_SPECS = [
			(0, _deepseek_ai_dsh_client_ui_primitives.settingsTextField)("tuanjieBin"),
			(0, _deepseek_ai_dsh_client_ui_primitives.settingsTextField)("projectPath"),
			boundedNumberField("commandTimeoutMs", 1, MAX_TIMER_MS),
			boundedNumberField("cliTimeoutMs", 1, MAX_TIMER_MS),
			boundedNumberField("graceMs", 0, MAX_TIMER_MS),
			boundedNumberField("outputMaxBytes", 1),
			booleanField("warmShell"),
			boundedNumberField("shellIdleMs", 1, MAX_TIMER_MS),
		];
		/** 把 `tuanjie` 条目的共享配置表单桥接到卡片的分步表单上。 */
		var TuanjieCardController = class {
			form;
			store;
			/** @param scope - `tuanjie` profile 条目的共享配置表单. */
			constructor(scope) {
				this.form = new _deepseek_ai_dsh_client_ui_primitives.SettingsFormModel(scope, [...FIELD_SPECS]);
				this.store = this.form.bind(() => this.projection());
			}
			projection() {
				const fields = {};
				for (const spec of FIELD_SPECS) fields[spec.field] = this.form.field(spec.field);
				return {
					...this.form.shell(),
					fields
				};
			}
			/**
			* Build the face the card's slot registration injects.
			* @returns the card snapshot hook seat and its form actions.
			*/
			inject() {
				return {
					hooks: { tuanjieCard: this.store },
					...this.form.actions()
				};
			}
			/** Release the form subscription. */
			dispose() {
				this.form.dispose();
			}
		};
		//#endregion
		//#region src/client/TuanjieCard.tsx
		/**
		* 团结引擎插件的设置表单，显示在插件页的插件详情中，
		* drawn with the shared settings form chrome so it reads as one surface with
		* the official plugin pages. The page draws the bundle's title, description,
		* and rows itself. Copy mirrors the shipped English strings.
		* @module tuanjie-plugin/client/TuanjieCard
		*/
		/** The form frame's copy. */
		const FORM_LABELS = {
			unavailable: "插件未运行时，团结引擎插件设置不可用。",
			readOnly: "当前环境以只读方式保存设置。",
			saveFailed: "当前环境没有接受这些取值，已保留在表单中供你修改。",
			save: "保存",
			saving: "保存中…"
		};
		const POSITIVE = "请输入大于 0 的数值，留空则使用默认值。";
		const TIMER = "请输入大于 0 且不超过 2147483647 的毫秒数，留空则使用默认值。";
		/** The controls, grouped and in render order. */
		const SECTIONS = [
			{
				title: "团结引擎命令行",
				fields: [{
					field: "tuanjieBin",
					kind: "text",
					label: "桥适配器入口",
					hint: "留空或填 auto 即使用插件内置的桥客户端（无需安装任何东西）。只有想换成自己的 CLI 包装程序时才填绝对路径。",
					placeholder: "auto"
				}, {
					field: "projectPath",
					kind: "text",
					label: "默认工程路径",
					hint: "实时编辑器工具默认作用的工程；单次调用可另行指定。留空表示使用当前唯一在运行的编辑器。",
					placeholder: "/path/to/MyGame"
				}]
			},
			{
				title: "超时与上限",
				fields: [
					{
						field: "commandTimeoutMs",
						kind: "number",
						label: "实时编辑器命令超时（毫秒）",
						hint: "适用于 tuanjie_status、tuanjie_list_commands、tuanjie_command 与 tuanjie_eval。",
						invalid: TIMER
					},
					{
						field: "cliTimeoutMs",
						kind: "number",
						label: "命令行超时（毫秒）",
						hint: "适用于 tuanjie_cli（查询状态等轻量调用）。",
						invalid: TIMER
					},
					{
						field: "graceMs",
						kind: "number",
						label: "终止宽限（毫秒）",
						hint: "超时或被取消的进程在被强制终止前，允许自行退出的等待时间。",
						invalid: "请输入 0 到 2147483647 之间的毫秒数，留空则使用默认值。"
					},
					{
						field: "outputMaxBytes",
						kind: "number",
						label: "输出上限（字节）",
						hint: "每条命令行输出流以及常驻会话单行响应在内存中保留的上限。",
						invalid: POSITIVE
					}
				]
			},
			{
				title: "常驻会话",
				fields: [{
					field: "warmShell",
					kind: "switch",
					label: "保持常驻命令行会话",
					hint: "为每个工程复用一个命令行会话以加速实时编辑器工具，单次调用可从约 600 毫秒降到几毫秒。"
				}, {
					field: "shellIdleMs",
					kind: "number",
					label: "空闲关闭时间（毫秒）",
					hint: "常驻会话空闲超过该时长后自动关闭。",
					invalid: TIMER
				}]
			},
		
		];
		/** Class-name prefix scoping the injected stylesheet to this card. */
		const CN = "tuanjie-plugin-form";
		/**
		* Section headings and the switch row, over the theme's alias tokens; the
		* shared primitives draw everything else. The bundle purity gate forbids
		* importing their CSS modules, so the switch row restates their field rules.
		*/
		const FORM_CSS = `
.${CN}__section + .${CN}__section { margin-top: 20px; }
.${CN}__title { margin: 0; padding-bottom: 4px; font-size: 13px; font-weight: 600; line-height: 1.5; color: var(--dsw-alias-label-secondary); }
.${CN}__switch { display: flex; flex-direction: column; gap: 6px; padding: 12px 0; border-top: 0.5px solid var(--dsw-alias-border-l2); }
.${CN}__title + .${CN}__switch { border-top: 0; }
.${CN}__head { display: flex; align-items: center; gap: 8px; }
.${CN}__label { flex: 1; min-width: 0; font-size: 13px; font-weight: 500; line-height: 1.5; color: var(--dsw-alias-label-primary); }
.${CN}__reset { border: none; background: none; padding: 0; font: inherit; font-size: 12px; line-height: 1.5; color: var(--dsw-alias-label-secondary); cursor: pointer; }
.${CN}__reset:hover:not(:disabled) { color: var(--dsw-alias-label-primary); }
.${CN}__reset:disabled { cursor: default; }
.${CN}__hint { margin: 0; font-size: 12px; line-height: 1.5; color: var(--dsw-alias-label-tertiary); }
.${CN}__note { margin: 16px 0 0; font-size: 12px; line-height: 1.5; color: var(--dsw-alias-label-tertiary); }
`;
		/** Inject the form stylesheet once per document. */
		function ensureStylesheet() {
			if (typeof document === "undefined" || document.querySelector(`style[data-plugin-css="${CN}"]`) !== null) return;
			const tag = document.createElement("style");
			tag.dataset.plugin = "tuanjie-plugin";
			tag.dataset.pluginCss = CN;
			tag.textContent = FORM_CSS;
			document.head.appendChild(tag);
		}
		/**
		* Render one on/off field in the shared field layout, with the switch where
		* the value field puts its input.
		* @param props - the field's copy and state plus the edit actions.
		* @returns the labelled switch.
		*/
		function SwitchField(props) {
			const { copy, state } = props;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: `${CN}__switch`,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: `${CN}__head`,
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: `${CN}__label`,
							children: copy.label
						}),
						state.overridden ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Tag, {
							tone: "neutral",
							children: "已覆盖"
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							className: `${CN}__reset`,
							disabled: props.disabled,
							onClick: props.onReset,
							children: "恢复默认"
						})] }) : null,
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Switch, {
							checked: state.text === "true",
							label: copy.label,
							disabled: props.disabled,
							onChange: (next) => {
								props.onEdit(String(next));
							}
						})
					]
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
					className: `${CN}__hint`,
					children: copy.hint
				})]
			});
		}
		/**
		* 渲染团结引擎插件的设置表单。
		* @param props - the view asked for, the card snapshot, and its form actions.
		* @returns the form; nothing for a summary, which this slot never asks for.
		*/
		function TuanjieCard(props) {
			const state = props.useTuanjieCard((snapshot) => snapshot);
			if (props.view === "summary") return null;
			ensureStylesheet();
			const disabled = !state.writable || state.saving;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(_deepseek_ai_dsh_client_ui_primitives.SettingsForm, {
				labels: FORM_LABELS,
				state,
				onSave: props.save,
				onDiscard: props.discard,
				children: [SECTIONS.map((section) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
					className: `${CN}__section`,
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", {
						className: `${CN}__title`,
						children: section.title
					}), section.fields.map((copy) => copy.kind === "switch" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(SwitchField, {
						copy,
						state: state.fields[copy.field],
						disabled,
						onEdit: (text) => {
							props.edit(copy.field, text);
						},
						onReset: () => {
							props.resetField(copy.field);
						}
					}, copy.field) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.SettingsValueField, {
						id: `tuanjie-plugin-settings-${copy.field}`,
						label: copy.label,
						hint: copy.hint,
						overriddenLabel: "已覆盖",
						resetLabel: "恢复默认",
						invalidLabel: copy.invalid ?? "请输入有效取值，或留空使用默认值。",
						numeric: copy.kind === "number",
						...copy.placeholder === void 0 ? {} : { placeholder: copy.placeholder },
						disabled,
						...state.fields[copy.field],
						onEdit: (text) => {
							props.edit(copy.field, text);
						},
						onReset: () => {
							props.resetField(copy.field);
						}
					}, copy.field))]
				}, section.title)), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
					className: `${CN}__note`,
					children: "命令行的环境变量（如 CI 服务账号凭据）只保存在 profile 的 cordis.patch.yml 中，不会下发到浏览器。"
				})]
			});
		}
		//#endregion
		//#region src/client/index.ts
		/** The package name the Plugins page keys this bundle's configuration by. */
		const PACKAGE_NAME = "dsh-tuanjie-plugin";
		const name = "tuanjie";
		const inject = ["slots", "configForms"];
		/**
		* 挂载团结引擎命令行的设置卡片。
		* @param ctx - the browser plugin context.
		*/
		function apply(ctx) {
			const controller = new TuanjieCardController(ctx.configForms.get(TUANJIE_NS));
			ctx.effect(() => () => {
				controller.dispose();
			}, "tuanjie-plugin: form subscription");
			ctx.effect(() => ctx.configForms.whileServed([TUANJIE_NS], () => ctx.slots.inject("plugins.bundle.config", () => ctx.slots.register({
				name: "plugins.bundle.config",
				key: PACKAGE_NAME,
				inject: () => controller.inject()
			}, TuanjieCard))), "tuanjie-plugin: settings card");
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		exports.name = name;
		return module.exports;
	}
});
