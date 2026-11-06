import { resolve } from "node:path";
import test from "node:test";
import { runSelfCheckingProgram } from "./self-checking-program.js";

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
    return runSelfCheckingProgram(t, "document-accessors", source, {
        compile: { fileName: resolve("document-accessors.ts") },
        expectedOutput: "",
    });
});

test("a literal spreading a parsed record keeps its getters as accessors", (t) => {
    // The spread copies every parsed key; the getters read state that
    // changes after the literal is built, in their own places.
    const source = `"use strict";
interface Feel { orbit: number; pan: number; zoom: number }
let weight = 1;
function resolveFeel<T extends { orbit: number; pan: number }>(authored: T): T {
    return {
        ...authored,
        get orbit() { return 0.5 * weight; },
        get pan() { return 0.25 * weight; },
    };
}
const config = JSON.parse('{"orbit":0.9,"pan":0.8,"zoom":2,"label":"classic"}') as Feel;
const feel = resolveFeel(config);
weight = 2;
if (feel.orbit !== 1 || feel.pan !== 0.5 || feel.zoom !== 2) throw new Error("getters " + feel.orbit);
if (Object.keys(feel).join(",") !== "orbit,pan,zoom,label") throw new Error("keys " + Object.keys(feel).join(","));
if (JSON.stringify(feel) !== '{"orbit":1,"pan":0.5,"zoom":2,"label":"classic"}') throw new Error("stringify " + JSON.stringify(feel));
let refused = false;
try { feel.orbit = 3; } catch (error) { refused = error instanceof TypeError; }
if (!refused || feel.orbit !== 1) throw new Error("getter-only write");
`;
    return runSelfCheckingProgram(t, "document-literal-getters", source, {
        compile: { fileName: resolve("document-literal-getters.ts") },
        expectedOutput: "",
    });
});
