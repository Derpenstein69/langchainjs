import { spawn } from "node:child_process";
import ts from "typescript";
import fs from "node:fs";
import { Command } from "commander";
import { rollup } from "@rollup/wasm-node";
import path from "node:path";
import { glob } from "glob";
import { ExportsMapValue, ImportData, LangChainConfig } from "./types.js";

async function asyncSpawn(command: string, args: string[]) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: "inherit",
      env: {
        // eslint-disable-next-line no-process-env
        ...process.env,
        NODE_OPTIONS: "--max-old-space-size=4096",
      },
      shell: true,
    });
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`Command failed: ${command} ${args.join(" ")}`));
        return;
      }
      resolve();
    });
  });
}

const deleteFolderRecursive = async function (inputPath: string) {
  try {
    // Verify the path exists
    if (
      await fs.promises
        .access(inputPath)
        .then(() => true)
        .catch(() => false)
    ) {
      const pathStat = await fs.promises.lstat(inputPath);
      // If it's a file, delete it and return
      if (pathStat.isFile()) {
        await fs.promises.unlink(inputPath);
      } else if (pathStat.isDirectory()) {
        // List contents of directory
        const directoryContents = await fs.promises.readdir(inputPath);
        if (directoryContents.length) {
          for await (const item of directoryContents) {
            const itemStat = await fs.promises.lstat(
              path.join(inputPath, item)
            );
            if (itemStat.isFile()) {
              // Delete file
              await fs.promises.unlink(path.join(inputPath, item));
            } else if (itemStat.isDirectory()) {
              await deleteFolderRecursive(path.join(inputPath, item));
            }
          }
        } else if (directoryContents.length === 0) {
          // If the directory is empty, delete it
          await fs.promises.rmdir(inputPath);
        }
      }
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    if (error.code !== "ENOENT") {
      // If the error is not "file or directory doesn't exist", rethrow it
      throw error;
    }
    // Otherwise, ignore the error (file or directory already doesn't exist)
  }
};

const NEWLINE = `
`;

// List of test-exports-* packages which we use to test that the exports field
// works correctly across different JS environments.
// Each entry is a tuple of [package name, import statement].
const testExports: Array<[string, (p: string) => string]> = [
  [
    "test-exports-esm",
    (p: string) =>
      `import * as ${p.replace(/\//g, "_")} from "langchain/${p}";`,
  ],
  [
    "test-exports-esbuild",
    (p: string) =>
      `import * as ${p.replace(/\//g, "_")} from "langchain/${p}";`,
  ],
  [
    "test-exports-cjs",
    (p: string) =>
      `const ${p.replace(/\//g, "_")} = require("langchain/${p}");`,
  ],
  ["test-exports-cf", (p: string) => `export * from "langchain/${p}";`],
  ["test-exports-vercel", (p: string) => `export * from "langchain/${p}";`],
  ["test-exports-vite", (p: string) => `export * from "langchain/${p}";`],
  ["test-exports-bun", (p: string) => `export * from "langchain/${p}";`],
];

const DEFAULT_GITIGNORE_PATHS = ["node_modules", "dist", ".yarn"];

async function createImportMapFile(config: LangChainConfig): Promise<void> {
  const createImportStatement = (k: string, p: string) =>
    `export * as ${k.replace(/\//g, "__")} from "../${
      p.replace("src/", "").endsWith(".ts")
        ? p.replace(".ts", ".js")
        : `${p}.js`
    }";`;

  const entrypointsToInclude = Object.keys(config.entrypoints)
    .filter((key) => key !== "load")
    .filter((key) => !config.deprecatedNodeOnly?.includes(key))
    .filter((key) => !config.requiresOptionalDependency?.includes(key))
    .filter((key) => !config.deprecatedOmitFromImportMap?.includes(key));
  const importMapExports = entrypointsToInclude
    .map((key) => `${createImportStatement(key, config.entrypoints[key])}`)
    .join("\n");

  let extraContent = "";
  if (config.extraImportMapEntries) {
    const extraImportData = config.extraImportMapEntries?.reduce<ImportData>(
      (data, { modules, alias, path }) => {
        const newData = { ...data };
        if (!newData.imports[path]) {
          newData.imports[path] = [];
        }
        newData.imports[path] = [
          ...new Set(newData.imports[path].concat(modules)),
        ];
        const exportAlias = alias.join("__");
        if (!newData.exportedAliases[exportAlias]) {
          newData.exportedAliases[exportAlias] = [];
        }
        newData.exportedAliases[exportAlias] =
          newData.exportedAliases[exportAlias].concat(modules);
        return newData;
      },
      {
        imports: {},
        exportedAliases: {},
      }
    );
    const extraImportStatements = Object.entries(extraImportData.imports).map(
      ([path, modules]) =>
        `import {\n  ${modules.join(",\n  ")}\n} from "${path}";`
    );
    const extraDeclarations = Object.entries(
      extraImportData.exportedAliases
    ).map(([exportAlias, modules]) =>
      [
        `const ${exportAlias} = {\n  ${modules.join(",\n  ")}\n};`,
        `export { ${exportAlias} };`,
      ].join("\n")
    );
    extraContent = `${extraImportStatements.join(
      "\n"
    )}\n${extraDeclarations.join("\n")}\n`;

    extraContent.trim();
    if (!/[a-zA-Z0-9]/.test(extraContent)) {
      extraContent = "";
    }
  }

  const importMapContents = `// Auto-generated by build script. Do not edit manually.\n\n${importMapExports}\n${extraContent}`;
  await fs.promises.writeFile("src/load/import_map.ts", importMapContents);
}

async function generateImportConstants(config: LangChainConfig): Promise<void> {
  // Generate import constants
  const entrypointsToInclude = Object.keys(config.entrypoints)
    .filter((key) => !config.deprecatedNodeOnly?.includes(key))
    .filter((key) => config.requiresOptionalDependency?.includes(key));
  const importConstantsPath = "src/load/import_constants.ts";
  const createImportStatement = (k: string) =>
    `  "langchain${
      config.packageSuffix ? `_${config.packageSuffix}` : ""
    }/${k}"`;
  const contents =
    entrypointsToInclude.length > 0
      ? `\n${entrypointsToInclude
          .map((key) => createImportStatement(key))
          .join(",\n")},\n];\n`
      : "];\n";
  await fs.promises.writeFile(
    `${importConstantsPath}`,
    `// Auto-generated by \`scripts/create-entrypoints.js\`. Do not edit manually.\n\nexport const optionalImportEntrypoints: string[] = [${contents}`
  );
}

const generateFiles = (config: LangChainConfig): Record<string, string> => {
  const files = [...Object.entries(config.entrypoints)].flatMap(
    ([key, value]) => {
      const nrOfDots = key.split("/").length - 1;
      const relativePath = "../".repeat(nrOfDots) || "./";
      const compiledPath = `${relativePath}dist/${value}.js`;
      return [
        [
          `${key}.cjs`,
          `module.exports = require('${relativePath}dist/${value}.cjs');`,
        ],
        [`${key}.js`, `export * from '${compiledPath}'`],
        [`${key}.d.ts`, `export * from '${compiledPath}'`],
        [`${key}.d.cts`, `export * from '${compiledPath}'`],
      ];
    }
  );

  return Object.fromEntries(files);
};

async function updateExportTestFiles(config: LangChainConfig): Promise<void[]> {
  // Update test-exports-*/entrypoints.js
  const entrypointsToTest = Object.keys(config.entrypoints)
    .filter((key) => !config.deprecatedNodeOnly?.includes(key))
    .filter((key) => !config.requiresOptionalDependency?.includes(key));

  return Promise.all(
    testExports.map(async ([pkg, importStatement]) => {
      const contents = `${entrypointsToTest
        .map((key) => importStatement(key))
        .join("\n")}\n`;
      return fs.promises.writeFile(
        `../environment_tests/${pkg}/src/entrypoints.js`,
        contents
      );
    })
  );
}

async function writeTopLevelGeneratedFiles(
  generatedFiles: Record<string, string>
): Promise<void[]> {
  return Promise.all(
    Object.entries(generatedFiles).map(async ([filename, content]) => {
      await fs.promises.mkdir(path.dirname(filename), { recursive: true });
      await fs.promises.writeFile(filename, content);
    })
  );
}

async function updateGitIgnore(
  config: LangChainConfig,
  filenames: string[]
): Promise<void> {
  const gitignorePaths = [
    ...filenames,
    ...DEFAULT_GITIGNORE_PATHS,
    ...(config.additionalGitignorePaths ? config.additionalGitignorePaths : []),
  ];

  // Update .gitignore
  return fs.promises.writeFile(
    "./.gitignore",
    `${gitignorePaths.join("\n")}\n`
  );
}

async function updatePackageJson(config: LangChainConfig): Promise<void> {
  const packageJson = JSON.parse(
    await fs.promises.readFile(`package.json`, "utf8")
  );
  const generatedFiles = generateFiles(config);
  const filenames = Object.keys(generatedFiles);
  packageJson.files = ["dist/", ...filenames];
  packageJson.exports = Object.keys(config.entrypoints).reduce(
    (acc: Record<string, ExportsMapValue>, key) => {
      let entrypoint = `./${key}`;
      if (key === "index") {
        entrypoint = ".";
      }
      acc[entrypoint] = {
        types: {
          import: `./${key}.d.ts`,
          require: `./${key}.d.cts`,
          default: `./${key}.d.ts`,
        },
        import: `./${key}.js`,
        require: `./${key}.cjs`,
      };
      return acc;
    },
    {}
  );
  packageJson.exports = {
    ...packageJson.exports,
    "./package.json": "./package.json",
  };

  let packageJsonString = JSON.stringify(packageJson, null, 2);
  if (
    !packageJsonString.endsWith("\n") &&
    !packageJsonString.endsWith(NEWLINE)
  ) {
    packageJsonString += NEWLINE;
  }

  // Write package.json and generate d.cts files
  // Optionally, update test exports files
  await Promise.all([
    fs.promises.writeFile(`package.json`, packageJsonString),
    writeTopLevelGeneratedFiles(generatedFiles),
    updateGitIgnore(config, filenames),
    config.shouldTestExports
      ? updateExportTestFiles(config)
      : Promise.resolve(),
  ]);
}

export function identifySecrets(absTsConfigPath: string) {
  const secrets = new Set();

  const tsConfig = ts.parseJsonConfigFileContent(
    ts.readJsonConfigFile(absTsConfigPath, (p) => fs.readFileSync(p, "utf-8")),
    ts.sys,
    "./src/"
  );

  // `tsConfig.options.target` is not always defined when running this
  // via the `@langchain/scripts` package. Instead, fallback to the raw
  // tsConfig.json file contents.
  const tsConfigFileContentsText =
    "text" in tsConfig.raw
      ? JSON.parse(tsConfig.raw.text as string)
      : { compilerOptions: {} };

  const tsConfigTarget =
    tsConfig.options.target || tsConfigFileContentsText.compilerOptions.target;

  for (const fileName of tsConfig.fileNames.filter(
    (fn) => !fn.endsWith("test.ts")
  )) {
    if (!tsConfigTarget) {
      continue;
    }

    const sourceFile = ts.createSourceFile(
      fileName,
      fs.readFileSync(fileName, "utf-8"),
      tsConfigTarget,
      true
    );

    sourceFile.forEachChild((node) => {
      switch (node.kind) {
        case ts.SyntaxKind.ClassDeclaration:
        case ts.SyntaxKind.ClassExpression: {
          node.forEachChild((node) => {
            // look for get lc_secrets()
            switch (node.kind) {
              case ts.SyntaxKind.GetAccessor: {
                const property = node;
                if (
                  ts.isGetAccessor(property) &&
                  property.name.getText() === "lc_secrets"
                ) {
                  // look for return { ... }
                  property.body?.statements.forEach((stmt) => {
                    if (
                      ts.isReturnStatement(stmt) &&
                      stmt.expression &&
                      ts.isObjectLiteralExpression(stmt.expression)
                    ) {
                      stmt.expression.properties.forEach((element) => {
                        if (ts.isPropertyAssignment(element)) {
                          // Type guard for PropertyAssignment
                          if (
                            element.initializer &&
                            ts.isStringLiteral(element.initializer)
                          ) {
                            const secret = element.initializer.text;

                            if (secret.toUpperCase() !== secret) {
                              throw new Error(
                                `Secret identifier must be uppercase: ${secret} at ${fileName}`
                              );
                            }
                            if (/\s/.test(secret)) {
                              throw new Error(
                                `Secret identifier must not contain whitespace: ${secret} at ${fileName}`
                              );
                            }

                            secrets.add(secret);
                          }
                        }
                      });
                    }
                  });
                }
                break;
              }
              default:
                break;
            }
          });
          break;
        }
        default:
          break;
      }
    });
  }

  return secrets;
}

async function generateImportTypes(config: LangChainConfig): Promise<void> {
  // Generate import types
  const pkg = `langchain${
    config.packageSuffix ? `-${config.packageSuffix}` : ""
  }`;
  const importTypesPath = "src/load/import_type.ts";

  await fs.promises.writeFile(
    `../${pkg}/${importTypesPath}`,
    `// Auto-generated by \`scripts/create-entrypoints.js\`. Do not edit manually.

export interface OptionalImportMap {}

export interface SecretMap {
${[...identifySecrets(config.tsConfigPath)]
  .sort()
  .map((secret) => `  ${secret}?: string;`)
  .join("\n")}
}
`
  );
}

function listExternals(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  packageJson: Record<string, any>,
  extraInternals?: Array<string | RegExp>
) {
  return [
    ...Object.keys(packageJson.dependencies ?? {}),
    ...Object.keys(packageJson.peerDependencies ?? {}),
    ...(extraInternals || []),
  ];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function listEntrypoints(packageJson: Record<string, any>) {
  const { exports } = packageJson;
  /** @type {Record<string, ExportsMapValue | string> | null} */
  const exportsWithoutPackageJSON: Record<
    string,
    ExportsMapValue | string
  > | null = exports
    ? Object.entries(exports)
        .filter(([k]) => k !== "./package.json")
        .reduce((acc, [k, v]) => ({ ...acc, [k]: v }), {})
    : null;

  if (!exportsWithoutPackageJSON) {
    throw new Error("No exports found in package.json");
  }
  /** @type {string[]} */
  const entrypoints = [];

  for (const [key, value] of Object.entries(exportsWithoutPackageJSON)) {
    if (key === "./package.json") {
      continue;
    }
    if (typeof value === "string") {
      entrypoints.push(value);
    } else if (
      "import" in value &&
      value.import &&
      typeof value.import === "string"
    ) {
      entrypoints.push(value.import);
    }
  }

  return entrypoints;
}

/**
 * Checks whether or not the file has side effects marked with the `__LC_ALLOW_ENTRYPOINT_SIDE_EFFECTS__`
 * keyword comment. If it does, this function will return `true`, otherwise it will return `false`.
 *
 * @param {string} entrypoint
 * @returns {Promise<boolean>} Whether or not the file has side effects which are explicitly marked as allowed.
 */
const checkAllowSideEffects = async (entrypoint: string): Promise<boolean> => {
  let entrypointContent: Buffer | undefined;
  try {
    entrypointContent = await fs.promises.readFile(
      `./dist/${entrypoint.replace(/^\.\//, "")}`
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (e: any) {
    if (e.message.includes("ENOENT")) {
      // Entrypoint is likely via an `index.js` file, retry with `index.js` appended to path
      entrypointContent = await fs.promises.readFile(
        `./dist/${entrypoint
          .replace(/^\.\//, "")
          .replace(/\.js$/, "")}/index.js`
      );
    }
  }

  // Allow escaping side effects strictly within code directly
  // within an entrypoint
  return entrypointContent
    ? entrypointContent
        .toString()
        .includes("/* __LC_ALLOW_ENTRYPOINT_SIDE_EFFECTS__ */")
    : false;
};

async function checkTreeShaking(config: LangChainConfig) {
  const packageJson = JSON.parse(
    await fs.promises.readFile("package.json", "utf8")
  );
  const externals = listExternals(packageJson, config?.internals ?? []);
  const entrypoints = listEntrypoints(packageJson);
  const consoleInfo = console.info;
  /** @type {Map<string, { log: string; hasUnexpectedSideEffects: boolean; }>} */
  const reportMap = new Map();

  for (const entrypoint of entrypoints) {
    let sideEffects = "";

    console.info = function (...args) {
      const line = args.length ? args.join(" ") : "";
      if (line.includes("First side effect in")) {
        sideEffects += `${line}\n`;
      }
    };

    await rollup({
      external: externals,
      input: entrypoint,
      experimentalLogSideEffects: true,
    });

    let hasUnexpectedSideEffects = sideEffects.length > 0;
    if (hasUnexpectedSideEffects) {
      hasUnexpectedSideEffects = !(await checkAllowSideEffects(entrypoint));
    }
    reportMap.set(entrypoint, {
      log: sideEffects,
      hasUnexpectedSideEffects,
    });
  }

  console.info = consoleInfo;

  let failed = false;
  for (const [entrypoint, report] of reportMap) {
    if (report.hasUnexpectedSideEffects) {
      failed = true;
      console.log("---------------------------------");
      console.log(`Tree shaking failed for ${entrypoint}`);
      console.log(report.log);
    }
  }

  if (failed) {
    // TODO: Throw a hard error here
    console.log("Tree shaking checks failed.");
  } else {
    console.log("Tree shaking checks passed!");
  }
}

function processOptions(): {
  shouldCreateEntrypoints: boolean;
  shouldCheckTreeShaking: boolean;
  shouldGenMaps: boolean;
  pre: boolean;
} {
  const program = new Command();
  program
    .description("Run a build script for a LangChain package.")
    .option(
      "--config <config>",
      "Path to the config file, defaults to ./langchain.config.js"
    )
    .option(
      "--create-entrypoints",
      "Pass only if you want to create entrypoints"
    )
    .option("--tree-shaking", "Pass only if you want to check tree shaking")
    .option("--gen-maps")
    .option("--pre");

  program.parse();

  const options = program.opts();

  const shouldCreateEntrypoints = options.createEntrypoints;
  const shouldCheckTreeShaking = options.treeShaking;
  const shouldGenMaps = options.genMaps;
  const { pre } = options;

  return {
    shouldCreateEntrypoints,
    shouldCheckTreeShaking,
    shouldGenMaps,
    pre,
  };
}

async function cleanGeneratedFiles(config: LangChainConfig) {
  const allFileNames = Object.keys(config.entrypoints)
    .map((key) => [`${key}.cjs`, `${key}.js`, `${key}.d.ts`, `${key}.d.dts`])
    .flat();
  return Promise.all(
    allFileNames.map(async (fileName) => {
      try {
        await fs.promises.unlink(fileName);
      } catch {
        // no-op
      }
    })
  );
}

export async function moveAndRename({
  source,
  dest,
  abs,
}: {
  source: string;
  dest: string;
  abs: (p: string) => string;
}) {
  if (!fs.existsSync(abs(source))) {
    return;
  }

  try {
    for (const file of await fs.promises.readdir(abs(source), {
      withFileTypes: true,
    })) {
      if (file.isDirectory()) {
        await moveAndRename({
          source: `${source}/${file.name}`,
          dest: `${dest}/${file.name}`,
          abs,
        });
      } else if (file.isFile()) {
        const parsed = path.parse(file.name);

        // Ignore anything that's not a .js file
        if (parsed.ext !== ".js") {
          continue;
        }

        // Rewrite any require statements to use .cjs
        const content = await fs.promises.readFile(
          abs(`${source}/${file.name}`),
          "utf8"
        );
        const rewritten = content.replace(
          /require\("(\..+?).js"\)/g,
          (_, p1) => `require("${p1}.cjs")`
        );

        // Rename the file to .cjs
        const renamed = path.format({ name: parsed.name, ext: ".cjs" });

        await fs.promises.writeFile(
          abs(`${dest}/${renamed}`),
          rewritten,
          "utf8"
        );
      }
    }
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}

export async function buildWithTSup() {
  const {
    shouldCreateEntrypoints,
    shouldCheckTreeShaking,
    shouldGenMaps,
    pre,
  } = processOptions();

  let langchainConfigPath = path.resolve("langchain.config.js");
  if (process.platform === "win32") {
    // windows, must resolve path with file://
    langchainConfigPath = `file:///${langchainConfigPath}`;
  }

  const { config }: { config: LangChainConfig } = await import(
    langchainConfigPath
  );

  // Clean & generate build files
  if (pre && shouldGenMaps) {
    await Promise.all([
      deleteFolderRecursive("dist").catch((e) => {
        console.error("Error removing dist (pre && shouldGenMaps)");
        throw e;
      }),
      deleteFolderRecursive(".turbo").catch((e) => {
        console.error("Error removing .turbo (pre && shouldGenMaps)");
        throw e;
      }),
      cleanGeneratedFiles(config),
      createImportMapFile(config),
      generateImportConstants(config),
      generateImportTypes(config),
    ]);
  } else if (pre && !shouldGenMaps) {
    await Promise.all([
      deleteFolderRecursive("dist").catch((e) => {
        console.error("Error removing dist (pre && !shouldGenMaps)");
        throw e;
      }),
      deleteFolderRecursive(".turbo").catch((e) => {
        console.error("Error deleting with deleteFolderRecursive");
        throw e;
      }),
      cleanGeneratedFiles(config),
    ]);
  }

  if (shouldCreateEntrypoints) {
    await Promise.all([
      asyncSpawn("tsc", ["--outDir", "dist/"]),
      asyncSpawn("tsc", ["--outDir", "dist-cjs/", "-p", "tsconfig.cjs.json"]),
    ]);
    await moveAndRename({
      source: config.cjsSource,
      dest: config.cjsDestination,
      abs: config.abs,
    });
    // move CJS to dist
    await Promise.all([
      updatePackageJson(config),
      deleteFolderRecursive("dist-cjs").catch((e) => {
        console.error("Error removing dist-cjs");
        throw e;
      }),
      deleteFolderRecursive("dist/tests").catch((e) => {
        console.error("Error removing dist/tests");
        throw e;
      }),
      (async () => {
        // Required for cross-platform compatibility.
        // Windows does not manage globs the same as Max/Linux when deleting directories.
        const testFolders = await glob("dist/**/tests");
        await Promise.all(
          testFolders.map((folder) => deleteFolderRecursive(folder))
        );
      })().catch((e) => {
        console.error("Error removing dist/**/tests");
        throw e;
      }),
    ]);
  }

  if (shouldCheckTreeShaking) {
    // Checks tree shaking via rollup
    await checkTreeShaking(config);
  }
}

/* #__PURE__ */ buildWithTSup().catch((e) => {
  console.error(e);
  process.exit(1);
});
