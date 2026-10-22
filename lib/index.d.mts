import Schema from "@deepseek-ai/schemastery";
import { Context, Volatile } from "@deepseek-ai/cordis";
//#region src/tools.d.ts
/**
 * 工具体系消费的部署配置。除 `env` 外每个字段都是 volatile 的：插件页的设置
 * 表单会实时编辑它，工具随之用新值重新挂载。`env` 承载 CI 凭据，因此只留在
 * cordis.patch.yml 中，不随设置响应下发。
 */
interface TuanjieToolsConfig {
  /** 团结引擎命令行可执行文件：PATH 中的命令名或绝对路径。 */
  tuanjieBin: Volatile<string>;
  /** 实时编辑器工具默认作用的团结工程路径；单次调用可用 `projectPath` 覆盖。 */
  projectPath: Volatile<string | undefined>;
  /** 实时编辑器工具的协作超时预算，单位毫秒。 */
  commandTimeoutMs: Volatile<number>;
  /** `tuanjie_cli` 的协作超时预算（安装、测试、构建耗时较长），单位毫秒。 */
  cliTimeoutMs: Volatile<number>;
  /** 从 TERM 升级到 KILL 结束 CLI 进程树的宽限等待，单位毫秒。 */
  graceMs: Volatile<number>;
  /** 每条采集的输出流在内存中的字节上限。 */
  outputMaxBytes: Volatile<number>;
  /** 传给 CLI 的显式环境变量，在子进程凭据清洗之后合并。 */
  env: Record<string, string>;
  /** 让实时编辑器工具走一个常驻会话，而不是每次调用都起一个 CLI 进程。 */
  warmShell: Volatile<boolean>;
  /** 常驻会话无排队工作时，空闲多少毫秒后释放。 */
  shellIdleMs: Volatile<number>;
}
//#endregion
//#region src/tuanjie-cli.d.ts
/** 无损 JSON 值，即一次 CLI `--format json` 标准输出的解析结果。 */
type TuanjieJson = null | boolean | number | string | TuanjieJson[] | {
  [key: string]: TuanjieJson;
};
/** 一次已完全解析的 `tuanjie` CLI 调用。 */
interface TuanjieRunSpec {
  /** 可执行文件：PATH 解析出的名字或绝对路径。 */
  bin: string;
  /** 可执行文件之后的参数；按 argv 元素传递，绝不经 shell 解释。 */
  args: readonly string[];
  /** CLI 进程的工作目录。 */
  cwd: string;
  /** 在子进程 seam 的凭据清洗之后合并的显式环境变量。 */
  env: Record<string, string>;
  /** 从 TERM 升级到 KILL 的宽限等待，单位毫秒。 */
  graceMs: number;
  /** 每条输出流在内存中的尾部字节上限。 */
  outputMaxBytes: number;
  /** 转发给进程树的中断信号（工具超时或调用方取消）。 */
  signal: AbortSignal;
}
/** 一次已完成的 `tuanjie` CLI 运行的退出与输出事实。 */
interface TuanjieRunResult {
  /** 退出码；进程因信号终止时为 null。 */
  exitCode: number | null;
  /** 终止信号名；正常退出时为 null。 */
  signal: string | null;
  /** 采集到的标准输出（被截断时保留尾部）。 */
  stdout: string;
  /** 采集到的标准错误（被截断时保留尾部）。 */
  stderr: string;
  /** 标准输出溢出上限、丢失了开头时为 true。 */
  stdoutTruncated: boolean;
  /** 标准错误溢出上限、丢失了开头时为 true。 */
  stderrTruncated: boolean;
}
/** 退出码加上一次 `--format json` 运行的解析信封。 */
interface TuanjieJsonResult {
  /** CLI 进程的退出码（非零信封同样会被解析）。 */
  exitCode: number;
  /** 解析后的 CLI 信封：`{ success, command, data, errors, warnings }`。 */
  envelope: TuanjieJson;
}
//#endregion
//#region src/index.d.ts
declare const name = "tuanjie";
declare const inject: string[];
/** 团结引擎 CLI 集成的部署配置。 */
type Config = TuanjieToolsConfig;
/** Loader 解析的原始配置：volatile 字段以普通值形式出现。 */
type ConfigInput = { [K in keyof Config]: Config[K] extends Volatile<infer T> ? T : Config[K]; };
/**
 * Schemastery 配置；默认值适配本地交互式安装的 `tuanjie` CLI。除 `env` 外
 * 每个字段都是 volatile 的，插件页的设置表单可实时编辑；`env` 承载 CI
 * 凭据，留在 cordis.patch.yml 中。超时与上限拒绝非正值，因为 defineTool
 * 不接受小于等于零的超时；每个时长都以 Node 计时器能接受的上限封顶。
 */
declare const Config: Schema<ConfigInput, Config>;
/**
 * 注册 `tuanjie_*` 工具；当装配了技能注册表时，再挂载技能根目录。技能子项
 * 惰性激活，因此没有技能 seam 的装配不受影响。
 * @param ctx - 携带工具注册表与子进程服务的注册方上下文。
 * @param config - 该部署的团结引擎 CLI 配置。
 */
declare function apply(ctx: Context, config: Config): void;
//#endregion
export { Config, ConfigInput, type TuanjieJson, type TuanjieJsonResult, type TuanjieRunResult, type TuanjieRunSpec, type TuanjieToolsConfig, apply, inject, name };
