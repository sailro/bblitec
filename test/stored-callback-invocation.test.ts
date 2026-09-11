import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { optionalNativeFixtureTools, runNativeFixtureCompiler } from "./native-fixture.js";

const nativeTools = optionalNativeFixtureTools(false);

test("optional stored callbacks skip arguments and retain the callee before argument effects", { skip: !nativeTools }, () => {
    const result = compileSource(`
        class Handler { action: ((value: number) => number) | null = null; }
        function adjusted(input:number, options={delta:input}):number {
            options.delta++;
            return options.delta;
        }
        function optional(input:number, suffix?:string):number {
            return suffix === undefined ? input : -1;
        }
        const unary:((input:number)=>number)[] = [adjusted, optional];
        if (unary[0]!(3) !== 4 || unary[0]!(5) !== 6 || unary[1]!(7) !== 7) throw new Error("stored trailing defaults");
        const handlers: Handler[] = [new Handler()];
        const handler = handlers[0]!;
        let calls = 0;
        function invoke(target: Handler): number | undefined { return target.action?.(++calls); }
        const absent = invoke(handler);
        if (absent !== undefined || calls !== 0) throw new Error("absent callback evaluated arguments");
        handler.action = value => value + 2;
        function replace(): number { handler.action = null; return 3; }
        const present = handler.action?.(replace());
        if (present !== 5 || handler.action != null) throw new Error("callback replaced before invocation");
        function invokeOptional(target: Handler | null): number | undefined { return target?.action?.(++calls); }
        if (invokeOptional(null) !== undefined || calls !== 0) throw new Error("absent owner evaluated arguments");
        const owners: (Handler | null)[] = [null, handler];
        for (let i = 0; i < owners.length; i++) {
            if (invokeOptional(owners[i]!) !== undefined) throw new Error("optional receiver guard");
        }
        handler.action = value => value;
        function clear(): void { handler.action = null; }
        clear();
        const cleared = handler.action?.(++calls);
        if (cleared !== undefined || calls !== 0) throw new Error("stale callback narrowing");
    `);
    const output = resolve("artifacts/stored-callback-invocation");
    mkdirSync(output, { recursive: true });
    const source = join(output, "check.cpp"), executable = join(output, "check.exe");
    writeFileSync(source, result.cpp);
    runNativeFixtureCompiler(nativeTools!, ["/nologo", "/std:c++20", "/W4", "/WX", "/permissive-", "/EHsc",
        `/Fo:${output}\\`, `/Fe:${executable}`, "/I", "native/include", source]);
    execFileSync(executable, { stdio: "pipe" });
});
