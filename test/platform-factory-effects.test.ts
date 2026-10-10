import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import {
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";

test("factories with void methods retain native lifecycle effects", (t) => {
    const directory = resolve("artifacts/platform-factory-effects");
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "worker.ts"), "self.close();");
    const result = compileSource(
        `
        const worker = new Worker(new URL("./worker.ts", import.meta.url), {type:"module"});
        worker.terminate();
        interface Controller { add(amount: number): void; stop(): void; }
        let total = 0;
        function createController(): Controller {
            total += 1;
            const timer = window.setTimeout(() => { throw new Error("cancelled timer ran"); }, 500);
            return { add(amount: number): void { total += amount; }, stop(): void { window.clearTimeout(timer); } };
        }
        async function createAsyncController(): Promise<Controller> {
            total += 2;
            const timer = window.setTimeout(() => { throw new Error("cancelled async timer ran"); }, 500);
            await Promise.resolve();
            return { add(amount: number): void { total += amount; }, stop(): void { window.clearTimeout(timer); } };
        }
        async function exercise(): Promise<void> {
            let controller: Controller | null = null;
            controller = createController();
            if (total !== 1) throw new Error("synchronous factory effects");
            controller.add(4); controller.stop();
            const pending = createAsyncController();
            if (total !== 7) throw new Error("async prefix effects");
            controller = await pending;
            controller.add(8); controller.stop();
            if (total !== 15) throw new Error("retained method effects");
            globalThis.close();
        }
        void exercise();
        `,
        { fileName: join(directory, "entry.ts") },
    );
    assert.match(result.cpp, /set_timeout/);
    assert.match(result.cpp, /clear_timer/);
    const tools = optionalNativeFixtureTools(false);
    if (!tools) {
        t.skip("Native fixture compiler unavailable.");
        return;
    }
    runGeneratedProgram(tools, "platform-factory-effects", result.cpp, {
        flags: ["/DBBLITE_WORKERS=1"],
        timeoutMs: 10000,
    });
});
