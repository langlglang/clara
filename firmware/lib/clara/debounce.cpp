// Adapted from Sophi (github.com/mzhao1599/sophi), firmware/lib/module/debounce.cpp.
#include "debounce.h"

namespace clara {

Debouncer::Result Debouncer::update(bool level, uint32_t now) {
  if (!started_ || level != candidate_) {
    started_ = true;
    candidate_ = level;
    candidateSince_ = now;
    return Result::None;
  }
  if (now - candidateSince_ < stableMs_) return Result::None;
  if (settled_ && candidate_ == stable_) return Result::None;
  settled_ = true;
  stable_ = candidate_;
  return Result::Changed;
}

}  // namespace clara
