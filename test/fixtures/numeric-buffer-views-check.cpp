#include <cassert>
#include <iostream>

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
    ArrayBuffer buffer(std::vector<std::uint8_t>(24));
    F32Array view(buffer,4,3);
    F32Array owned{1,2,3};
    contiguous_refused([&]{static_cast<void>(view.data());});
    contiguous_refused([&]{static_cast<void>(view[0]);});
    contiguous_refused([&]{static_cast<void>(view.storage());});
    contiguous_refused([&]{static_cast<void>(f32_array_from(view));});
    contiguous_refused([&]{typed_array_set(view,owned,0);});
    contiguous_refused([&]{typed_array_set(owned,view,0);});
    contiguous_refused([&]{static_cast<void>(typed_array_slice(view,0,2));});
    contiguous_refused([&]{array_fill(view,1.0f);});
    contiguous_refused([&]{array_copy_within(view,1,0,2);});
    assert(ArrayBuffer(view)==buffer);
    assert(ArrayBuffer(view).data()==buffer.data());
    assert(owned.data()!=nullptr && owned[1]==2);
    std::cout<<"numeric-buffer-views-check: ok\n";
}
