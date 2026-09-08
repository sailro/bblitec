// Scene 153: the animated orange rectangle's position along its
// horizontal track, measured from each phase's image: its centre must
// stay on the horizontal midline, its size must follow the live canvas
// (max(28, 9% of the smaller dimension)), and the resize must not change
// the pose. Frozen: the rectangle sits at the sought target (2 track
// units). Live: it advances by more than one unit between the phases.
//
// options: { mode: "frozen" | "live" }
import assert from "node:assert/strict";
import { loadPng } from "./support.mjs";

function rectangle(path) {
    const image = loadPng(path);
    let left = image.width, right = -1, top = image.height, bottom = -1;
    for (let y = 0; y < image.height; y++) {
        for (let x = 0; x < image.width; x++) {
            const i = (y * image.width + x) * 4;
            if (image.data[i] > 200 && image.data[i + 1] > 120 && image.data[i + 2] < 120) {
                left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y);
            }
        }
    }
    assert(right > left && bottom > top, `Missing animated rectangle in ${path}`);
    return { width: image.width, height: image.height, x: (left + right + 1) / 2, y: (top + bottom + 1) / 2, size: right - left + 1,
        position: ((left + right + 1) / 2 - image.width / 2) / (image.width * 0.18) };
}

export function check(context) {
    const details = {};
    for (const backend of context.backends) {
        const boxes = {};
        for (const phase of Object.values(context.results[backend])) {
            const box = rectangle(phase.image);
            assert(Math.abs(box.y - box.height / 2) < 1, `${backend}/${phase.id}: the rectangle left its horizontal track`);
            assert(Math.abs(box.size - Math.max(28, Math.min(box.width, box.height) * 0.09)) < 2, `${backend}/${phase.id}: the rectangle did not resize from live canvas dimensions`);
            boxes[phase.id] = box;
        }
        assert(Math.abs(boxes.later.position - boxes.resize.position) < 0.01, `${backend}: resize changed the animation pose`);
        if (context.options.mode === "frozen") {
            assert(Math.abs(boxes.later.position - 2) < 0.01, `${backend}: the frozen branch did not seek the source target`);
        } else {
            assert(boxes.later.position - boxes.early.position > 1, `${backend}: the autonomous manager did not advance the target`);
        }
        details[backend] = boxes;
        context.log(`${backend}: early ${boxes.early.position.toFixed(3)} later ${boxes.later.position.toFixed(3)} resized ${boxes.resize.position.toFixed(3)} track units`);
    }
    return { details };
}
