import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { compileSource } from "../src/compiler.js";
import {
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";

function check(name: string, source: string): void {
    test(name, (t) => {
        runInNewContext(
            '"use strict";\n' +
                ts.transpileModule(source, {
                    compilerOptions: { target: ts.ScriptTarget.ES2022 },
                }).outputText,
        );
        const result = compileSource(source);
        const native = optionalNativeFixtureTools(false);
        if (!native) return t.skip("Native fixture compiler unavailable.");
        runGeneratedProgram(native, `receiver-definitions/${name}`, result.cpp);
    });
}

test("receiver descriptor state preserves callback identity and rejects locked deletion", (t) => {
    const native = optionalNativeFixtureTools(false);
    if (!native) return t.skip("Native fixture compiler unavailable.");
    runGeneratedProgram(
        native,
        "receiver-definitions/descriptor-state",
        `
        #include <bblite/js_accessor.hpp>
        #include <cassert>
        int main() {
            using Slot = bbl::js::ReceiverAccessor<double, double>;
            const bbl::js::Callback<double(double)> getter([](double receiver) { return receiver; });
            Slot target(1.0);
            target.define(Slot(getter, {}), false, false, 2.0);
            target.define(Slot(getter, {}), false, false, 3.0);
            assert(target.get() == 3.0);
            assert(!target.erase());
            assert(!target.try_define(Slot(4.0), false, false, 3.0));
            int denied = 0;
            try { static_cast<void>(target.check_proxy_delete()); }
            catch (const bbl::js::NamedError& error) { if (error.name == "TypeError") ++denied; }
            try { static_cast<void>(target.check_proxy_set()); }
            catch (const bbl::js::NamedError& error) { if (error.name == "TypeError") ++denied; }
            try { static_cast<void>(target.check_proxy_value_definition()); }
            catch (const bbl::js::NamedError& error) { if (error.name == "TypeError") ++denied; }
            assert(denied == 3);

            // An adapted absent callback can have an identity without a callable body.
            const bbl::js::Callback<bool(double, double)> absent_setter(
                static_cast<bool (*)(double, double)>(nullptr));
            Slot absent;
            absent.define(Slot(getter, absent_setter), false, false, 1.0);
            assert(absent.check_proxy_definition(Slot(getter, absent_setter), false, false));
            assert(absent.check_proxy_definition(Slot(getter, {}), false, true));
            denied = 0;
            try { static_cast<void>(absent.check_proxy_set()); }
            catch (const bbl::js::NamedError& error) { if (error.name == "TypeError") ++denied; }
            try { static_cast<void>(absent.check_proxy_definition(Slot(getter, {}), false, false)); }
            catch (const bbl::js::NamedError& error) { if (error.name == "TypeError") ++denied; }
            assert(denied == 2);

            std::weak_ptr<double> captured;
            const auto snapshot = [&] {
                const auto owner = std::make_shared<double>(7.0);
                captured = owner;
                Slot transient(bbl::js::make_closure(std::tuple{owner},
                    [](auto& state, double) { return *std::get<0>(state); }), {});
                return transient.descriptor_state();
            }();
            assert(snapshot.has_getter && !snapshot.has_setter);
            assert(captured.expired());
        }
    `,
    );
});

check(
    "descriptor-captures-retain-forward-bindings-and-instance-state",
    `
    interface State {x:number}
    const target:State={x:0};
    const view=new Proxy(target,{});
    Object.defineProperty(target,"x",{get:()=>read(),enumerable:true,configurable:true});
    let denied=0;
    let completed=false;
    try { const early=view.x; completed=true; }
    catch(error) { if(!String(error).includes("before initialization"))throw error; denied++; }
    let count=1;
    const read=()=>++count;
    if(completed||denied!==1||view.x!==2||target.x!==3)throw new Error("forward capture");
    function create(start:number):State {
        let state=start;
        const result:State={x:0};
        Object.defineProperty(result,"x",{get:()=>++state,enumerable:true,configurable:true});
        return result;
    }
    const first=create(10);
    const second=create(20);
    if(first.x!==11||second.x!==21||first.x!==12||second.x!==22)throw new Error("instance capture");
`,
);

check(
    "plain-objects-share-proxy-layout-with-independent-descriptors",
    `
    interface State { x: number; y: number; base: number; }
    const target: State = {x: 1, y: 2, base: 3};
    const proxy = new Proxy(target, { get(owner, key) { return owner[key as keyof State] + 10; } });
    const copy: State = {...target};
    let reads = 0;
    let offset = 5;
    let sets = 0;
    function define(view: State): State {
        return Object.defineProperties(view, {
            x: {enumerable: true, configurable: false, get: () => { reads++; return target.base + offset; }},
            y: {
                enumerable: true, configurable: true,
                get(this: State) { return this.base * 2; },
                set(this: State, value: number) { sets++; this.base = value; },
            },
        });
    }
    const alias = define(copy);
    if (alias !== copy || reads !== 0 || proxy.x !== 11 || target.x !== 1 || alias.x !== 8)
        throw new Error("independent objects");
    target.base = 7; offset = 9;
    alias.y = 4;
    if (alias.x !== 16 || alias.y !== 8 || copy.base !== 4 || target.base !== 7 || sets !== 1)
        throw new Error("captures and setter");
    if (Reflect.get(copy, "y", target) !== 14) throw new Error("alternate receiver");
    Object.defineProperty(copy, "y", {
        enumerable: true, configurable: true, get(this: State) { return this.base * 3; },
    });
    alias.y = 6;
    if (copy.base !== 6 || copy.y !== 18 || sets !== 2) throw new Error("omitted setter");
    let denied = 0;
    try { alias.x = 99; } catch { denied++; }
    try { Object.defineProperty(copy, "x", {value: 99, writable: true, enumerable: true, configurable: true}); }
    catch { denied++; }
    Object.defineProperty(copy, "y", {value: 12, writable: true, enumerable: true, configurable: true});
    alias.y = 13;
    if (denied !== 2 || alias.x !== 16 || alias.y !== 13 || sets !== 2) throw new Error("replacement");
    const fresh: State = {...copy};
    Object.defineProperty(fresh, "x", {value: 2, writable: true, enumerable: true, configurable: true});
    if (fresh.x !== 2 || copy.x !== 16 || Object.keys(copy).join() !== "x,y,base") throw new Error("copy attributes");
`,
);

check(
    "proxy-definitions-forward-reject-and-enforce-target-invariants",
    `
    interface State { x: number; base: number; }
    const target: State = {x: 1, base: 2};
    const forward = new Proxy(target, {});
    const nested = new Proxy(forward, {});
    Object.defineProperty(nested, "x", {
        enumerable: true, configurable: true,
        get(this: State) { return this.base * 3; },
        set(this: State, value: number) { this.base = value; },
    });
    if (target.x !== 6 || forward.x !== 6 || nested.x !== 6) throw new Error("forward definition");
    const other: State = {x: 0, base: 4};
    if (Reflect.get(nested, "x", other) !== 12) throw new Error("nested getter receiver");
    forward.x = 5;
    if (target.base !== 5 || target.x !== 15) throw new Error("forward setter");
    let effects = 0;
    let traps = 0;
    function value(): number { effects++; return 8; }
    const reject = new Proxy(target, {set() {return false;}, defineProperty() {traps++; return false;}});
    let denied = 0;
    try { Object.defineProperties(reject, {
        x: {value: value(), writable: true, enumerable: true, configurable: true},
        base: {value: value(), writable: true, enumerable: true, configurable: true},
    }); } catch { denied++; }
    if (effects !== 2 || traps !== 1 || target.x !== 15) throw new Error("collected before rejected trap");
    const accept = new Proxy(nested, {set() {return false;}, defineProperty() {traps++; return true;}});
    Object.defineProperty(accept, "x", {value: value(), writable: true, enumerable: true, configurable: true});
    if (target.x !== 15 || effects !== 3 || traps !== 2) throw new Error("successful trap does not define");
    try { Object.defineProperty(accept, "x", {value: value(), writable: true, enumerable: true, configurable: false}); }
    catch { denied++; }
    Object.defineProperty(target, "x", {get: () => 17, enumerable: true, configurable: false});
    try { Object.defineProperty(accept, "x", {value: value(), writable: true, enumerable: true, configurable: true}); }
    catch { denied++; }
    try { Object.defineProperty(accept, "x", {get: () => 19, enumerable: true, configurable: false}); }
    catch { denied++; }
    if (denied !== 4 || traps !== 5 || target.x !== 17 || nested.x !== 17) throw new Error("proxy invariants");
    const lying = new Proxy(other, {set() {return true;}, defineProperty() {return true;}});
    Object.defineProperty(other, "x", {get: () => 21, enumerable: true, configurable: false});
    try { lying.x = 22; } catch { denied++; }
    try { Reflect.set(lying, "x", 23); } catch { denied++; }
    try { Object.defineProperty(lying, "x", {value: 24}); } catch { denied++; }
    if (denied !== 7 || other.x !== 21) throw new Error("locked getter trap invariants");
`,
);
