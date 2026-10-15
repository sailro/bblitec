import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import ts from "typescript";
import { isRelativeSpecifier } from "../src/typescript-module-specifiers.js";

export type TestSuite = "fast" | "native" | "shaders";

/** Tool-backed shader integration tests; compiler-only shader tests stay in fast/native. */
const shaderTests = new Set([
    "pinned-variant-shaders.test.ts",
    "sdl-storage-array.test.ts",
    "shader-compilation.test.ts",
    "shader-cache-publication.test.ts",
    "shader-builtins-standard.test.ts",
    "webgpu-subset.test.ts",
    "tint-stage-validation.test.ts",
]);

/** Partition every test, following local test helpers that launch subprocesses. */
export function testSuites(directory: string): Record<TestSuite, string[]> {
    const prefix = resolve(directory) + sep;
    const dependencies = new Map<string, string[]>();
    const launches = new Set<string>();
    function inspect(file: string): void {
        if (dependencies.has(file)) return;
        const imports: string[] = [];
        dependencies.set(file, imports);
        const source = ts.preProcessFile(
            readFileSync(file, "utf8"),
            true,
            false,
        );
        for (const { fileName: name } of source.importedFiles) {
            if (name === "node:child_process" || name === "child_process")
                launches.add(file);
            if (!isRelativeSpecifier(name)) continue;
            const target = resolve(dirname(file), name.replace(/\.js$/, ".ts"));
            // Production imports may contain optional tool paths; classify the test's own helpers.
            if (target.startsWith(prefix) && existsSync(target)) {
                imports.push(target);
                inspect(target);
            }
        }
    }
    function needsProcess(file: string, seen = new Set<string>()): boolean {
        if (seen.has(file)) return false;
        seen.add(file);
        return (
            launches.has(file) ||
            dependencies
                .get(file)!
                .some((dependency) => needsProcess(dependency, seen))
        );
    }
    const suites: Record<TestSuite, string[]> = {
        fast: [],
        native: [],
        shaders: [],
    };
    for (const name of readdirSync(directory)
        .filter((name) => name.endsWith(".test.ts"))
        .sort()) {
        const file = resolve(directory, name);
        inspect(file);
        const suite = shaderTests.has(name)
            ? "shaders"
            : needsProcess(file)
              ? "native"
              : "fast";
        suites[suite].push(name);
    }
    return suites;
}
