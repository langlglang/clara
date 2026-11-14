#include "buzzer.h"

#include <cstring>

namespace clara {

bool parseBuzzPattern(const char* text, BuzzPattern* pattern) {
  if (!text) return false;
  if (std::strcmp(text, "off") == 0) *pattern = BuzzPattern::Off;
  else if (std::strcmp(text, "chime") == 0) *pattern = BuzzPattern::Chime;
  else if (std::strcmp(text, "alert") == 0) *pattern = BuzzPattern::Alert;
  else return false;
  return true;
}

void Buzzer::start(BuzzPattern pattern, uint32_t now) {
  pattern_ = pattern;
  since_ = now;
}

uint16_t Buzzer::tone(uint32_t now) {
  const uint32_t t = now - since_;
  switch (pattern_) {
    case BuzzPattern::Off:
      return 0;
    case BuzzPattern::Chime:
      // Two rising notes: 880 Hz then 1320 Hz, 150 ms each with a short gap.
      if (t < 150) return 880;
      if (t < 190) return 0;
      if (t < 340) return 1320;
      pattern_ = BuzzPattern::Off;
      return 0;
    case BuzzPattern::Alert:
      if (t >= kAlertMaxMs) {
        pattern_ = BuzzPattern::Off;
        return 0;
      }
      return (t % 500) < 250 ? 2000 : 0;
  }
  return 0;
}

}  // namespace clara
