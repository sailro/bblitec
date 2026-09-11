#include <cassert>
#include <iostream>

namespace bbl {
Engine create_engine(EngineOptions) { return {}; }
static int observed_uploads = 0;
template<class Data>
void observe_upload(Engine& engine, StorageBufferHandle handle, const Data& data, double offset) {
    update_storage_buffer(engine, handle, data, offset);
    const auto& stored = engine.storage_buffers[handle.value].bytes;
    assert(stored.size() == 16 && stored[0] == 7 + observed_uploads++ * 2);
}
}

template<class Read> void contiguous_refused(Read read) {
    bool refused=false;
    try {read();} catch(const std::runtime_error& error) {
        refused=std::string(error.what()).find("contiguous native access or method")!=std::string::npos;
    }
    assert(refused);
}

int main() {
    using namespace bbl::js;
    assert(generated_scene_main()==0);
    assert(bbl::observed_uploads == 2);
    ArrayBuffer buffer(std::vector<std::uint8_t>(24));
    F32Array view(buffer,4,3);
    F32Array owned{1,2,3};
    contiguous_refused([&]{static_cast<void>(view.data());});
    contiguous_refused([&]{static_cast<void>(view[0]);});
    contiguous_refused([&]{static_cast<void>(view.storage());});
    typed_array_set(view, owned, 0);
    auto copied = f32_array_from(view);
    assert(copied.load(0) == 1 && copied.load(2) == 3);
    array_copy_within(view, 1, 0, 2);
    assert(view.load(0) == 1 && view.load(1) == 1 && view.load(2) == 2);
    auto sliced = typed_array_slice(view, 1, 3);
    array_fill_range(view, 9.0f, 1, 3);
    assert(sliced.load(0) == 1 && sliced.load(1) == 2 && view.load(2) == 9);
    typed_array_set(owned, view, 0);
    assert(owned.load(0) == 1 && owned.load(1) == 9 && owned.load(2) == 9);
    array_fill(view, 7.0f);
    assert(view.load(0) == 7 && view.load(2) == 7 && owned.load(0) == 1);
    F32Array overlapping(buffer, 0, 4);
    typed_array_set(overlapping, view, 0);
    assert(overlapping.load(0) == 7 && overlapping.load(2) == 7);
    assert(ArrayBuffer(view)==buffer);
    assert(ArrayBuffer(view).data()==buffer.data());
    assert(owned.data()!=nullptr && owned[1]==9);
    bool borrowed_refused = false;
    try {
        static_cast<void>(retain_typed_array_owner(std::vector<float>{1}));
    } catch (const std::runtime_error& error) {
        borrowed_refused = std::string(error.what()).find("borrowed native vector") != std::string::npos;
    }
    assert(borrowed_refused);
    std::cout<<"numeric-buffer-views-check: ok\n";
}
