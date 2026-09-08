/** Complete body contracts for the DefaultTextData single-run specialization.
 * Slot, layout and palette arithmetic are separately translated from pinned AST. */
export const defaultTextDataContracts: readonly (readonly [string,string,string])[] = [
    ["src/text/text-data.ts", "runGroupKey", `{
    return _textStyleSeam?._key(run) ?? run.curveSet;
}`],
    ["src/text/text-data.ts", "countRunStyles", `{
    const glyphs = run.glyphs;
    let n = 1;
    for (let i = 0; i < glyphs.length; i++) {
        if (glyphs[i]!.color !== undefined) {
            n++;
        }
    }
    return n;
}`],
    ["src/text/text-data.ts", "allocateStyles", `{
    if (previous?.length === count) {
        return previous;
    }
    const free = data._freeStyleSlots;
    const needed = Math.max(0, count - free.length - (previous?.length ?? 0));
    ensureStyleCapacity(data, data._styleCount + needed);
    if (previous) {
        releaseStyles(data, previous);
    }
    const highWater = data._styleCount;
    const slots = new Array<number>(count);
    for (let i = 0; i < count; i++) {
        slots[i] = free.pop() ?? data._styleCount++;
    }
    if (data._styleCount !== highWater) {
        data._styleVersion++;
    }
    return slots;
}`],
    ["src/text/text-data.ts", "releaseStyles", `{
    for (let i = 0; i < slots.length; i++) {
        data._freeStyleSlots.push(slots[i]!);
    }
}`],
    ["src/text/text-data.ts", "ensureStyleCapacity", `{
    if (requiredEntries > MAX_STYLE_ENTRIES) {
        throw new Error(\`TextData style palette cannot exceed \${MAX_STYLE_ENTRIES} entries.\`);
    }
    const requiredFloats = requiredEntries * TEXT_STYLE_FLOATS;
    if (data._styles.length >= requiredFloats) {
        return;
    }
    let newLen = Math.max(data._styles.length * 2, TEXT_STYLE_FLOATS);
    while (newLen < requiredFloats) {
        newLen *= 2;
    }
    newLen = Math.min(newLen, MAX_STYLE_ENTRIES * TEXT_STYLE_FLOATS);
    const grown = new Float32Array(newLen);
    grown.set(data._styles);
    data._styles = grown;
}`],
    ["src/text/text-data.ts", "makeDrawGroup", `{
    return {
        _curveSetId: curveSetId,
        _curveSet: curveSet,
        _slotStart: slotStart,
        _slotCount: 0,
        _liveCount: 0,
        _freeSlots: [],
        _bindGroup: null,
        _bindGroupVersion: -1,
        _groupKey: groupKey,
    };
}`],
    ["src/text/text-data.ts", "ensureGroup", `{
    const existing = findGroup(data, groupKey);
    if (existing) {
        return existing;
    }
    const curveSet = lookupCurveSet(data._storage, curveSetId, "addRun");
    const group = makeDrawGroup(curveSetId, curveSet, data._instanceCount, groupKey);
    data._groups.push(group);
    return group;
}`],
    ["src/text/text-data.ts", "lookupCurveSet", `{
    const cs = storage._curveSets.get(curveSetId);
    if (!cs) {
        throw new Error(\`updateTextData \${op}: storage does not contain curveSet "\${curveSetId}" — add it via updateGlyphStorage first.\`);
    }
    return cs;
}`],
    ["src/text/text-data.ts", "applyReset", `{
    let totalGlyphs = 0;
    let totalStyles = 0;
    for (const run of runs) {
        totalGlyphs += run.glyphs.length;
        totalStyles += countRunStyles(run);
    }
    ensureStyleCapacity(data, totalStyles);
    const required = totalGlyphs * TEXT_INSTANCE_FLOATS;
    if (data._instances.length < required) {
        let newLen = Math.max(data._instances.length * 2, TEXT_INSTANCE_FLOATS);
        while (newLen < required) {
            newLen *= 2;
        }
        data._instances = new Float32Array(newLen);
        data._instancesU32 = new Uint32Array(data._instances.buffer);
    }
    const prevGroupByKey = new Map<TextGroupKey, TextDataDrawGroup>();
    for (const g of data._groups) {
        prevGroupByKey.set(g._groupKey, g);
    }
    data._storage = storage;
    const runsByKey = new Map<TextGroupKey, GlyphRun[]>();
    for (const run of runs) {
        const key = runGroupKey(run);
        let list = runsByKey.get(key);
        if (!list) {
            list = [];
            runsByKey.set(key, list);
        }
        list.push(run);
    }
    const newGroups: TextDataDrawGroup[] = [];
    const newRunRecords = new Map<GlyphRun, RunRecord>();
    let writeSlot = 0;
    data._styleCount = 0;
    data._freeStyleSlots.length = 0;
    data._styleVersion++;
    for (const [key, groupRuns] of runsByKey) {
        const curveSetId = groupRuns[0]!.curveSet;
        const curveSet = lookupCurveSet(storage, curveSetId, "reset");
        const existing = prevGroupByKey.get(key);
        const group: TextDataDrawGroup = existing ?? makeDrawGroup(curveSetId, curveSet, writeSlot, key);
        if (group._curveSet !== curveSet) {
            group._curveSet = curveSet;
            group._bindGroup = null;
            group._bindGroupVersion = -1;
        }
        group._slotStart = writeSlot;
        group._freeSlots = [];
        const groupIdx = newGroups.length;
        let liveInGroup = 0;
        for (const run of groupRuns) {
            const slots: number[] = new Array(run.glyphs.length).fill(-1);
            for (let i = 0; i < run.glyphs.length; i++) {
                slots[i] = writeSlot++;
            }
            const styleCount = countRunStyles(run);
            const styleSlots = new Array<number>(styleCount);
            for (let i = 0; i < styleCount; i++) {
                styleSlots[i] = data._styleCount++;
            }
            const live = writeRunToSlots(data, group, run, slots, styleSlots);
            liveInGroup += live.length;
            newRunRecords.set(run, { _run: run, _groupIdx: groupIdx, _slots: live, _styleSlots: styleSlots });
        }
        group._slotCount = writeSlot - group._slotStart;
        group._liveCount = liveInGroup;
        newGroups.push(group);
    }
    data._instanceCount = writeSlot;
    data._groups = newGroups;
    data._runs.length = 0;
    for (const r of runs) {
        data._runs.push(r);
    }
    data._runRecords = newRunRecords;
    data._dirtyStart = 0;
    data._dirtyEnd = writeSlot;
    data._version++;
    data._layoutVersion++;
}`],
    ["src/text/text-data.ts", "applyAddRun", `{
    if (data._runRecords.has(run)) {
        throw new Error("updateTextData addRun: GlyphRun reference is already in this TextData.");
    }
    const at = insertBefore ?? data._runs.length;
    lookupCurveSet(data._storage, run.curveSet, "addRun");
    const styleSlots = allocateStyles(data, countRunStyles(run));
    const group = ensureGroup(data, run.curveSet, runGroupKey(run));
    const groupIdx = data._groups.indexOf(group);
    const slots = allocateSlots(data, group, run.glyphs.length);
    const live = writeRunToSlots(data, group, run, slots, styleSlots);
    group._liveCount += live.length;
    data._runRecords.set(run, { _run: run, _groupIdx: groupIdx, _slots: live, _styleSlots: styleSlots });
    data._runs.splice(at, 0, run);
}`],
    ["src/text/text-data.ts", "applyRemoveRun", `{
    const run = resolveRun(data, ref);
    const rec = data._runRecords.get(run);
    if (!rec) {
        throw new Error("updateTextData removeRun: GlyphRun reference is not in this TextData.");
    }
    const group = data._groups[rec._groupIdx]!;
    freeSlots(data, group, rec._slots);
    group._liveCount -= rec._slots.length;
    releaseStyles(data, rec._styleSlots);
    data._runRecords.delete(run);
    const runIdx = resolveRunIndex(data, ref);
    if (runIdx >= 0) {
        data._runs.splice(runIdx, 1);
    }
    if (group._liveCount === 0) {
        dropEmptyGroup(data, group);
    }
}`],
    ["src/text/text-data.ts", "dropEmptyGroup", `{
    const idx = data._groups.indexOf(group);
    if (idx < 0) {
        return;
    }
    const removedStart = group._slotStart;
    const removedCount = group._slotCount;
    data._groups.splice(idx, 1);
    for (const r of data._runRecords.values()) {
        if (r._groupIdx > idx) {
            r._groupIdx--;
        }
    }
    if (removedCount > 0) {
        const floatDelta = removedCount * TEXT_INSTANCE_FLOATS;
        const moveStartFloat = (removedStart + removedCount) * TEXT_INSTANCE_FLOATS;
        const moveEndFloat = data._instanceCount * TEXT_INSTANCE_FLOATS;
        if (moveEndFloat > moveStartFloat) {
            data._instances.copyWithin(moveStartFloat - floatDelta, moveStartFloat, moveEndFloat);
        }
        shiftSlotsAtOrAfter(data, removedStart, -removedCount);
        data._instanceCount -= removedCount;
        markDirty(data, removedStart, data._instanceCount);
    }
}`],
    ["src/text/text-data.ts", "applyReplaceRun", `{
    const prev = resolveRun(data, prevRef);
    const rec = data._runRecords.get(prev);
    if (!rec) {
        throw new Error("updateTextData replaceRun: previous GlyphRun reference is not in this TextData.");
    }
    if (prev !== newRun && data._runRecords.has(newRun)) {
        throw new Error("updateTextData replaceRun: new GlyphRun reference is already in this TextData.");
    }
    const group = data._groups[rec._groupIdx]!;
    if (runGroupKey(newRun) === group._groupKey && newRun.glyphs.length > 0) {
        const styleSlots = allocateStyles(data, countRunStyles(newRun), rec._styleSlots);
        const prevSlotCount = rec._slots.length;
        let slots = rec._slots;
        if (newRun.glyphs.length !== prevSlotCount) {
            freeSlots(data, group, slots);
            slots = allocateSlots(data, group, newRun.glyphs.length);
        }
        const live = writeRunToSlots(data, group, newRun, slots, styleSlots);
        group._liveCount += live.length - prevSlotCount;
        if (prev === newRun) {
            rec._slots = live;
            rec._styleSlots = styleSlots;
        }
        else {
            data._runRecords.delete(prev);
            data._runRecords.set(newRun, { _run: newRun, _groupIdx: rec._groupIdx, _slots: live, _styleSlots: styleSlots });
            const runIdx = resolveRunIndex(data, prevRef);
            if (runIdx >= 0) {
                data._runs[runIdx] = newRun;
            }
        }
        return;
    }
    const insertPos = resolveRunIndex(data, prevRef);
    lookupCurveSet(data._storage, newRun.curveSet, "replaceRun");
    if (countRunStyles(newRun) > data._freeStyleSlots.length + rec._styleSlots.length + MAX_STYLE_ENTRIES - data._styleCount) {
        throw new Error(\`TextData style palette cannot exceed \${MAX_STYLE_ENTRIES} entries.\`);
    }
    applyRemoveRun(data, insertPos >= 0 ? insertPos : prev);
    applyAddRun(data, newRun, insertPos >= 0 ? insertPos : undefined);
}`],
    ["src/text/text-data.ts", "createTextData", `{
    const runsArray: GlyphRun[] = [];
    const instances = new Float32Array(TEXT_INSTANCE_FLOATS);
    const data = {
        runs: runsArray,
        _runs: runsArray,
        _groups: [],
        _runRecords: new Map(),
        _instances: instances,
        _instancesU32: new Uint32Array(instances.buffer),
        _instanceCount: 0,
        _styles: new Float32Array(TEXT_STYLE_FLOATS),
        _styleCount: 0,
        _freeStyleSlots: [],
        _styleVersion: 1,
        _storage: storage,
        _version: 1,
        _layoutVersion: 0,
        _dirtyStart: 0,
        _dirtyEnd: 0,
    } as unknown as TextData;
    if (runs && runs.length > 0) {
        applyReset(data, runs, storage);
    }
    return data;
}`],
    ["src/text/text-data.ts", "shiftSlotsAtOrAfter", `{
    for (const g of data._groups) {
        if (g !== exclude && g._slotStart >= threshold) {
            g._slotStart += delta;
            for (let i = 0; i < g._freeSlots.length; i++) {
                g._freeSlots[i] = g._freeSlots[i]! + delta;
            }
        }
    }
    for (const rec of data._runRecords.values()) {
        const slots = rec._slots;
        for (let i = 0; i < slots.length; i++) {
            if (slots[i]! >= threshold) {
                slots[i] = slots[i]! + delta;
            }
        }
    }
    data._layoutVersion++;
}`],
    ["src/text/text-data.ts", "popFreeSlot", `{
    return group._freeSlots.length > 0 ? group._freeSlots.pop()! : -1;
}`],
    ["src/text/default-text-data.ts", "createDefaultTextData", `{
    const laid = layoutText(font, text, fontSizePx, options);
    const innerCurves = new Map<number, GlyphCurves>();
    const seenGlyphs = new Uint8Array(font._font.numGlyphs);
    const ids = collectNewGlyphs(seenGlyphs, laid._glyphs);
    if (ids) {
        extractGlyphCurves(font, ids, innerCurves);
    }
    const curveSetId = familyCurveSetId(font);
    const storage = createGlyphStorage(new Map([[curveSetId, innerCurves]]));
    const run: GlyphRun = {
        curveSet: curveSetId,
        glyphs: laid._glyphs,
        pixelsPerFontUnit: laid._pixelsPerFontUnit,
        defaultColor: textColor,
    };
    return Object.assign(createTextData(storage, [run]), {
        width: laid._width,
        height: laid._height,
        _font: font,
        _fontSizePx: fontSizePx,
        _options: options,
        _curveSetId: curveSetId,
        _storage: storage,
        _seenGlyphs: seenGlyphs,
    }) as DefaultTextData;
}`],
    ["src/text/default-text-data.ts", "updateDefaultTextData", `{
    const laid = layoutText(data._font, text, data._fontSizePx, data._options);
    const ids = collectNewGlyphs(data._seenGlyphs, laid._glyphs);
    if (ids) {
        const innerCurves = new Map<number, GlyphCurves>();
        extractGlyphCurves(data._font, ids, innerCurves);
        updateGlyphStorage(data._storage, data._curveSetId, innerCurves);
    }
    const previousRun = data.runs[0]!;
    const newRun: GlyphRun = {
        curveSet: data._curveSetId,
        glyphs: laid._glyphs,
        pixelsPerFontUnit: laid._pixelsPerFontUnit,
        defaultColor: textColor ?? previousRun.defaultColor,
    };
    updateTextData(data, { update: "replaceRun", previous: previousRun, run: newRun });
    Object.assign(data, { width: laid._width, height: laid._height });
}`]
];
