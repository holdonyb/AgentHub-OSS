import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const rootPackageRelativePath = "package.json";
const workerPackageRelativePath = "packages/worker-cli/package.json";
const rootPackagePath = path.join(repoRoot, rootPackageRelativePath);
const workerPackagePath = path.join(repoRoot, workerPackageRelativePath);
const WORKER_TAG_PREFIX = "worker-v";

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--tag") {
      result.tag = argv[index + 1];
      index += 1;
      continue;
    }
  }
  return result;
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function main() {
  const { tag } = parseArgs(process.argv.slice(2));
  const rootPackage = await readJson(rootPackagePath);
  const workerPackage = await readJson(workerPackagePath);

  if (rootPackage.version !== workerPackage.version) {
    throw new Error(
      `Root version ${rootPackage.version} does not match worker package version ${workerPackage.version}`,
    );
  }

  if (tag) {
    if (!tag.startsWith(WORKER_TAG_PREFIX)) {
      throw new Error(`Worker release tag must start with ${WORKER_TAG_PREFIX}`);
    }
    const expectedVersion = tag.slice(WORKER_TAG_PREFIX.length);
    if (expectedVersion !== workerPackage.version) {
      throw new Error(
        `Worker release tag ${tag} does not match package version ${workerPackage.version}`,
      );
    }
  }

  process.stdout.write(`${workerPackage.version}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
