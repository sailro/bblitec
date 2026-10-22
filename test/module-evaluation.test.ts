import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import {
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";

test("an import used only as a type does not run its module", (t) => {
    const tools = optionalNativeFixtureTools(false);
    if (!tools) {
        t.skip("Native fixture compiler unavailable.");
        return;
    }
    const directory = resolve("artifacts/module-evaluation");
    mkdirSync(directory, { recursive: true });
    const write = (name: string, source: string): void =>
        writeFileSync(resolve(directory, name), source);
    write("log.ts", "export const log: string[] = [];");
    write(
        "opts.ts",
        'import { log } from "./log.js";\nexport interface Opts { a: number }\nlog.push("opts");',
    );
    write(
        "effects.ts",
        'import { log } from "./log.js";\nlog.push("effects");\nexport const value = 7;\nexport class Base { kind(): string { return "base"; } }\nexport interface Shape { n: number }',
    );
    write("types.ts", 'export type { Shape } from "./effects.js";');
    const { cpp } = compileSource(
        `import { log } from "./log.js";
        import { Opts } from "./opts.js";
        import "./effects.js";
        import { Base } from "./effects.js";
        import * as ns from "./effects.js";
        import { Shape } from "./types.js";
        class Derived extends Base {}
        const o: Opts = { a: 1 };
        const s: Shape = { n: ns.value };
        if (o.a !== 1 || s.n !== 7 || new Derived().kind() !== "base" || log.join() !== "effects")
            throw new Error("module evaluation: " + log.join());`,
        { fileName: resolve(directory, "entry.ts") },
    );
    runGeneratedProgram(tools, "module-evaluation", cpp, {});
});
