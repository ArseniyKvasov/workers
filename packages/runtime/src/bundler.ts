import { build, type Plugin } from "esbuild";

export interface BundleResult {
  code: string;
  sizeBytes: number;
}

/**
 * Bundles user worker code in memory with esbuild, targeting the workerd
 * environment. The result is a single ESM script passed to workerd as a
 * module worker.
 */
export async function bundleWorkerSource(
  entrypointSource: string,
  options: { nodeCompat?: boolean } = {}
): Promise<BundleResult> {
  const result = await build({
    stdin: {
      contents: entrypointSource,
      resolveDir: "/virtual",
      sourcefile: "worker.ts",
      loader: "tsx",
    },
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    target: "es2022",
    conditions: ["worker", "browser"],
    define: { "process.env.NODE_ENV": '"production"' },
    jsx: "automatic",
    logLevel: "silent",
  });

  const code = result.outputFiles[0]?.text ?? "";
  return { code, sizeBytes: Buffer.byteLength(code) };
}

/**
 * Wraps bundled user code with the platform shim: the shim receives workerd's
 * env (raw service bindings + secrets JSON) and constructs the familiar
 * Workers env (env.D1, env.KV, env.QUEUE, env.SECRETS) before delegating to
 * the user's fetch handler.
 */
export async function bundleWithShim(
  userCode: string,
  shimSource: string
): Promise<BundleResult> {
  const files: Record<string, string> = {
    "shim.ts": shimSource,
    "__user_code__.ts": userCode,
  };

  const result = await build({
    stdin: {
      contents: shimSource,
      sourcefile: "shim.ts",
      loader: "tsx",
    },
    write: false,
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    conditions: ["worker", "browser"],
    define: { "process.env.NODE_ENV": '"production"' },
    plugins: [virtualModulesPlugin(files)],
    logLevel: "silent",
  });

  const code = result.outputFiles?.[0]?.text ?? "";
  return { code, sizeBytes: Buffer.byteLength(code) };
}

function virtualModulesPlugin(files: Record<string, string>): Plugin {
  return {
    name: "virtual-modules",
    setup(build) {
      build.onResolve({ filter: /^__user_code__(\.ts)?$/ }, (args) => ({
        path: "__user_code__.ts",
        namespace: "virtual",
      }));
      build.onLoad({ filter: /.*/, namespace: "virtual" }, (args) => ({
        contents: files[args.path] ?? "",
        loader: "tsx",
      }));
    },
  };
}
