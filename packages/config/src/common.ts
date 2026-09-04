import { DEFAULTS } from "./defaults.js";
import {
  readEnvVarWithDefault,
  readOptionalEnvVar,
  resolveEnvLoader,
  type EnvLoaderArgs,
} from "./env.js";
import { BB_LOG_LEVEL_ENV, BB_WT_WORK_CWD_ROOT_ENV } from "./env-vars.js";
import { assignIfDefined } from "./objects.js";
import { resolveRuntimeDataDir, type BbRuntimeMode } from "./runtime.js";

export interface LogLevelConfig {
  BB_LOG_LEVEL: string;
}

type LoadLogLevelConfigArgs = EnvLoaderArgs;

export interface CommonConfig extends LogLevelConfig {
  BB_DATA_DIR: string;
  BB_WT_WORK_CWD_ROOT?: string;
}

export interface LoadCommonConfigArgs extends EnvLoaderArgs {
  repoRoot?: string;
}

function resolveDefaultLogLevel(mode: BbRuntimeMode): string {
  return mode === "prod" ? DEFAULTS.logLevel.prod : DEFAULTS.logLevel.dev;
}

export function loadLogLevelConfig(
  args: LoadLogLevelConfigArgs = {},
): LogLevelConfig {
  const loader = resolveEnvLoader(args);
  return {
    BB_LOG_LEVEL: readEnvVarWithDefault({
      context: loader.context,
      defaultValue: resolveDefaultLogLevel(loader.mode),
      definition: BB_LOG_LEVEL_ENV,
      env: loader.env,
    }),
  };
}

export function loadCommonConfig(
  args: LoadCommonConfigArgs = {},
): CommonConfig {
  const loader = resolveEnvLoader(args);
  const logLevelConfig = loadLogLevelConfig({
    env: loader.env,
    homeDir: loader.context.homeDir,
    mode: loader.mode,
  });

  const config: CommonConfig = {
    ...logLevelConfig,
    BB_DATA_DIR: resolveRuntimeDataDir({
      env: loader.env,
      homeDir: loader.context.homeDir,
      mode: loader.mode,
      repoRoot: args.repoRoot,
    }),
  };
  assignIfDefined({
    key: "BB_WT_WORK_CWD_ROOT",
    target: config,
    value: readOptionalEnvVar({
      context: loader.context,
      definition: BB_WT_WORK_CWD_ROOT_ENV,
      env: loader.env,
    }),
  });
  return config;
}
