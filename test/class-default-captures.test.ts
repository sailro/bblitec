import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { compileSource } from "../src/compiler.js";
import {
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";

const source = `
    let defaults = 0, reads = 0;
    function fallback(): number { defaults++; return 7; }
    class Receiver {
        base = 10;
        pick(value = fallback()): () => number {
            const read = () => value;
            value += 1;
            return read;
        }
        ordered(first = this.base, second = first + 1): () => number {
            const read = () => first * 100 + second;
            first++;
            return read;
        }
        nullable(value: number | null = fallback()): () => number | null {
            const read = () => value;
            return read;
        }
    }
    const rows: Array<{value?: number}> = [{}, {value: 3}];
    const receiver = new Receiver();
    function argument(index: number): number | undefined { reads++; return rows[index]!.value; }
    const first = receiver.pick(argument(0)), second = receiver.pick(argument(1));
    rows[1]!.value = 20;
    if (first() !== 8 || second() !== 4 || defaults !== 1 || reads !== 2)
        throw new Error('defaulted captured argument values');
    const missing: [number?, number?] = [];
    const provided: [number?, number?] = [2, 5];
    if (receiver.ordered(...missing)() !== 1111 || receiver.ordered(...provided)() !== 305)
        throw new Error('spread defaults and earlier parameter');
    if (receiver.nullable(null)() !== null || defaults !== 1)
        throw new Error('null does not take a default');
    const after = receiver.ordered(undefined, (() => { receiver.base = 30; return 4; })());
    if (after() !== 3104) throw new Error('all arguments precede defaults');

    let documentDefaults = 0, documentReads = 0, order = '';
    function documentFallback(): number { documentDefaults++; order += 'd'; return 11; }
    const document = JSON.parse('{"present":3,"empty":null}') as {
        missing?: number; present?: number; empty?: number | null;
    };
    function input(): number | undefined { documentReads++; order += 'a'; return document.missing; }
    function later(): number { order += 'b'; return 2; }
    class Box {
        constructor(public value: number | null = documentFallback(), extra = 0) { value; extra; }
        choose(value: number | null = documentFallback(), extra = 0): () => number | null {
            extra; return () => value;
        }
    }
    function choose(value: number | null = documentFallback(), extra = 0): number | null { extra; return value; }
    const box = new Box(input(), later());
    if (box.value !== 11 || order !== 'abd') throw new Error('document constructor default order');
    order = '';
    const read = box.choose(input(), later());
    if (read() !== 11 || order !== 'abd') throw new Error('document captured method default order');
    order = '';
    if (choose(input(), later()) !== 11 || order !== 'abd') throw new Error('document function default order');
    const present = new Box(document.present), empty = new Box(document.empty);
    if (present.value !== 3 || empty.value !== null || box.choose(document.empty)() !== null ||
        choose(document.present) !== 3 || documentDefaults !== 3 || documentReads !== 3)
        throw new Error('document null and present values keep their argument');
`;

test("class defaults preserve undefined until the callee binds captured parameters", () => {
    runInNewContext(
        ts.transpileModule(source, {
            compilerOptions: { target: ts.ScriptTarget.ES2022 },
        }).outputText,
    );
    compileSource(source);
});

test(
    "native class defaults preserve captures, null and argument evaluation order",
    { skip: !optionalNativeFixtureTools() },
    () => {
        runGeneratedProgram(
            optionalNativeFixtureTools()!,
            "class-default-captures",
            compileSource(source).cpp,
        );
    },
);
