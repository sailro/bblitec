import test from "node:test";
import { runRmlUiFixture } from "./native-fixture.js";

test("native inline style writes, cssText and removals transition like rule changes", (t) =>
    runRmlUiFixture(t, "ui-inline-transitions"));
