import { resolve } from "node:path";
import test from "node:test";
import { runSelfCheckingProgram } from "./self-checking-program.js";

test("a Proxy over a parsed record reads through its traps and the live target", (t) => {
    // The view computes one field, reads every other one from the parsed
    // object as it is now, lists the target's keys, and refuses writes
    // (module code is strict: a falsish trap result throws).
    const source = `"use strict";
interface Save { cx: number; cz: number; name: string }
let offset = 1;
const saves = JSON.parse('[{"cx":1,"cz":2,"name":"a"}]') as Save[];
const save = saves[0]!;
const view = new Proxy(save, {
    get(target, key) {
        if (key === "cx") return target.cx + offset;
        return target[key as keyof Save];
    },
    set() { return false; },
    deleteProperty() { return false; },
}) as Readonly<Save>;
offset = 3;
if (view.cx !== 4 || view.cz !== 2 || view.name !== "a") throw new Error("trap reads");
save.cz = 5;
if (view.cz !== 5) throw new Error("live target");
if (Object.keys(view).join(",") !== "cx,cz,name") throw new Error("target keys");
if (JSON.stringify(view) !== '{"cx":4,"cz":5,"name":"a"}') throw new Error("stringify " + JSON.stringify(view));
let refused = false;
try { (view as Save).cz = 9; } catch (error) { refused = error instanceof TypeError; }
if (!refused || save.cz !== 5) throw new Error("set trap");
`;
    return runSelfCheckingProgram(t, "document-proxy", source, {
        compile: { fileName: resolve("document-proxy.ts") },
        expectedOutput: "",
    });
});
