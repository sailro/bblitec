import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { compileSource } from "../src/compiler.js";
import {
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";

test("WeakMap accepts stored callback keys and retained plain object values", async (t) => {
    const source = `
        let state=2;
        const callbacks:Array<()=>number>=[()=>state,()=>state];
        const first=callbacks[0]!;
        const repeated=first;
        const distinct=callbacks[1]!;
        const values=new WeakMap<object,number>();
        values.set(first,7);
        if(values.get(repeated)!==7||values.has(distinct))throw new Error('callback identity');
        state=4;if(first()!==4)throw new Error('callback captures');
        if(!values.delete(repeated)||values.has(first))throw new Error('callback deletion');
        const key={id:1}, payload={value:2};
        const objects=new WeakMap<object,object>();
        objects.set(key,payload);
        const retained=objects.get(key) as {value:number};
        if(retained!==payload)throw new Error('payload identity');
        retained.value=9;
        if(payload.value!==9)throw new Error('payload alias');
    `;
    runInNewContext(
        ts.transpileModule(source, {
            compilerOptions: {
                target: ts.ScriptTarget.ES2022,
                module: ts.ModuleKind.None,
            },
        }).outputText,
    );
    const result = compileSource(source);
    const native = optionalNativeFixtureTools(false);
    await t.test("native assertions", { skip: !native }, () => {
        runGeneratedProgram(native!, "weak-callback-owners/stored", result.cpp);
    });
});

test(
    "Weak callback identity survives signature adapters and expires with its owners",
    { skip: !optionalNativeFixtureTools(false) },
    () => {
        runGeneratedProgram(
            optionalNativeFixtureTools(false)!,
            "weak-callback-owners/lifetime",
            `
        #include <bblite/js_data.hpp>
        #include <cassert>
        int main(){
            bbl::js::WeakMap<int> values;
            bbl::js::WeakIdentity identity;
            bbl::js::Callback<double()> adapted;
            {
                bbl::js::Callback<int()> original([]{return 3;});
                const auto alias=original;
                identity=original.weak_identity();
                values.set(identity,7);
                adapted=bbl::js::adapt_callback<bbl::js::Callback<double()>>(original,
                    [](auto& callback)->double{return callback();});
                assert(adapted.identity()==original.identity());
                assert(values.get(adapted.weak_identity()).value()==7);
                original={};
                assert(!identity.expired());
                assert(values.get(alias.weak_identity()).value()==7);
            }
            assert(!identity.expired());
            assert(adapted()==3);
            adapted={};
            assert(identity.expired());
            assert(!values.has(identity));
        }
    `,
        );
    },
);
