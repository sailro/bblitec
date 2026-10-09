import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { compileSource } from "../src/compiler.js";
import { createCompilerProgram } from "../src/compiler/program.js";
import {
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";

function check(name: string, source: string): void {
    test(name, (t) => {
        const fileName = resolve("nullable-erased-records.ts");
        const { program } = createCompilerProgram(source, fileName);
        assert.deepEqual(
            ts
                .getPreEmitDiagnostics(program)
                .map((diagnostic) =>
                    ts.flattenDiagnosticMessageText(
                        diagnostic.messageText,
                        " ",
                    ),
                ),
            [],
        );
        runInNewContext(
            ts.transpileModule(source, {
                compilerOptions: { target: ts.ScriptTarget.ES2022 },
            }).outputText,
        );
        const { cpp } = compileSource(source, { fileName });
        const tools = optionalNativeFixtureTools(false);
        if (!tools) return t.skip("Native fixture compiler unavailable.");
        runGeneratedProgram(tools, `nullable-erased-records/${name}`, cpp);
    });
}

for (const [name, declaration] of [
    ["explicit", "let first: Failure | null = null;"],
    [
        "inferred",
        "function initial(): Failure | null { return null; } let first = initial();",
    ],
] as const)
    check(
        `${name}-nullable-records-retain-caught-values-and-aliases`,
        `
        interface Failure {error: unknown; attempts: number}
        ${declaration}
        const sentinel = new Error('first');
        let allocations = 0;
        try {throw sentinel;} catch (error) {first ??= {error, attempts: ++allocations};}
        const alias = first;
        try {throw new Error('second');} catch (error) {first ??= {error, attempts: ++allocations};}
        if(first === null || alias !== first || first.error !== sentinel || allocations !== 1)
            throw new Error('first error identity and lazy allocation');
        alias!.attempts++;
        if(first.attempts !== 2) throw new Error('shared record');
        first = {error: 'replacement', attempts: 3};
        if(alias === first || alias!.error !== sentinel || first.error !== 'replacement')
            throw new Error('record replacement');
    `,
    );

check(
    "nullable-erased-records-distinguish-absent-and-own-undefined",
    `
    interface Failure {error: unknown; note?: unknown}
    let first: Failure | null = null;
    const sentinel = new Error('kept');
    try {throw sentinel;} catch (error) {first ??= {error};}
    if(!first || !Object.hasOwn(first, 'error') || Object.hasOwn(first, 'note'))
        throw new Error('initial presence');
    const alias = first;
    first.note = undefined;
    if(!Object.hasOwn(alias, 'note') || alias.error !== sentinel || alias.note !== undefined)
        throw new Error('own undefined');
    delete alias.note;
    if(Object.hasOwn(first, 'note')) throw new Error('deleted presence');
`,
);

check(
    "optional-reference-fields-retain-presence-identity-and-alias-writes",
    `
    interface Child {value:number}
    interface Item {child?:Child|null;read?:()=>number}
    const items:Item[]=[{}];
    const item=items[0]!;
    const alias:Item=item;
    function clear(value:Item):void {value.child=undefined;value.read=undefined;}
    const clears:Array<typeof clear>=[clear];
    const clearStored=clears[0]!;
    if(Object.hasOwn(alias,'child')||Object.hasOwn(alias,'read'))
        throw new Error('initially absent');
    clearStored(item);
    if(!Object.hasOwn(alias,'child')||!Object.hasOwn(alias,'read')||
        alias.child!==undefined||alias.read!==undefined)
        throw new Error('own undefined references');
    const child:Child={value:3};
    let calls=0;
    const read=()=>{calls++;return child.value;};
    function install(value:Item):void {value.child=child;value.read=read;}
    install(alias);
    function checkInstalled(value:Item):void {
        if(value.child!==child||value.read!==read||value.read?.()!==3)
            throw new Error('stored identities');
        value.child!.value=5;
    }
    checkInstalled(item);
    if(child.value!==5||calls!==1)throw new Error('live child and callback');
    function childValue(value:Child):number {return value.value;}
    function replaceThroughReceiver(value:Item, previous:Child):void {
        const replacement:Child={value:20};
        let replacements=0;
        function replaceChild():number {
            value.child=replacement;replacements++;return 9;
        }
        value.child!.value=replaceChild();
        if(previous.value!==9||value.child!==replacement||replacement.value!==20||replacements!==1)
            throw new Error('nested owner snapshot before right side');
        value['child']!.value=21;
        if(childValue(replacement)!==21)throw new Error('computed receiver alias');
    }
    replaceThroughReceiver(alias,child);
    item.child=null;
    if(!Object.hasOwn(alias,'child')||alias.child!==null)
        throw new Error('own null');
    delete alias.child;
    if(Object.hasOwn(item,'child')||!Object.hasOwn(item,'read'))
        throw new Error('independent deletion');
    delete item.read;
    if(Object.hasOwn(alias,'read'))throw new Error('callback deletion');
    clearStored(alias);
    if(!Object.hasOwn(item,'child')||!Object.hasOwn(item,'read')||
        item.child!==undefined||item.read!==undefined)
        throw new Error('readded own undefined');
`,
);

check(
    "optional-reference-initializers-and-assign-retain-own-undefined",
    `
    interface Item {child?:{value:number};read?:()=>number}
    const rows:Item[]=[{}, {child:undefined,read:undefined}];
    const absent=rows[0]!;
    const explicit=rows[1]!;
    if(Object.hasOwn(absent,'child')||Object.hasOwn(absent,'read')||
        !Object.hasOwn(explicit,'child')||!Object.hasOwn(explicit,'read'))
        throw new Error('initializer presence');
    const alias=absent;
    const assigned=Object.assign(absent,{child:undefined,read:undefined});
    if(assigned!==alias||!Object.hasOwn(alias,'child')||!Object.hasOwn(alias,'read')||
        alias.child!==undefined||alias.read!==undefined)
        throw new Error('assign undefined');
    delete explicit.child;
    if(Object.hasOwn(explicit,'child')||!Object.hasOwn(explicit,'read')||
        !Object.hasOwn(alias,'child'))
        throw new Error('independent initialized slots');
`,
);
