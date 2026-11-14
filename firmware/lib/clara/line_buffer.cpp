#include "line_buffer.h"

namespace clara {

bool LineBuffer::push(uint8_t byte) {
  if (byte == '\n') {
    if (discarding_) {
      discarding_ = false;
      length_ = 0;
      return false;
    }
    size_t end = length_;
    if (end > 0 && buffer_[end - 1] == '\r') --end;
    buffer_[end] = '\0';
    ready_ = end;
    length_ = 0;
    return end > 0;
  }
  if (discarding_) return false;
  // Room for the byte plus the newline still to come (kMaxLine counts it) and our NUL.
  if (length_ + 1 >= kMaxLine) {
    discarding_ = true;
    ++oversize_;
    length_ = 0;
    return false;
  }
  buffer_[length_++] = static_cast<char>(byte);
  return false;
}

}  // namespace clara
