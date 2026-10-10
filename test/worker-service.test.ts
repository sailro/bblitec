import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import {
    optionalNativeFixtureTools,
    runNativeFixtureCompiler,
} from "./native-fixture.js";

test("dedicated worker services isolate instances and own nested-worker shutdown", (t) => {
    const tools = optionalNativeFixtureTools(false);
    if (!tools) {
        t.skip("Requires the Windows native fixture compiler.");
        return;
    }
    const directory = resolve("artifacts/worker-service-check");
    mkdirSync(directory, { recursive: true });
    const executable = resolve(directory, "check.exe");
    runNativeFixtureCompiler(tools, [
        "/DBBLITE_WORKERS=1",
        resolve("test/fixtures/worker-service-check.cpp"),
        `/Fo${directory}/`,
        `/Fe${executable}`,
    ]);
    execFileSync(executable, { stdio: "pipe", timeout: 15000 });
});
