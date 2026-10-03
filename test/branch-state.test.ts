import assert from "node:assert/strict";
import test from "node:test";
import { BranchState } from "../src/compiler/branch-state.js";
import { EmissionTransaction } from "../src/compiler/emission-transaction.js";

test("terminating branches restore existing states across nested branches and keep new bindings", () => {
    const states = new BranchState<
        "owned" | "escaped" | "alias" | "poisoned"
    >();
    states.set("owner", "owned");
    states.set("alias", "alias");
    states.withRestoredChanges(() => {
        states.set("owner", "escaped");
        states.withRestoredChanges(() => {
            states.set("alias", "poisoned");
            states.set("nested", "owned");
            states.set("nested", "escaped");
        });
        assert.equal(states.get("owner"), "escaped");
        assert.equal(states.get("alias"), "alias");
        assert.equal(states.get("nested"), "escaped");
        states.set("nested", "poisoned");
        states.set("alias", "poisoned");
    });
    assert.equal(states.get("owner"), "owned");
    assert.equal(states.get("alias"), "alias");
    assert.equal(states.get("nested"), "poisoned");
    states.set("alias", "poisoned");
    assert.equal(states.get("alias"), "poisoned");
});

test("branch restoration and speculative rollback preserve their separate boundaries", () => {
    const states = new BranchState<"owned" | "escaped">();
    states.set("owner", "owned");
    assert.throws(() =>
        states.withRestoredChanges(() => {
            new EmissionTransaction().run(() => {
                states.set("owner", "escaped");
                states.set("declined", "owned");
                return false;
            }, Boolean);
            assert.equal(states.get("owner"), "owned");
            assert.equal(states.get("declined"), undefined);
            states.set("owner", "escaped");
            throw new Error("branch refusal");
        }),
    );
    assert.equal(states.get("owner"), "owned");
    new EmissionTransaction().run(() => {
        states.set("owner", "escaped");
        states.withRestoredChanges(() => {
            states.set("owner", "owned");
            states.set("introduced", "owned");
        });
        assert.equal(states.get("owner"), "escaped");
        assert.equal(states.get("introduced"), "owned");
        return false;
    }, Boolean);
    assert.equal(states.get("owner"), "owned");
    assert.equal(states.get("introduced"), undefined);
    states.set("owner", "escaped");
    states.withRestoredChanges(() => states.set("owner", "owned"));
    assert.equal(states.get("owner"), "escaped");
});
