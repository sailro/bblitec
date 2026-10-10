import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import {
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";

test("failed lazy modules retain authored Error identity and release captured import cycles", () => {
    const directory = resolve("artifacts/module-error-lifetime");
    mkdirSync(directory, { recursive: true });
    writeFileSync(
        join(directory, "model.ts"),
        `
        export class Failure extends Error {
            readonly detail = {value: 1};
            constructor(readonly retry: () => Promise<void>) { super("cached"); }
        }
    `,
    );
    writeFileSync(
        join(directory, "failure.ts"),
        `
        import {Failure} from "./model";
        throw new Failure(async () => { await import("./failure"); });
        export const value = 1;
    `,
    );
    const result = compileSource(
        `
        import {Failure} from "./model";
        async function run(): Promise<void> {
            let first: Failure | undefined;
            let failures = 0;
            for (let index = 0; index < 2; index++) {
                try { await import("./failure"); }
                catch (error) {
                    if (!(error instanceof Failure)) throw error;
                    if (first === undefined) {
                        first = error;
                        error.detail.value = 7;
                    } else if (first !== error || error.detail.value !== 7) {
                        throw new Error("cached identity or owned field");
                    }
                    failures++;
                }
            }
            if (failures !== 2) throw new Error("failed activation count");
            try { await first!.retry(); }
            catch (error) {
                if (error !== first || first!.detail.value !== 7) throw new Error("retained import callback");
                failures++;
            }
            if (failures !== 3) throw new Error("callback failure count");
        }
        run().then(() => globalThis.close());
    `,
        { fileName: join(directory, "entry.ts") },
    );
    const tools = optionalNativeFixtureTools(false);
    assert.ok(tools);
    runGeneratedProgram(
        tools,
        "module-error-lifetime/native",
        `
        #define main generated_main
        ${result.cpp}
        #undef main
        int main() {
            const auto baseline = bbl::js::managed_node_count();
            const int result = generated_main();
            bbl::js::collect_cycles();
            if (bbl::js::managed_node_count() != baseline) return 91;
            return result;
        }
    `,
        { flags: ["/DBBLITE_WORKERS=1"], timeoutMs: 10000 },
    );
});
