import test from "node:test";
import { LoweringContext } from "../src/lowering/context.js";
import { PinnedRecordModel } from "../src/lowering/pinned-record-lowerer.js";
import { UpstreamSourceStore } from "../src/upstream-source.js";
import {
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";

const modulePath = "src/fixture/record-numbers.ts";
const source = `export function constants(): number[] {
    return [Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NaN,
        Number.MAX_VALUE, Number.MIN_VALUE, Number.EPSILON];
}`;

class FixtureStore extends UpstreamSourceStore {
    public override getSource(path: string): string {
        return path.replaceAll("\\", "/") === modulePath
            ? source
            : super.getSource(path);
    }
    public override hasSource(path: string): boolean {
        return (
            path.replaceAll("\\", "/") === modulePath || super.hasSource(path)
        );
    }
}

test("pinned record bodies retain nonfinite and finite Number constants", (t) => {
    const store = new FixtureStore();
    const model = new PinnedRecordModel(
        new LoweringContext(store),
        store.program.modules([modulePath]),
        {
            records: [],
            values: new Map(),
            adapters: new Map(),
            exported: new Set([`${modulePath}#constants`]),
        },
    );
    const { declarations, definitions } = model.lower([
        model.functionDeclaration(modulePath, "constants"),
    ]);
    const tools = optionalNativeFixtureTools(false);
    if (!tools) return t.skip("Native fixture compiler unavailable.");
    runGeneratedProgram(
        tools,
        "pinned-record-numbers",
        `
        #include <bblite/pinned_records.hpp>
        #include <cassert>
        #include <cmath>
        #include <limits>
        namespace bbl { ${declarations} ${definitions} }
        int main() {
            const auto values = bbl::constants();
            assert(values.size() == 6);
            assert(values[0] == std::numeric_limits<double>::infinity());
            assert(values[1] == -std::numeric_limits<double>::infinity());
            assert(std::isnan(static_cast<double>(values[2])));
            assert(values[3] == std::numeric_limits<double>::max());
            assert(values[4] == std::numeric_limits<double>::denorm_min());
            assert(values[5] == std::numeric_limits<double>::epsilon());
        }
    `,
    );
});
