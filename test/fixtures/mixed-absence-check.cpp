#define main generated_main
#include "program.hpp"
#undef main
#include <cassert>
int main() { assert(generated_main() == 0); }
