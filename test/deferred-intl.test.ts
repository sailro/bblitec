import assert from "node:assert/strict";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import {
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";

const deferredCapabilities = "runtime-throw" as const;

const family = `
let order = '';
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
const list = new Intl.ListFormat(locale(), {style: 'long', type: 'disjunction'});
const callbacks: Array<(values: readonly string[]) => string> = [values => list.format(values)];
const optional: Array<Intl.ListFormat | undefined> = [undefined];
optional[0]?.format([locale()]);
const pluralReads: Array<(rules: Intl.PluralRules) => string> = [rules => rules.select(2)];
if (counted(2, 0) !== 'other' || callbacks[0]!(['one', 'two']) !== 'one or two' || order !== 'lpl' || pluralReads.length !== 1) throw new Error('Intl evaluation');
`;

test("Intl ListFormat and PluralRules lower as platform formatters, not deferred boundaries", () => {
    for (const options of [{}, { deferredCapabilities }]) {
        const result = compileSource(family, options);
        assert.equal(result.manifest.deferredCapabilities, undefined);
        assert.ok(result.manifest.features.includes("data:locale"));
        assert.match(result.cpp, /bbl::pal::make_plural_rules/);
        assert.match(result.cpp, /bbl::pal::make_list_format/);
    }
    assert.throws(
        () =>
            compileSource(family + "new FinalizationRegistry(() => {});", {
                deferredCapabilities,
            }),
        /Unsupported constructor/,
    );
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
