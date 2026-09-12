import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { optionalNativeFixtureTools, runNativeFixtureCompiler } from "./native-fixture.js";

const nativeTools = optionalNativeFixtureTools(false);

test("mapped class method views retain their receivers and observe later mutations", { skip: !nativeTools }, () => {
    const result = compileSource(`
        class Service {
            constructor(private active: boolean) {}
            isReady(code: number): boolean { return this.active && code === 3; }
            stop(): void { this.active = false; }
        }
        type Query = Pick<Service, "isReady">;
        interface Client { test(query: Query): boolean; }
        const clients: Client[] = [{ test(query) { return query.isReady(3); } }];
        const services: Service[] = [new Service(true), new Service(false)];
        const queries: Query[] = [services[0]!, services[1]!];
        if (!clients[0]!.test(queries[0]!) || clients[0]!.test(queries[1]!))
            throw new Error("distinct method receivers");
        services[0]!.stop();
        services.splice(0);
        if (clients[0]!.test(queries[0]!)) throw new Error("retained receiver state");
    `);
    const output = resolve("artifacts/structural-class-methods");
    mkdirSync(output, { recursive: true });
    const source = join(output, "check.cpp"), executable = join(output, "check.exe");
    writeFileSync(source, result.cpp);
    runNativeFixtureCompiler(nativeTools!, ["/nologo", "/std:c++20", "/W4", "/WX", "/permissive-", "/EHsc",
        `/Fo:${output}\\`, `/Fe:${executable}`, "/I", "native/include", source]);
    execFileSync(executable, { stdio: "pipe" });
});
