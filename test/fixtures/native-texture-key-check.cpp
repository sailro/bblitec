#include <cassert>

int main() {
    assert(generated_main() == 0);
    bbl::FileTexture file;
    file.identity = 7;
    file.width = 1;
    auto alias = file;
    alias.width = 8;
    bbl::FileTexture other = file;
    other.identity = 8;
    bbl::PixelsTexture pixels;
    pixels.identity = 7;
    pixels.width = 1;
    auto pixels_alias = pixels;
    pixels_alias.version = 9;
    pixels_alias.width = 8;

    bbl::js::Map<bbl::StoredTexture, double> values;
    values.set(bbl::StoredTexture{file}, 1);
    values.set(bbl::StoredTexture{alias}, 2);
    values.set(bbl::StoredTexture{other}, 3);
    values.set(bbl::StoredTexture{pixels}, 4);
    assert(values.size() == 3);
    assert(values.at(bbl::StoredTexture{file}) == 2);
    assert(values.at(bbl::StoredTexture{pixels_alias}) == 4);

    auto retained = values;
    values.clear();
    assert(retained.size() == 0);
    retained.set(bbl::StoredTexture{pixels_alias}, 5);
    assert(values.at(bbl::StoredTexture{pixels}) == 5);

    bbl::js::Set<bbl::StoredTexture> keys;
    keys.add(bbl::StoredTexture{file});
    keys.add(bbl::StoredTexture{alias});
    keys.add(bbl::StoredTexture{other});
    keys.add(bbl::StoredTexture{pixels});
    assert(keys.size() == 3);
    assert(keys.has(bbl::StoredTexture{pixels_alias}));
    assert(keys.erase(bbl::StoredTexture{alias}));
    assert(!keys.has(bbl::StoredTexture{file}));
    assert(keys.has(bbl::StoredTexture{pixels}));
    return 0;
}
