/**
 * Window applications run under an RmlUi fixture. Kept apart from
 * native-fixture.ts so fixtures that compile no TypeScript do not load the
 * compiler.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { TestContext } from "node:test";
import { compileSource } from "../src/compiler.js";
import { hostPageCompileOptions, readHostPage } from "../src/host-page.js";
import { runRmlUiFixture } from "./native-fixture.js";

/**
 * Compiles `program` after a worker that starts and ends (the fixture builds
 * with workers) as `artifacts/<name>/entry.ts` and returns its C++. A `page`
 * (HTML whose module script loads `/entry.ts`) hosts it as
 * `artifacts/<name>/page.html`.
 */
export function compileApplicationFixture(
    name: string,
    program: string,
    page?: string,
): string {
    const directory = resolve("artifacts", name);
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "worker.ts"), "self.close();");
    const source = `
        const worker = new Worker(new URL("./worker.ts", import.meta.url), {type:"module"});
        worker.terminate();
        ${program}`;
    const fileName = join(directory, "entry.ts");
    if (page === undefined) return compileSource(source, { fileName }).cpp;
    writeFileSync(fileName, source);
    const path = join(directory, "page.html");
    writeFileSync(path, page);
    return compileSource(source, hostPageCompileOptions(readHostPage({ path })))
        .cpp;
}

/**
 * Compiles `program` (`compileApplicationFixture`, hosted by `page` when
 * given) into `artifacts/<name>/program.hpp`, then runs
 * `test/fixtures/<name>-check.cpp` over it with `macros` beside the workers'
 * own.
 */
export function runApplicationRmlUiFixture(
    t: TestContext,
    name: string,
    program: string,
    macros: Readonly<Record<string, 0 | 1>> = {},
    page?: string,
): void {
    writeFileSync(
        join(resolve("artifacts", name), "program.hpp"),
        compileApplicationFixture(name, program, page),
    );
    runRmlUiFixture(t, name, {
        macros: { BBLITE_WORKERS: 1, BBLITE_OFFSCREEN_SURFACES: 1, ...macros },
    });
}
