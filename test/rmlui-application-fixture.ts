/**
 * Window applications run under an RmlUi fixture. Kept apart from
 * native-fixture.ts so fixtures that compile no TypeScript do not load the
 * compiler.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { TestContext } from "node:test";
import { compileSource } from "../src/compiler.js";
import { runRmlUiFixture } from "./native-fixture.js";

/**
 * Compiles `program` after a worker that starts and ends (the fixture builds
 * with workers) into `artifacts/<name>/program.hpp`, then runs
 * `test/fixtures/<name>-check.cpp` over it.
 */
export function runApplicationRmlUiFixture(
    t: TestContext,
    name: string,
    program: string,
): void {
    const directory = resolve("artifacts", name);
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "worker.ts"), "self.close();");
    const result = compileSource(
        `
        const worker = new Worker(new URL("./worker.ts", import.meta.url), {type:"module"});
        worker.terminate();
        ${program}`,
        { fileName: join(directory, "entry.ts") },
    );
    writeFileSync(join(directory, "program.hpp"), result.cpp);
    runRmlUiFixture(t, name, {
        macros: { BBLITE_WORKERS: 1, BBLITE_OFFSCREEN_SURFACES: 1 },
    });
}
