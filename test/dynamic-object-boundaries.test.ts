import assert from "node:assert/strict";
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
            ts.transpileModule(source, {
                compilerOptions: { target: ts.ScriptTarget.ES2022 },
            }).outputText,
        );
        const result = compileSource(source);
        const tools = optionalNativeFixtureTools(false);
        if (!tools) {
            t.skip("Native fixture compiler unavailable.");
            return;
        }
        runGeneratedProgram(
            tools,
            `dynamic-object-boundaries/${name}`,
            result.cpp,
        );
    });
}

check(
    "owned JSON assignment keeps identity and argument order",
    `
    const target: Record<string, unknown> = JSON.parse('{"old":1}');
    const alias = target;
    const first = { value: 1 };
    function later() { first.value = 2; return { tail: 3 }; }
    const result = Object.assign(target, first, later(), null, undefined, 'xy', 4, false);
    if (result !== alias || alias.value !== 2 || alias.tail !== 3)
        throw new Error('assignment identity or argument order');
    if (Object.keys(alias).join(',') !== '0,1,old,value,tail')
        throw new Error('property order');
    if (alias['0'] !== 'x' || alias['1'] !== 'y') throw new Error('string source');
    const nested: Record<string, unknown> = JSON.parse('{"child":{"value":4}}');
    Object.assign(target, nested);
    if (target.child !== nested.child) throw new Error('nested identity');
    function fail(shouldThrow: boolean): Record<string, unknown> {
        if (shouldThrow) throw new Error('later argument');
        return JSON.parse('{}');
    }
    const flags = [true];
    try { Object.assign(target, { never: 1 }, fail(flags[0]!)); } catch {}
    if (Object.hasOwn(target, 'never')) throw new Error('copy before arguments');
`,
);

check(
    "JSON rest copies own keys and retains nested identity",
    `
    const source: Record<string, unknown> = JSON.parse('{"skip":1,"child":{"n":2},"keep":3}');
    const { skip, missing = (source.extra = 4), ...rest } = source;
    if (skip !== 1 || missing !== 4 || rest === source || rest.child !== source.child)
        throw new Error('rest identity');
    if (Object.keys(rest).join(',') !== 'child,keep,extra') throw new Error('rest keys');
    delete source.keep;
    if (rest.keep !== 3) throw new Error('rest independence');
    rest.value = 5;
    if (source.value !== undefined) throw new Error('fresh rest');
    const again = { ...rest };
    if (again.child !== rest.child) throw new Error('spread identity');
`,
);

check(
    "owned JSON copies preserve self assignment and numeric key order",
    `
    const source: Record<string, unknown> = JSON.parse('{"tail":1,"10":"ten","2":"two","child":{"n":3},"__proto__":null}');
    const child = source.child;
    if (Object.assign(source, source, source) !== source || source.child !== child)
        throw new Error('self assignment identity');
    if (Object.keys(source).join(',') !== '2,10,tail,child,__proto__')
        throw new Error('self assignment order');
    const { tail, ...rest } = source;
    if (tail !== 1 || rest === source || rest.child !== child || rest.__proto__ !== null)
        throw new Error('rest values');
    if (Object.keys(rest).join(',') !== '2,10,child,__proto__')
        throw new Error('rest numeric order');
    const target: Record<string, unknown> = JSON.parse('{"__proto__":null,"first":0}');
    Object.assign(target, source);
    if (Object.keys(target).join(',') !== '2,10,__proto__,first,tail,child' || target.child !== child)
        throw new Error('assignment numeric order');
`,
);

check(
    "dynamic optional deletion evaluates receiver then key once",
    `
    interface Item { a?: string; b?: string; keep: number; }
    const items: Item[] = [{ a: 'a', b: 'b', keep: 3 }];
    let order = '';
    function owner(): Item { order += 'o'; return items[0]!; }
    function key(): 'a' | 'b' { order += 'k'; return 'a'; }
    delete owner()[key()];
    if (order !== 'ok' || Object.hasOwn(items[0]!, 'a') || items[0]!.b !== 'b')
        throw new Error('delete evaluation');
    function drop(item: Item, key: 'a' | 'b') { delete item[key]; }
    const drops: Array<typeof drop> = [drop];
    drops[0]!(items[0]!, 'b');
    if (Object.keys(items[0]!).join(',') !== 'keep') throw new Error('delete presence');
`,
);

check(
    "dynamic JSON scalar writes preserve both absent values",
    `
    const target: Record<string, unknown> = JSON.parse('{}');
    function store(value: number | null | undefined) { target.value = value; }
    const stores: Array<typeof store> = [store];
    stores[0]!(null);
    if (target.value !== null || JSON.stringify(target) !== '{"value":null}')
        throw new Error('null');
    stores[0]!(undefined);
    if (target.value !== undefined || !Object.hasOwn(target, 'value') || JSON.stringify(target) !== '{}')
        throw new Error('undefined own property');
    stores[0]!(7);
    if (target.value !== 7) throw new Error('present');
`,
);

