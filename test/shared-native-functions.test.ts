import assert from "node:assert/strict";
import test from "node:test";
import { EmissionTransaction } from "../src/compiler/emission-transaction.js";
import { renameCppIdentifiers } from "../src/compiler/cpp-identifiers.js";
import { SharedNativeFunctions } from "../src/compiler/shared-native-functions.js";
import { compileSource } from "../src/compiler.js";
import { renderMainCpp } from "../src/compiler/output-projection.js";

test("shared native definitions do not accumulate empty prototype lines", () => {
    const definitions = Array.from(
        { length: 12 },
        (_, index) => `
        function visit${index}(count: number): void {
            total += count + ${index};
            if (count > 0) visit${index}(count - 1);
        }
        visit${index}(2);
    `,
    ).join("\n");
    const cpp = compileSource(`
        let total = 0;
        ${definitions}
        if (total !== 234) throw new Error("Unexpected recursive result.");
    `).cpp;
    assert.match(cpp, /namespace bblscene \{/);
    assert.match(cpp, /template<typename Environment, typename Self>/);
    assert.doesNotMatch(cpp, /\n(?:[ \t]*\n){2,}/);
});

test("definition-only namespaces preserve deliberate whitespace inside native bodies", () => {
    const literal = 'R"payload(first\n\n\nlast)payload"';
    const cpp = renderMainCpp({
        source: "main.ts",
        features: ["core"],
        jsDataReached: false,
        imageDecodeReached: false,
        jsRandomReached: false,
        throwReached: false,
        postProcessCompositeCount: 0,
        screenSpaceTaskCount: 0,
        renderDataPreamble: () => ({
            standalone: "",
            shared: "",
            definitions: [],
        }),
        nativeFunctions: [
            {
                kind: "template",
                name: "retained",
                lines: [`inline auto retained() { return ${literal}; }`],
            },
        ],
        staticNativeDeclarations: [],
        voxelFileStorageReached: false,
        body: [],
    }).cpp;
    assert.ok(
        cpp.includes(
            `namespace bblscene {\n\ninline auto retained() { return ${literal}; }`,
        ),
    );
});

test("native definition interning retains binding topology and external identities", () => {
    const cache = new SharedNativeFunctions();
    const definition = (
        name: string,
        local: string,
        receiver: string,
        field = "material",
        fn = "create_material",
        value = "1",
    ) =>
        `inline auto ${name}(auto& ${receiver}, float ${local}) { auto result = ${fn}(${receiver}.${field}, ${local}, ${value}); return result; }`;
    const first = cache.intern(
        "first",
        definition("first", "amount", "env"),
        new Set(["amount", "env", "result"]),
    );
    assert.deepEqual(first, { name: "first", added: true });
    assert.deepEqual(
        cache.intern(
            "second",
            definition("second", "factor", "captures"),
            new Set(["factor", "captures", "result"]),
        ),
        { name: "first", added: false },
    );
    for (const [field, fn, value] of [
        ["other", "create_material", "1"],
        ["material", "other_factory", "1"],
        ["material", "create_material", "2"],
    ]) {
        assert.equal(
            cache.intern(
                "different",
                definition("different", "amount", "env", field, fn, value),
                new Set(["amount", "env", "result"]),
            ).added,
            true,
        );
    }
    assert.equal(
        cache.intern(
            "alias",
            definition("alias", "env", "env"),
            new Set(["env", "result"]),
        ).added,
        true,
    );
    const member = (name: string, local: string, field: string) =>
        `auto ${name}(auto ${local}) { return ${local}. /* field */ ${field}; }`;
    assert.equal(
        cache.intern(
            "field_a",
            member("field_a", "value", "value"),
            new Set(["value"]),
        ).added,
        true,
    );
    assert.equal(
        cache.intern(
            "field_b",
            member("field_b", "other", "other"),
            new Set(["other"]),
        ).added,
        true,
    );
    assert.deepEqual(
        cache.intern(
            "field_c",
            member("field_c", "other", "value"),
            new Set(["other"]),
        ),
        { name: "field_a", added: false },
    );
    const speculative = new EmissionTransaction(cache);
    assert.equal(
        cache.intern(
            "probe",
            "auto probe() { return new_identity(); }",
            new Set(),
        ).added,
        true,
    );
    speculative.finish(false);
    assert.equal(
        cache.intern(
            "committed",
            "auto committed() { return new_identity(); }",
            new Set(),
        ).added,
        true,
    );
});

test("C++ binding renames preserve raw strings, escapes, comments and numeric literals", () => {
    const payloads = String.raw`"bound\\\"bound" 'b' R"tag(bound " bound)tag" u8R"(bound)" /* bound */ // bound
        0xbound 1'000ull`;
    assert.equal(
        renameCppIdentifiers(`bound + ${payloads} + bound`, (name) =>
            name === "bound" ? "renamed" : undefined,
        ),
        `renamed + ${payloads} + renamed`,
    );
});
