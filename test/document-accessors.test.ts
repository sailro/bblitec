import { resolve } from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { compileSource } from "../src/compiler.js";
import {
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";

test("accessors defined on a copy of a parsed record read live and keep their places", (t) => {
    // The copy keeps every parsed key; two of them become getters over a
    // value that changes later. Module code is strict: a getter-only write
    // and a non-configurable delete throw.
    const source = `"use strict";
interface Save { cx: number; cz: number; name: string }
let offset = 1;
function preview(save: Save): Readonly<Save> {
    const view = { ...save } as Save;
    Object.defineProperties(view, {
        cx: { enumerable: true, configurable: false, get: () => save.cx + offset },
        cz: { enumerable: true, configurable: true, get: () => save.cz * offset },
    });
    return view;
}
const saves = JSON.parse('[{"cx":1,"cz":2,"name":"a","extra":true}]') as Save[];
const view = preview(saves[0]!);
offset = 3;
if (view.cx !== 4 || view.cz !== 6 || view.name !== "a") throw new Error("getters");
if (Object.keys(view).join(",") !== "cx,cz,name,extra") throw new Error("keys " + Object.keys(view).join(","));
if (JSON.stringify(view) !== '{"cx":4,"cz":6,"name":"a","extra":true}') throw new Error("stringify " + JSON.stringify(view));
let refused = 0;
try { (view as Save).cx = 9; } catch (error) { if (error instanceof TypeError) refused++; }
try { delete (view as Partial<Save>).cx; } catch (error) { if (error instanceof TypeError) refused++; }
if (refused !== 2 || view.cx !== 4) throw new Error("refused " + refused);
`;
    runInNewContext(
        ts.transpileModule(source, {
            compilerOptions: { target: ts.ScriptTarget.ES2022 },
        }).outputText,
    );
    const { cpp } = compileSource(source, {
        fileName: resolve("document-accessors.ts"),
    });
    const native = optionalNativeFixtureTools(false);
    if (!native) return t.skip("Native fixture compiler unavailable.");
    runGeneratedProgram(native, "document-accessors", cpp, {
        expectedOutput: "",
    });
});
