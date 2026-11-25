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

test("read-only and non-configurable data defined on a copy of a parsed record keep their attributes", (t) => {
    // One generic attach copies a parsed row and a fresh literal: the
    // parsed copy is a dynamic object, the literal's a record. Module code
    // is strict: a read-only write, a non-configurable delete and a
    // redefinition that changes a locked property throw.
    const source = `"use strict";
interface Token { readonly key: number }
interface Save { readonly id?: unknown; key: string; s: number }
function attach<T extends object>(row: T, id: Token): T & { readonly id: Token } {
    const item = { ...row } as T & { readonly id: Token };
    Object.defineProperty(item, "id", { value: id, enumerable: true, writable: false, configurable: false });
    return item;
}
const first: Token = { key: 1 };
const saves = JSON.parse('[{"key":"w1","s":0.5,"extra":true}]') as Save[];
const parsed = attach(saves[0]!, first);
const fresh = attach({ s: 2, y: 1 }, first);
if (parsed.id !== first || parsed.s !== 0.5 || fresh.id !== first || fresh.y !== 1) throw new Error("attached");
if (Object.keys(parsed).join(",") !== "key,s,extra,id") throw new Error("keys " + Object.keys(parsed).join(","));
if (JSON.stringify(parsed) !== '{"key":"w1","s":0.5,"extra":true,"id":{"key":1}}') throw new Error("stringify " + JSON.stringify(parsed));
let refused = 0;
const deny = (change: () => void): void => {
    try { change(); } catch (error) { if (error instanceof TypeError) refused++; }
};
deny(() => { (parsed as { id: Token }).id = { key: 2 }; });
deny(() => { delete (parsed as Partial<{ id: Token }>).id; });
deny(() => { Object.assign(parsed, { id: { key: 3 } }); });
deny(() => Object.defineProperty(parsed, "id", { value: { key: 4 }, enumerable: true, writable: false, configurable: false }));
Object.defineProperty(parsed, "id", { value: first, enumerable: true, writable: false, configurable: false });
if (refused !== 4 || parsed.id !== first) throw new Error("locked " + refused);
const copy = { ...parsed } as { id: Token };
copy.id = { key: 5 };
if (copy.id.key !== 5 || parsed.id !== first) throw new Error("spread copy");
const open = { ...saves[0]! } as Save & { s: number };
Object.defineProperty(open, "s", { value: 6, enumerable: true, writable: true, configurable: false });
open.s = 7;
Object.defineProperty(open, "s", { value: 8, enumerable: true, writable: false, configurable: false });
deny(() => { open.s = 9; });
if (refused !== 5 || open.s !== 8) throw new Error("writable then locked " + open.s);
`;
    return runSelfCheckingProgram(t, "document-read-only-data", source, {
        compile: { fileName: resolve("document-read-only-data.ts") },
        expectedOutput: "",
    });
});
