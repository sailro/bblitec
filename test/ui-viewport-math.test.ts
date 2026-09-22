import test from "node:test";
import { runRmlUiFixture } from "./native-fixture.js";

test("viewport CSS math preserves panel dimensions, scrolling and live resize", (t) => {
    runRmlUiFixture(t, "ui-viewport-math");
});
