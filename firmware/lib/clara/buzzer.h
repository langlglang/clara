// Buzzer patterns as a tone over time (0 = silent). No Arduino code; main.cpp drives the pin.
// `off` wins immediately; `alert` is bounded so a lost Pi can't leave it sounding (docs/contracts.md).
#pragma once

#include <cstdint>

namespace clara {

// Placeholder: the longest an alert sounds without being asked again.
constexpr uint32_t kAlertMaxMs = 10000;

enum class BuzzPattern : uint8_t { Off, Chime, Alert };

bool parseBuzzPattern(const char* text, BuzzPattern* pattern);

class Buzzer {
 public:
  void start(BuzzPattern pattern, uint32_t now);
  void stop() { pattern_ = BuzzPattern::Off; }
  // Tone in Hz now, or 0 for silence; ends the pattern when it is over.
  uint16_t tone(uint32_t now);
  bool on() const { return pattern_ != BuzzPattern::Off; }

 private:
  BuzzPattern pattern_ = BuzzPattern::Off;
  uint32_t since_ = 0;
};

}  // namespace clara
