// Adapted from Sophi (github.com/mzhao1599/sophi), firmware/lib/module/debounce.h.
// Turns a bouncing switch level into clean changes. Plain C++ so it is tested natively.
#pragma once

#include <cstdint>

namespace clara {

// Placeholder, not measured: a switch level must hold this long before it counts.
constexpr uint32_t kSwitchDebounceMs = 30;

class Debouncer {
 public:
  enum class Result : uint8_t { None, Changed };

  explicit Debouncer(uint32_t stableMs = kSwitchDebounceMs) : stableMs_(stableMs) {}

  // `level` is the raw reading now. Returns Changed once a new level has held for stableMs, including the
  // first stable level after boot (so the Pi learns the lid's state at start). Bounce gives one change.
  Result update(bool level, uint32_t now);

  bool settled() const { return settled_; }
  bool level() const { return stable_; }

 private:
  const uint32_t stableMs_;
  bool started_ = false;
  bool candidate_ = false;
  uint32_t candidateSince_ = 0;
  bool settled_ = false;
  bool stable_ = false;
};

}  // namespace clara