check(
    "plain records with erased annotations serialize represented fields",
    `
    function make(value: number | null | undefined): Record<string, unknown> { return { value }; }
    const makers: Array<typeof make> = [make];
    const nil = makers[0]!(null), absent = makers[0]!(undefined), present = makers[0]!(3);
    if (JSON.stringify(nil) !== '{"value":null}' || JSON.stringify(absent) !== '{}' || JSON.stringify(present) !== '{"value":3}')
        throw new Error('erased record fields');
`,
);

check(
    "required field deletion promotes every plain record alias",
    `
    interface Item { first: number; second: string; optional?: number; empty: number | undefined; }
    const items: Item[] = [{ first: 1, second: 'two', optional: 3, empty: undefined }];
    const item = items[0]!;
    const aliases: Array<{ first: number }> = [item];
    const alias = aliases[0]!;
    delete (item as Partial<Item>).first;
    const absent: unknown = alias.first;
    if (Object.hasOwn(alias, 'first') || 'first' in alias || alias.first !== undefined || typeof alias.first !== 'undefined' || absent !== undefined || item !== alias)
        throw new Error('alias deletion');
    if (!Object.hasOwn(item, 'empty')) throw new Error('own undefined before delete');
    function drop(value: Item, key: string) { delete (value as unknown as Record<string, unknown>)[key]; }
    const drops: Array<typeof drop> = [drop];
    drops[0]!(item, 'empty');
    drops[0]!(item, 'optional');
    drops[0]!(item, 'missing');
    if (Object.keys(item).join(',') !== 'second') throw new Error('dynamic keys');
    item.first = 4;
    if (alias.first !== 4 || Object.keys(item).join(',') !== 'second,first')
        throw new Error('readded property');
`,
);

check(
    "dynamic deletion evaluates its key before refusing a null receiver",
    `
    interface Item { first?: number; }
    const values: Array<Item | null> = [null];
    let order = '';
    function owner(): Item | null { order += 'o'; return values[0]!; }
    function key(): string { order += 'k'; return 'missing'; }
    let caught = false;
    try { delete (owner() as Record<string, unknown>)[key()]; } catch { caught = true; }
    if (!caught || order !== 'ok') throw new Error('null deletion order');
`,
);

test("required deletion refuses records with retained function fields", () => {
    assert.throws(
        () =>
            compileSource(`
        interface Item { value: number; read: () => number; }
        const items: Item[] = [{ value: 3, read: () => 3 }];
        delete (items[0]! as Partial<Item>).value;
    `),
        /required field/,
    );
});

check(
    "optional nullable deletion clears value and own presence",
    `
    interface Item { value?: number[] | null; count?: number | null; }
    const items: Item[] = [{ value: null, count: null }];
    const item = items[0]!;
    if (item.value !== null || item.count !== null) throw new Error('initial null');
    function drop(value: Item, key: 'value' | 'count') { delete value[key]; }
    const drops: Array<typeof drop> = [drop];
    drops[0]!(item, 'value');
    drops[0]!(item, 'count');
    if (Object.hasOwn(item, 'value') || Object.hasOwn(item, 'count') || item.value !== undefined || item.count !== undefined)
        throw new Error('deleted nullable fields');
`,
);

check(
    "heterogeneous dictionary views retain fields and nullable values",
    `
    interface Item {
        count: number;
        label: string;
        nullable: number | null;
        optional?: number;
        either: number | null | undefined;
        child: { value: number };
    }
    const items: Item[] = [{ count: 3, label: 'x', nullable: null, either: null, child: { value: 4 } }];
    const source = items[0]!;
    function pick(value: Record<string, unknown>, key: string): unknown { return value[key]; }
    const picks: Array<typeof pick> = [pick];
    const view = source as unknown as Record<string, unknown>;
    if (picks[0]!(view, 'count') !== 3 || picks[0]!(view, 'label') !== 'x')
        throw new Error('heterogeneous fields');
    if (picks[0]!(view, 'nullable') !== null || picks[0]!(view, 'either') !== null)
        throw new Error('nullable fields');
    if (picks[0]!(view, 'optional') !== undefined || picks[0]!(view, 'absent') !== undefined)
        throw new Error('absent fields');
    source.count = 9;
    source.either = undefined;
    if (picks[0]!(view, 'count') !== 9 || picks[0]!(view, 'either') !== undefined)
        throw new Error('live fields');
    const target: Record<string, unknown> = JSON.parse('{}');
    Object.assign(target, source);
    if (target.child !== source.child || target.nullable !== null || target.either !== undefined)
        throw new Error('retained native fields');
    if (!Object.hasOwn(target, 'either') || Object.hasOwn(target, 'optional'))
        throw new Error('native own fields');
`,
);

