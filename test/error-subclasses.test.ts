import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { compileSource } from "../src/compiler.js";
import {
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";
const cases = {
    direct: `class Failure extends Error {readonly path:string;constructor(path:string,message:string){super(path+': '+message);this.name='Failure';this.path=path;}}const failure=new Failure('field','bad');if(failure.message!=='field: bad'||failure.name!=='Failure'||failure.path!=='field')throw new Error('fields');`,
    defaults: `class Failure extends TypeError {}const failure=new Failure('bad');if(failure.message!=='bad'||failure.name!=='TypeError'||!(failure instanceof Error)||!(failure instanceof TypeError)||failure instanceof RangeError)throw new Error('base');`,
    catches: `class Failure extends Error{constructor(readonly path:string){super('bad');this.name='Failure';}}const failure=new Failure('field');try{throw failure;}catch(error){if(!(error instanceof Failure)||!(error instanceof Error)||error.path!=='field'||error.message!=='bad'||error!==failure)throw new Error('catch');error.message='after';}if(failure.message!=='after')throw new Error('live alias');`,
    hierarchy: `let order='';function arg():string{order+='A';return 'message';}class Failure extends Error{value=1;constructor(message:string){order+='B';super(message);order+='C';}}class Detailed extends Failure{extra=2;constructor(message:string){order+='D';super(message);order+='E';}}const value=new Detailed(arg());if(order!=='ADBCE'||value.value!==1||value.extra!==2||!(value instanceof Detailed)||!(value instanceof Failure))throw new Error('construction');`,
    arrays: `class Failure extends Error {constructor(readonly path:string){super('bad');}}const failure=new Failure('field');const errors:Error[]=[failure];try{throw errors[0]!;}catch(error){if(!(error instanceof Failure)||error.path!=='field'||error!==failure)throw new Error('array');}`,
    promises: `class Failure extends Error{constructor(readonly path:string){super('bad');}}const failure=new Failure('field');Promise.resolve().then(()=>{throw failure;}).catch(error=>{if(!(error instanceof Failure)||error.path!=='field'||error!==failure)throw new Error('rejected');globalThis.close();});`,
    retained: `
        class Failure extends Error {
            readonly errors: Error[] = [];
            constructor(readonly path: string) { super('before'); }
        }
        function capture(): () => Error {
            const failure = new Failure('retained');
            failure.errors.push(failure);
            try { throw failure; }
            catch (error) {
                if (!(error instanceof Failure)) throw new Error('narrowing');
                error.message = 'after';
                return () => error;
            }
        }
        const retained = capture();
        const error = retained();
        if (!(error instanceof Failure) || error.path !== 'retained' ||
            error.message !== 'after' || error.errors[0] !== error)
            throw new Error('retained identity');
    `,
    promiseCycle: `
        class Failure extends Error { readonly promises: Promise<void>[] = []; }
        const failure = new Failure('cycle');
        const rejected = Promise.resolve().then(() => { throw failure; });
        failure.promises.push(rejected);
        rejected.catch(error => {
            if (!(error instanceof Failure) || error !== failure || error.promises[0] !== rejected)
                throw new Error('rejection cycle');
            globalThis.close();
        });
    `,
    promiseErrorValue: `
        class Failure extends Error {}
        const failure = new Failure('value');
        const erased: Error[] = [failure];
        Promise.resolve<Error>(erased[0]!).then(value => {
            if (value !== failure) throw new Error('fulfilled Error value');
            return Promise.resolve<Error>(value).then(() => { throw failure; });
        }).catch(error => {
            if (error !== failure) throw new Error('rejected Error value');
            globalThis.close();
        });
    `,
    narrowedStorage: `
        class Failure extends Error { constructor(readonly path: string) { super('stored'); } }
        const failure = new Failure('path');
        const callbacks: ((value: Failure) => Failure)[] = [value => value];
        const retained: Failure[] = [];
        try { throw failure; }
        catch (error) {
            if (!(error instanceof Failure)) throw error;
            retained.push(callbacks[0]!(error));
        }
        if (retained[0] !== failure) throw new Error('narrowed owner');
        retained[0]!.message = 'changed';
        if (failure.message !== 'changed') throw new Error('narrowed mutation');
    `,
    effects: `
        let order = '';
        function message(): string { order += 'M'; return 'bad'; }
        function cause(): Error { order += 'C'; return new Error('cause'); }
        class Failure extends Error { constructor() { super(message(), {cause: cause()}); order += 'B'; } }
        class Inherited extends TypeError {}
        class Default extends Inherited {}
        const failure = new Failure();
        const inherited = new Default(message());
        if (order !== 'MCBM' || failure.message !== 'bad' || inherited.message !== 'bad')
            throw new Error('argument effects');
        const unrelated = new Error('ordinary');
        class Other { value = 1; }
        let reads = 0;
        function read(): Error { reads++; return unrelated; }
        if (read() instanceof Other || reads !== 1) throw new Error('instanceof effects');
    `,
};
for (const [name, source] of Object.entries(cases)) {
    test(`authored Error subclasses preserve ${name}`, async (t) => {
        await runInNewContext(
            ts.transpile(source, { target: ts.ScriptTarget.ES2022 }),
            { close: () => {} },
        );
        const result = compileSource(source);
        const tools = optionalNativeFixtureTools(false);
        if (!tools) {
            t.skip("Native fixture compiler unavailable.");
            return;
        }
        runGeneratedProgram(
            tools,
            `error-subclasses/${name}`,
            `#define main generated_main\n${result.cpp}\n#undef main\nint main(){const auto baseline=bbl::js::managed_node_count();const int result=generated_main();bbl::js::collect_cycles();if(bbl::js::managed_node_count()!=baseline)return 91;return result;}`,
            {
                flags: name.startsWith("promise") ? ["/DBBLITE_WORKERS=1"] : [],
                timeoutMs: 10000,
            },
        );
    });
}

test("authored Error reflection refuses unrepresented descriptors", () => {
    for (const operation of [
        "Object.keys(value)",
        "Object.entries(value)",
        "({...value})",
    ])
        assert.throws(
            () =>
                compileSource(
                    `class Failure extends Error {} const value = new Failure('bad'); const result = ${operation};`,
                ),
            /Error reflection requires represented property descriptors/,
        );
});

test("authored Error erasure refuses direct and nested dynamic views", () => {
    for (const body of [
        "document.value = new Failure('bad');",
        `const rows: Array<{error: Failure}> = [];
        rows.push({error: new Failure('bad')});
        document.value = rows[0]!;`,
        `class Detailed extends Failure { detail = 'extra'; }
        const rows: Detailed[] = [];
        rows.push(new Detailed('bad'));
        document.value = rows[0]!;`,
    ])
        assert.throws(
            () =>
                compileSource(`
                    class Failure extends Error { label = 'tag'; }
                    const document = JSON.parse('{}') as Record<string, unknown>;
                    ${body}
                `),
            /Authored Error reflection requires represented property descriptors/,
        );
});

test("opaque cause and aggregate storage refuse authored payloads after argument effects", (t) => {
    const result = compileSource(`
        class Failure extends Error {}
        const failure = new Failure('payload');
        const erased: Error[] = [failure];
        let order = '', refused = 0;
        function message(): string { order += 'M'; return 'outer'; }
        function cause(): Error { order += 'C'; return erased[0]!; }
        try { new Error(message(), {cause: cause()}); }
        catch (error) {
            if (error.message !== 'Authored Error payloads require traced cause and AggregateError storage.') throw error;
            refused++;
        }
        try { new AggregateError(erased, message()); }
        catch (error) {
            if (error.message !== 'Authored Error payloads require traced cause and AggregateError storage.') throw error;
            refused++;
        }
        if (refused !== 2 || order !== 'MCM') throw new Error('opaque edge admission');
    `);
    const tools = optionalNativeFixtureTools(false);
    if (!tools) {
        t.skip("Native fixture compiler unavailable.");
        return;
    }
    runGeneratedProgram(tools, "error-subclasses/opaque-edges", result.cpp);
});
