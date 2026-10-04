import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { compileSource } from "../src/compiler.js";
import {
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";

test("guarded nullable tuple methods keep branch effects and receiver identity", (t) => {
    const source = `
        type Triple = [number, number, number];
        let callbacks = 0;
        function format(value: Triple | null): string {
            return value ? value.map((item, index, receiver) => {
                callbacks++;
                if (index === 0) receiver[1] = 9;
                return item + 1;
            }).join(",") : "absent";
        }
        function guarded(value: Triple | undefined): string {
            if (!value) return "missing";
            return value.map(item => item * 2).join(",");
        }
        const functions: Array<(value: Triple | null) => string> = [format];
        const other: Array<(value: Triple | undefined) => string> = [guarded];
        if (functions[0]!(null) !== "absent" || callbacks !== 0)
            throw new Error("absent branch invoked its mapper");
        if (functions[0]!([1, 2, 3]) !== "2,10,4" || callbacks !== 3)
            throw new Error("tuple map receiver or callback order");
        if (other[0]!(undefined) !== "missing" || other[0]!([1, 2, 3]) !== "2,4,6")
            throw new Error("early guard narrowing");
    `;
    runInNewContext(
        ts.transpileModule(source, {
            compilerOptions: { target: ts.ScriptTarget.ES2022 },
        }).outputText,
    );
    const result = compileSource(source);
    const native = optionalNativeFixtureTools();
    if (!native) {
        t.skip("Native fixture compiler unavailable.");
        return;
    }
    runGeneratedProgram(native, "nullable-tuple-methods", result.cpp, {
        timeoutMs: 10000,
    });
});
