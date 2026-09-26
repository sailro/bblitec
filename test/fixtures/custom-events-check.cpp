#define main generated_main
#include "program.hpp"
#undef main
#include <cassert>

namespace bbl {
Engine create_engine(EngineOptions) { return {}; }
}

int main() { assert(generated_main() == 0); }
