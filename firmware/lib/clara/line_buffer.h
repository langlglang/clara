// Adapted from Sophi (github.com/mzhao1599/sophi), devices/pi/src/serial/lineReader.ts (the same rule on the
// board's side): collects bytes into lines of at most kMaxLine bytes counting the newline. A longer line is
// dropped up to its newline and reading resumes at the next one. No Arduino code.
#pragma once

#include <cstddef>
#include <cstdint>

namespace clara {

constexpr size_t kMaxLine = 1024;  // SERIAL_MAX_LINE in packages/contracts/src/serial.ts

class LineBuffer {
 public:
  // Feeds one byte. Returns true when a complete line is ready in line()/length() (newline and a trailing \r
  // removed, NUL-terminated). The line stays valid until the next push.
  bool push(uint8_t byte);
  const char* line() const { return buffer_; }
  size_t length() const { return ready_; }
  uint32_t oversize() const { return oversize_; }

 private:
  char buffer_[kMaxLine] = {};
  size_t length_ = 0;
  size_t ready_ = 0;
  bool discarding_ = false;
  uint32_t oversize_ = 0;
};

}  // namespace clara
