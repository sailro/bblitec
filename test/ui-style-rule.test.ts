import assert from "node:assert/strict";
import test from "node:test";

import {
    isUiStyleSelectorKind,
    nativeHostUiStyleRules,
    uiStyleSelector,
    uiStyleSelectorCppKind,
} from "../src/ui-style-rule.js";

test("legacy host class styles normalize ahead of generic style rules", () => {
    assert.deepEqual(
        nativeHostUiStyleRules({
            classStyles: [{ className: "legacy", style: "display:none" }],
            styleRules: [
                {
                    kind: "class-descendant-tag",
                    primary: "panel",
                    tag: "b",
                    style: "color:cyan",
                },
            ],
        }),
        [
            {
                kind: "class",
                primary: "legacy",
                style: "display:none",
            },
            {
                kind: "class-descendant-tag",
                primary: "panel",
                tag: "b",
                style: "color:cyan",
            },
        ],
    );
});

test("selector descriptors share validation, CSS, and C++ spellings", () => {
    assert.equal(isUiStyleSelectorKind("id-descendant-class"), true);
    assert.equal(isUiStyleSelectorKind("descendant"), false);
    assert.equal(
        uiStyleSelector({
            kind: "id-descendant-class",
            primary: "menu",
            secondary: "entry",
            hover: true,
            focusVisible: true,
        }),
        "#menu .entry:hover:focus-visible",
    );
    assert.equal(
        uiStyleSelectorCppKind("id-descendant-class"),
        "IdDescendantClass",
    );
});
