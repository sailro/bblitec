import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {mkdirSync, writeFileSync} from "node:fs";
import {join, resolve} from "node:path";
import test from "node:test";
import {compileSource} from "../src/compiler.js";
import {optionalNativeFixtureTools, runNativeFixtureCompiler} from "./native-fixture.js";

test("Number.parseInt shares global parser lowering and preserves shadowed Number", () => {
    const parsed = compileSource(`
        import {createEngine, createBox} from '@babylonjs/lite';
        const engine = await createEngine({});
        const box = createBox(engine);
        box.position.x = Number.parseInt('DB504A', 16);
        box.position.y = parseInt('ff', 16);
    `);
    assert.match(parsed.cpp, /bbl::js::parse_int\([^;]+, 16\)/);
    const shadowed = compileSource(`
        import {createEngine, createBox} from '@babylonjs/lite';
        const Number = {parseInt: (text: string, radix: number) => radix + text.length};
        const engine = await createEngine({});
        createBox(engine).position.x = Number.parseInt('ff', 16);
    `);
    assert.doesNotMatch(shadowed.cpp, /bbl::js::parse_int\(/);
});

const tools = optionalNativeFixtureTools(false);
test("native integer parsing agrees on radix, prefix, sign and digit termination", {skip: !tools}, () => {
    const output = resolve("artifacts/parse-int-check");
    mkdirSync(output, {recursive:true});
    const cases: Array<[string, number]> = [
        ['DB504A',16], ['0xE3B505',0], [' -0XfF!',16], ['0xff',10],
        ['010',0], ['101101rest',2], ['zebra!',36], ['-0',16],
        [' \t+52tail',10], ['',16], ['0x',16], ['2',2], ['+ff',16],
    ];
    const statements = cases.map(([input, radix], index) => {
        const expected = Number.parseInt(input, radix);
        const value = `parsed_${index}`;
        const check = Number.isNaN(expected) ? `std::isnan(${value})`
            : Object.is(expected,-0) ? `${value} == 0 && std::signbit(${value})` : `${value} == ${expected}`;
        return `const double ${value} = bbl::js::parse_int(${JSON.stringify(input)}, ${radix}); assert(${check});`;
    }).join('\n');
    const source = join(output, 'check.cpp');
    const executable = join(output, 'check.exe');
    writeFileSync(source, `#include <bblite/js_data.hpp>\n#include <cassert>\n#include <cmath>\nint main() {${statements}}\n`);
    runNativeFixtureCompiler(tools!, ['/nologo','/std:c++20','/W4','/WX','/EHsc',
        `/Fo:${output}\\`, `/Fe:${executable}`, '/I','native/include', source]);
    execFileSync(executable, {env:tools!.environment});
});
