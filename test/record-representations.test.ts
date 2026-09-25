import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import ts from "typescript";
import { javascriptModuleUrl } from "../src/data-url.js";
import {
    CharacterKernelLowerer,
    type KernelSchema,
} from "../src/lowering/character-kernel-lowerer.js";
import { PinnedRecordModel } from "../src/lowering/pinned-record-lowerer.js";
import {
    optionalOf,
    recordOf,
    recordScalars,
    type RecordShape,
} from "../src/lowering/record-shapes.js";
import { UpstreamSourceStore } from "../src/upstream-source.js";
import { doctoredContext } from "./doctored-store.js";
import {
    optionalNativeFixtureTools,
    runNativeFixtureCompiler,
} from "./native-fixture.js";

const modulePath = "src/physics/character-controller.ts";
const source = `
export interface FixtureCell { value: number; next?: FixtureCell; }
export function probe(cell: FixtureCell | null, amount?: number, flag?: boolean): number {
    let result = 0;
    if (cell) result += cell.value;
    if (amount) result += 10;
    if (flag) result += 100;
    const next = cell?.next ?? cell;
    if (next) result += next.value;
    return result + (amount ?? 7);
}

export function collections(): number[] {
    const numbers = new Map<number, number | undefined>();
    numbers.set(1, 7);
    const kept = numbers.get(1);
    numbers.set(1, 99);
    numbers.delete(1);
    numbers.set(2, undefined);
    const cells = new Map<number, FixtureCell>();
    const cell: FixtureCell = { value: 11 };
    cells.set(1, cell);
    const saved = cells.get(1);
    cells.clear();
    const weak = new WeakMap<FixtureCell, number>();
    weak.set(cell, 13);
    const weakValue = weak.get(cell);
    weak.delete(cell);
    const values: number[] = [17];
    const popped = values.pop();
    const empty = values.pop();
    const references: FixtureCell[] = [cell];
    const poppedCell = references.pop();
    const callbacks = new Map<number, () => number>();
    callbacks.set(1, () => 19);
    const callback = callbacks.get(1);
    callbacks.clear();
    const bytes = new Uint8Array([1, 2, 3, 4]);
    bytes.set(bytes.subarray(0, 3), 1);
    const out = [kept ?? -1, numbers.get(2) ?? -2, saved!.value,
        weakValue ?? -3, weak.has(cell) ? 1 : 0, popped ?? -4,
        empty ?? -5, poppedCell!.value, callback!(),
        bytes[0]!, bytes[1]!, bytes[2]!, bytes[3]!];
    return out;
}
`;

test("both record lowerers preserve reference absence and optional scalar truthiness", async (t) => {
    const context = doctoredContext(
        modulePath,
        new UpstreamSourceStore().getSource(modulePath),
        source,
    );
    const { file, declaration } = context.functionDeclaration(
        modulePath,
        "probe",
    );
    const model = new PinnedRecordModel(
        context,
        context.program.modules([modulePath]),
        {
            records: [
                {
                    pinned: ["FixtureCell"],
                    cpp: "FixtureCell",
                    reference: true,
                },
            ],
            values: new Map(),
            adapters: new Map(),
            exported: new Set([`${modulePath}#probe`, `${modulePath}#collections`]),
        },
    );
    const lowered = model.lower([
        declaration,
        model.functionDeclaration(modulePath, "collections"),
    ]);
    const fields = new Map<string, RecordShape>([
        ["value", recordScalars.number],
        ["next", optionalOf(recordOf("FixtureCell"))],
    ]);
    const schema: KernelSchema = {
        records: new Map([["FixtureCell", fields]]),
        functions: new Map(),
        values: new Map(),
        declared: new Map(),
        returnType: recordScalars.number,
    };
    const kernel = new CharacterKernelLowerer(context, file, schema);
    const parameters = declaration.parameters.map((parameter) => {
        const type = kernel.declarationType(parameter);
        const cpp = parameter.name.getText(file);
        schema.values.set(parameter, { cpp, type, borrowed: "stable" });
        return `${kernel.storage(type)} ${cpp}`;
    });
    const kernelBody = kernel.body(declaration.body!.statements, "    ");
    const javascript = ts.transpileModule(source, {
        compilerOptions: {
            target: ts.ScriptTarget.ES2022,
            module: ts.ModuleKind.ESNext,
        },
    }).outputText;
    const reference = (await import(javascriptModuleUrl(javascript))) as {
        probe(
            this: void,
            cell: { value: number; next?: { value: number } } | null,
            amount?: number,
            flag?: boolean,
        ): number;
        collections(this: void): number[];
    };
    const expected = [
        reference.probe(null),
        reference.probe({ value: 3 }, 0, false),
        reference.probe({ value: 3, next: { value: 5 } }, 2, true),
        reference.probe({ value: 3 }, NaN, false),
    ].join(" ");
    const native = optionalNativeFixtureTools(false);
    if (!native) {
        t.skip("Native fixture compiler unavailable.");
        return;
    }
    const directory = resolve("artifacts/record-representations");
    mkdirSync(directory, { recursive: true });
    const cpp = resolve(directory, "check.cpp"),
        exe = resolve(directory, "check.exe");
    writeFileSync(
        cpp,
        `#include <bblite/pinned_records.hpp>
#include <iostream>
namespace bbl {
${model.structs(["FixtureCell"])}
${lowered.declarations}
${lowered.definitions}
namespace kernel {
struct FixtureCell { double value{}; js::Ref<FixtureCell> next; };
double probe(${parameters.join(", ")}) {
${kernelBody}
}
}
}
template<class Cell, class Probe> void check(Cell cell, Cell next, Probe probe) {
    cell->value = 3; next->value = 5;
    const double absent = probe({}, std::nullopt, std::nullopt);
    const double zero = probe(cell, 0.0, false);
    cell->next = next;
    const double present = probe(cell, 2.0, true);
    cell->next = {};
    const double nan = probe(cell, std::numeric_limits<double>::quiet_NaN(), false);
    std::cout << bbl::js::number_to_string(absent) << " " << bbl::js::number_to_string(zero) << " "
              << bbl::js::number_to_string(present) << " " << bbl::js::number_to_string(nan) << "\\n";
}
int main() {
    check(std::make_shared<bbl::FixtureCell>(), std::make_shared<bbl::FixtureCell>(), bbl::probe);
    check(bbl::js::make_ref<bbl::kernel::FixtureCell>(), bbl::js::make_ref<bbl::kernel::FixtureCell>(), bbl::kernel::probe);
    const auto values = bbl::collections();
    for (std::size_t i = 0; i < values.size(); ++i)
        std::cout << (i ? " " : "") << bbl::js::number_to_string(values[i]);
    std::cout << "\\n";
}
`,
    );
    runNativeFixtureCompiler(native, [
        "/nologo",
        "/std:c++20",
        "/EHsc",
        "/W4",
        "/WX",
        `/I${resolve("native/include")}`,
        cpp,
        `/Fo${resolve(directory, "check.obj")}`,
        `/Fe${exe}`,
    ]);
    const output = execFileSync(exe, { encoding: "utf8" })
        .trim()
        .split(/\r?\n/);
    assert.deepEqual(output, [expected, expected, reference.collections().join(" ")]);
});
