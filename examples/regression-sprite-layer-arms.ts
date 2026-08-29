// Project-owned gate for the residual Sprite2D layer and renderer arms.
// Registered Doom and Platformer exercise ordinary indexed updates, clears
// and renderer disposal, but not every partial-update preservation rule or a
// renderer whose layer list changes after its GPU records already exist.
//
// What it measures, in two halves:
//
//   * `updateSprite2DIndex`, once per preserve rule. The patch is a
//     `Partial<Sprite2DProps>`, so every field the caller omits keeps the
//     value already in the slot — and each rule has its own source: the
//     position and rotation come from the instance floats, the true size
//     from the CPU-side shadow (a hidden sprite's GPU size is zeroed, so the
//     instance cannot answer it), and the flip from the ORDER of the UV
//     endpoints, which is what lets a frame change keep a mirrored sprite
//     mirrored. Each sprite in the top row isolates one of them.
//   * `clearSprite2DLayer`, `addSpriteRendererLayer`,
//     `removeSpriteRendererLayer` and `disposeSpriteRenderer` — the complete
//     list-mutation sequence, including the add/remove arms the demos do not
//     reach after registration.
//
// The second half runs from a zero-delay `setTimeout` on purpose. Each
// backend builds one GPU record per layer, and that happens once before the
// first frame — so a mutation made during setup would never exercise the
// synchronisation. Deferring it puts the calls after the pass exists, which
// is where a HUD would make them, and is the only shape that measures it.
//
// Two details are what make the second half discriminating rather than
// decorative, and both were added after an A/B showed the first version
// measured nothing:
//
//   * `late` blends ADDITIVE. A blend is baked into the pipeline a layer's
//     GPU record owns, so a backend reusing a stale record draws these
//     through the alpha pipeline and the pixels differ.
//   * the renderer that is DISPOSED is the one registered FIRST, and it
//     carries a deliberately wrong clear colour. Upstream's frame clear
//     belongs to whichever rendering context is at the front of the
//     registered list, so disposing it has to move the clear to `main`; a
//     backend that resolved the owner once at startup paints the whole frame
//     red.
//
// The atlas is a four-cell data URL rather than a file: each cell is a flat
// colour with a white notch down its left edge, so a flip is visible in the
// picture instead of inferred, and a two-pixel transparent gutter keeps
// neighbouring frames from bleeding.

import {
    addSprite2DIndex,
    addSpriteRendererLayer,
    clearSprite2DLayer,
    createEngine,
    createSprite2DLayer,
    createSpriteRenderer,
    disposeSpriteRenderer,
    loadSpriteAtlas,
    registerSpriteRenderer,
    removeSpriteRendererLayer,
    spriteBlendAdditive,
    startEngine,
    updateSprite2DIndex,
} from "babylon-lite";
import type { Sprite2DLayer } from "babylon-lite";

const ATLAS_URL =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAIAAAAAgCAYAAADaInAlAAAAwElEQVR4Ae3BoRXCQABEwX/7UGg0hiIwiUZjwdABjWBSROgBHUUP0AE9BATiGsg7sTtTXl1HS5fblpbW94GWxtORlkRYW/G3m6aZyrvvWVihMu3HmUr/PLOwQuUxbGYqh+uHhRUqm/00U/k8exZW+BFhTYQ1EdZEWBNhTYQ1EdZEWBNhTYQ1EdZEWBNhTYQ1EdZEWBNhTYQ1EdZEWBNhTYQ1EdZEWBNhTYQ1EdbKq+to6XLb0tL6PtDSeDrSkghrX2qUGh8fWiidAAAAAElFTkSuQmCC";

const CELL = 32;
const SIZE = 72;

/** One sprite at its full size, which is most of what this scene adds. */
function place(
    layer: Sprite2DLayer,
    x: number,
    y: number,
    frame: number,
): number {
    return addSprite2DIndex(layer, {
        positionPx: [x, y],
        sizePx: [SIZE, SIZE],
        frame: frame,
    });
}