check(
    "dynamic assignment reads source getters once in key order",
    `
    const target: Record<string, unknown> = JSON.parse('{}');
    let order = '';
    let current = 1;
    const source = {
        get first() { order += 'a'; return current; },
        get second() { order += 'b'; if (current > 0) throw new Error('getter'); return 0; },
        get third() { order += 'c'; return current; },
    };
    function later() { current = 7; order += 'z'; return {}; }
    try { Object.assign(target, source, later()); } catch {}
    if (order !== 'zab' || target.first !== 7 || Object.hasOwn(target, 'second') || Object.hasOwn(target, 'third'))
        throw new Error('getter copy order');
`,
);

check(
    "native JSON fields retain tagged arrays and null-only values",
    `
    interface Item { values: number[] | null | undefined; empty: null; }
    const items: Item[] = [{ values: null, empty: null }];
    const source = items[0]!;
    const target: Record<string, unknown> = JSON.parse('{}');
    Object.assign(target, source);
    if (target.values !== null || target.empty !== null) throw new Error('null fields');
    source.values = undefined;
    Object.assign(target, source);
    if (target.values !== undefined || !Object.hasOwn(target, 'values'))
        throw new Error('undefined field');
    const values = [2, 3];
    source.values = values;
    Object.assign(target, source);
    if (target.values !== values) throw new Error('array identity');
`,
);

check(
    "property assignments evaluate receiver getters once",
    `
    const rows: Array<{ count: number; x: number }> = [{ count: 3, x: 0 }];
    let order = '';
    const host = { get child() { order += 'g'; return rows[0]!; } };
    function value(): number { order += 'r'; return 7; }
    host.child.count = value();
    if (order !== 'gr' || rows[0]!.count !== 7) throw new Error('plain receiver');
    order = '';
    host.child.count += value();
    if (order !== 'gr' || rows[0]!.count !== 14) throw new Error('compound receiver');
    order = '';
    host.child.x = value();
    if (order !== 'gr' || rows[0]!.x !== 7) throw new Error('vector-name receiver');
    let stored = 0;
    const child = { set count(value: number) { order += 's'; stored = value; } };
    const setterHost = { get child() { order += 'g'; return child; } };
    order = '';
    setterHost.child.count = value();
    if (order !== 'grs' || stored !== 7) throw new Error('setter receiver');
`,
);

check(
    "property assignments retain the receiver before the right side",
    `
    const rows: Array<{ count: number }> = [{ count: 3 }];
    const original = rows[0]!;
    let reads = 0;
    const host = { get child() { reads++; return rows[0]!; } };
    function replace(): number { rows[0] = { count: 100 }; return 7; }
    host.child.count = replace();
    if (reads !== 1 || original.count !== 7 || rows[0]!.count !== 100)
        throw new Error('receiver before right side');
    const previous = rows[0]!;
    function mutate(): number { rows[0]!.count = 50; rows[0] = { count: 200 }; return 7; }
    host.child.count += mutate();
    if (reads !== 2 || previous.count !== 107 || rows[0]!.count !== 200)
        throw new Error('compound value before right side');
`,
);

check(
    "dynamic deletion evaluates property receiver getter once",
    `
    const target: Record<string, unknown> = JSON.parse('{"value":3}');
    let reads = 0;
    const wrapper = { get document() { reads++; return target; } };
    delete wrapper.document.value;
    if (reads !== 1 || Object.hasOwn(target, 'value')) throw new Error('delete getter');
`,
);

check(
    "JSON rest and existing own prototype keys remain data properties",
    `
    const source: Record<string, unknown> = JSON.parse('{"__proto__":{"value":3},"other":4}');
    const { other, ...rest } = source;
    if (other !== 4 || !Object.hasOwn(rest, '__proto__') || rest.__proto__ !== source.__proto__)
        throw new Error('rest prototype key');
    const target: Record<string, unknown> = JSON.parse('{"__proto__":null}');
    Object.assign(target, source);
    if (!Object.hasOwn(target, '__proto__') || target.__proto__ !== source.__proto__)
        throw new Error('own prototype key');
`,
);

test("dynamic assignment refuses inherited prototype mutation", (t) => {
    const result = compileSource(`
        const target: Record<string, unknown> = JSON.parse('{}');
        const source: Record<string, unknown> = JSON.parse('{"before":1,"__proto__":{"value":3},"2":2,"1":1,"after":4}');
        let refused = false;
        try { Object.assign(target, source); } catch { refused = true; }
        if (!refused || Object.hasOwn(target, '__proto__')) throw new Error('prototype mutation accepted');
        if (Object.keys(target).join(',') !== '1,2,before' || Object.hasOwn(target, 'after'))
            throw new Error('prototype refusal order');
    `);
    const tools = optionalNativeFixtureTools(false);
    if (!tools) {
        t.skip("Native fixture compiler unavailable.");
        return;
    }
    runGeneratedProgram(
        tools,
        "dynamic-object-boundaries/prototype-refusal",
        result.cpp,
    );
});
