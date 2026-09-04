/**
 * Test-suite discovery guard.
 *
 * The local Vitest config intentionally uses an allow-list so a production-
 * mutating live test can never run merely because its filename ends in
 * `.test.ts`. The downside is that a new local test could otherwise sit
 * unexecuted forever. This guard requires every test file to be assigned to
 * exactly one known suite (or to the explicit legacy manual-runner list).
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "..");

function read(relativePath: string): string {
  return readFileSync(path.join(ROOT, relativePath), "utf8");
}

function walk(relativeDir: string): string[] {
  const absoluteDir = path.join(ROOT, relativeDir);
  return readdirSync(absoluteDir).flatMap((name) => {
    const relativePath = path.posix.join(relativeDir, name);
    const absolutePath = path.join(ROOT, relativePath);
    return statSync(absolutePath).isDirectory() ? walk(relativePath) : [relativePath];
  });
}

function exactTestPaths(source: string): Set<string> {
  const paths = new Set<string>();
  for (const match of source.matchAll(/["'](tests\/[^"']+\.test\.tsx?)["']/g)) {
    if (!match[1].includes("*")) paths.add(match[1]);
  }
  return paths;
}

function configTestPaths(configPath: string): Set<string> {
  return exactTestPaths(read(configPath));
}

const manualLiveRunners = new Set([
  // These predate Vitest and execute themselves via `npx tsx <file>`.
  "tests/full-suite.test.ts",
  "tests/critical-flows.test.ts",
]);

describe("test suite discovery", () => {
  it("assigns every test file to exactly one safe, named suite", () => {
    const allTests = new Set(
      walk("tests").filter((file) => /\.test\.tsx?$/.test(file)),
    );

    const mainSource = read("vitest.config.ts");
    const mainDeclared = exactTestPaths(mainSource);
    const excludeBlock = mainSource.match(/exclude:\s*\[([\s\S]*?)\]/)?.[1] ?? "";
    const mainExcluded = exactTestPaths(excludeBlock);
    const local = new Set([...mainDeclared].filter((file) => !mainExcluded.has(file)));

    const suites = new Map<string, Set<string>>([
      ["local", local],
      [
        "contracts",
        new Set([...allTests].filter((file) =>
          file.startsWith("tests/smoke/contracts/"),
        )),
      ],
      ["production-e2e", configTestPaths("vitest.e2e.config.ts")],
      ["live-scenarios", configTestPaths("vitest.live.config.ts")],
      ["live-multiaction", configTestPaths("vitest.multiaction.config.ts")],
      ["manual-live-runner", manualLiveRunners],
    ]);

    const assignments = new Map<string, string[]>();
    for (const [suite, files] of suites) {
      for (const file of files) {
        const names = assignments.get(file) ?? [];
        names.push(suite);
        assignments.set(file, names);
      }
    }

    const missingFiles = [...assignments.keys()]
      .filter((file) => !allTests.has(file))
      .sort();
    const unassigned = [...allTests]
      .filter((file) => !assignments.has(file))
      .sort();
    const multiplyAssigned = [...assignments]
      .filter(([, names]) => names.length !== 1)
      .map(([file, names]) => `${file}: ${names.join(", ")}`)
      .sort();

    expect(
      missingFiles,
      "suite configs/manual allow-list reference test files that do not exist",
    ).toEqual([]);
    expect(
      unassigned,
      "new test files must be added to vitest.config.ts or a named specialized suite",
    ).toEqual([]);
    expect(
      multiplyAssigned,
      "a live/contract test must never also be discoverable by the local suite",
    ).toEqual([]);
  });
});