async function main(): Promise<void> {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);

    const atlas = await loadSpriteAtlas(engine, ATLAS_URL, {
        gridSize: [CELL, CELL],
        sampling: "nearest",
    });

    // ---- Row 1: one update rule per sprite -------------------------------
    const rules = createSprite2DLayer(atlas, { capacity: 8, depth: "none" });

    // Position only: the frame, size and colour must survive the move.
    const moved = place(rules, 120, 110, 0);
    updateSprite2DIndex(rules, moved, { positionPx: [120, 200] });

    // Colour only: the position, size and frame must survive the tint.
    const tinted = place(rules, 260, 200, 1);
    updateSprite2DIndex(rules, tinted, { color: [1, 0.45, 0.45, 1] });

    // Frame only, on a mirrored sprite: the new frame's UVs are stomped in,
    // and the flip is then re-applied because the flag was not supplied, so
    // the notch has to stay on the RIGHT. Supplying a frame also resets the
    // size to that frame's own — the pin's rule, and why this one is small.
    const reframed = addSprite2DIndex(rules, {
        positionPx: [400, 200],
        sizePx: [SIZE, SIZE],
        frame: 2,
        flipX: true,
    });
    updateSprite2DIndex(rules, reframed, { frame: 3 });

    // Hidden, then shown again with no size supplied: the true size comes
    // back from the shadow buffer, because hiding zeroed the GPU one.
    const restored = place(rules, 540, 200, 1);
    updateSprite2DIndex(rules, restored, { visible: false });
    updateSprite2DIndex(rules, restored, { visible: true });

    // Flip only: the frame must survive, so this stays cell 2 (blue) with
    // its notch on the right.
    const flipped = place(rules, 680, 200, 2);
    updateSprite2DIndex(rules, flipped, { flipX: true });

    // Rotation only: everything else preserved.
    const turned = place(rules, 820, 200, 3);
    updateSprite2DIndex(rules, turned, { rotation: 0.6 });

    // A sprite that stays hidden, to prove `visible: false` is not merely a
    // colour change: nothing may be drawn at this position.
    const hidden = place(rules, 960, 200, 0);
    updateSprite2DIndex(rules, hidden, { visible: false });

    // ---- Row 2: clearSprite2DLayer ---------------------------------------
    // Three sprites, cleared, then two different ones. Only the second pair
    // may appear, and they must land at indices 0 and 1 with a clean size
    // shadow — so the second pair supplies no size and takes the frame's.
    const cleared = createSprite2DLayer(atlas, {
        capacity: 8,
        depth: "none",
        order: 1,
    });
    place(cleared, 120, 330, 0);
    place(cleared, 260, 330, 0);
    place(cleared, 400, 330, 0);
    clearSprite2DLayer(cleared);
    addSprite2DIndex(cleared, { positionPx: [120, 330], frame: 2 });
    addSprite2DIndex(cleared, { positionPx: [260, 330], frame: 3 });

    // ---- Row 3: layers the renderer gains and loses after it exists ------
    const late = createSprite2DLayer(atlas, {
        capacity: 4,
        depth: "none",
        order: 2,
        blendMode: spriteBlendAdditive,
    });
    place(late, 120, 450, 1);
    place(late, 260, 450, 2);

    // A second added layer, so the list ends LONGER than it was built at.
    const lateExtra = createSprite2DLayer(atlas, {
        capacity: 4,
        depth: "none",
        order: 4,
    });
    place(lateExtra, 400, 450, 3);

    const doomed = createSprite2DLayer(atlas, {
        capacity: 4,
        depth: "none",
        order: 3,
    });
    place(doomed, 540, 450, 0);
    place(doomed, 680, 450, 3);

    // ---- Row 4: the renderer that is disposed ----------------------------
    const overlay = createSprite2DLayer(atlas, {
        capacity: 4,
        depth: "none",
    });
    place(overlay, 120, 570, 3);
    place(overlay, 260, 570, 1);

    // Registered FIRST, so it owns the frame's clear until it is disposed.
    // Its colour is deliberately not the one the golden carries.
    const doomedRenderer = createSpriteRenderer(engine, {
        layers: [overlay],
        clearValue: { r: 0.35, g: 0.05, b: 0.05, a: 1.0 },
    });
    registerSpriteRenderer(doomedRenderer);

    // `late` and `lateExtra` are deliberately absent from the initial list;
    // `doomed` is in it.
    const main2d = createSpriteRenderer(engine, {
        layers: [rules, cleared, doomed],
        clearValue: { r: 0.05, g: 0.06, b: 0.1, a: 1.0 },
    });
    registerSpriteRenderer(main2d);

    // Deferred so all four land after each backend has built its per-layer
    // GPU records, which is what makes the synchronisation measurable.
    setTimeout(() => {
        addSpriteRendererLayer(main2d, late);
        addSpriteRendererLayer(main2d, lateExtra);
        removeSpriteRendererLayer(main2d, doomed);
        disposeSpriteRenderer(doomedRenderer);
    }, 0);

    await startEngine(engine);
    canvas.dataset.drawCalls = String(engine.drawCallCount);
    canvas.dataset.initMs = String(performance.now() - __initStart);
    canvas.dataset.ready = "true";
}

main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
});
