import assert from "node:assert/strict";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import {
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";

const deferredCapabilities = "runtime-throw" as const;

const family = `
let order = '', caught = 0, after = 0;
function locale(): string { order += 'l'; return 'en'; }
function precision(): number { order += 'p'; return 1; }
const cache = new Map<string, Map<number | undefined, Intl.PluralRules>>();
function counted(value: number, digits?: number): string {
    let entries = cache.get('en');
    if (!entries) { entries = new Map(); cache.set('en', entries); }
    let rules = entries.get(digits);
    if (!rules) {
        rules = new Intl.PluralRules(locale(), digits === undefined ? undefined : {maximumFractionDigits: precision()});
        entries.set(digits, rules);
    }
    return rules.select(value);
}
try { counted(2, 0); } catch (error) {
    if (!error.message.includes('default-lib:Intl.PluralRules.constructor')) throw error;
    caught++;
}
after++;
try {
    const list = new Intl.ListFormat(locale(), {style: 'long', type: 'disjunction'});
    const callbacks: Array<(values: readonly string[]) => string> = [values => list.format(values)];
    callbacks[0]!(['one', 'two']);
} catch (error) {
    if (!error.message.includes('default-lib:Intl.ListFormat.constructor')) throw error;
    caught++;
}
const optional: Array<Intl.ListFormat | undefined> = [undefined];
optional[0]?.format([locale()]);
const pluralReads: Array<(rules: Intl.PluralRules) => string> = [rules => rules.select(2)];
if (order !== 'lpl' || caught !== 2 || after !== 1 || pluralReads.length !== 1) throw new Error('Intl evaluation');
`;

test("deferred Intl keeps cached nominal formatters, callbacks and constructor evaluation", () => {
    assert.throws(() => compileSource(family), /Unsupported constructor/);
    const result = compileSource(family, { deferredCapabilities });
    const sites = result.manifest.deferredCapabilities ?? [];
    assert.deepEqual(
        new Set(sites.map((site) => site.id)),
        new Set([
            "default-lib:Intl.ListFormat.constructor",
            "default-lib:Intl.ListFormat.format",
            "default-lib:Intl.PluralRules.constructor",
            "default-lib:Intl.PluralRules.select",
        ]),
    );
    assert.ok(
        sites.every(
            (site) => site.origin === "default-lib" && site.timing === "throw",
        ),
    );
    assert.match(result.cpp, /std::shared_ptr<bbl::DeferredPluralRules>/);
    assert.match(result.cpp, /std::shared_ptr<bbl::DeferredListFormat>/);
    assert.throws(
        () =>
            compileSource(family + "new FinalizationRegistry(() => {});", {
                deferredCapabilities,
            }),
        /Unsupported constructor/,
    );
    const tools = optionalNativeFixtureTools(false);
    assert.ok(tools);
    runGeneratedProgram(tools, "deferred-intl/family", result.cpp, {
        expectedOutput: "",
        timeoutMs: 10000,
    });
});

test("Intl descriptors preserve authored implementations and supported ICU paths", () => {
    const authored = compileSource(
        `
        class ListFormat { format(values: readonly string[]): string { return values.join('|'); } }
        class PluralRules { select(value: number): string { return value === 1 ? 'one' : 'other'; } }
        const local = {ListFormat: new ListFormat(), PluralRules: new PluralRules()};
        const list: Pick<Intl.ListFormat, 'format'> = {format: () => 'a|b'};
        if (list.format(['a','b']) !== 'a|b' || local.ListFormat.format(['x','y']) !== 'x|y' || local.PluralRules.select(2) !== 'other') throw new Error('authored');
    `,
        { deferredCapabilities },
    );
    assert.equal(authored.manifest.deferredCapabilities, undefined);
    const supported = compileSource(
        `
        const collator = new Intl.Collator('en');
        if (collator.compare('a', 'b') >= 0) throw new Error('collator');
        if ((12).toLocaleString('en') !== '12') throw new Error('number format');
    `,
        { deferredCapabilities },
    );
    assert.equal(supported.manifest.deferredCapabilities, undefined);
    const tools = optionalNativeFixtureTools(false);
    assert.ok(tools);
    runGeneratedProgram(tools, "deferred-intl/authored", authored.cpp, {
        expectedOutput: "",
    });
});
