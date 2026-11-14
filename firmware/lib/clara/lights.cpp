#include "lights.h"

#include <cstring>

namespace clara {

bool parseLedMode(const char* text, LedMode* mode) {
  if (!text) return false;
  if (std::strcmp(text, "solid") == 0) *mode = LedMode::Solid;
  else if (std::strcmp(text, "blink") == 0) *mode = LedMode::Blink;
  else if (std::strcmp(text, "pulse") == 0) *mode = LedMode::Pulse;
  else return false;
  return true;
}

bool Lights::light(int channel, uint32_t ms, LedMode mode, uint32_t now) {
  if (channel < 0 || channel >= count_) return false;
  lit_ = channel;
  mode_ = mode;
  litSince_ = now;
  leaseMs_ = ms > kMaxLeaseMs ? kMaxLeaseMs : ms;
  if (leaseMs_ == 0) lit_ = -1;
  return true;
}

void Lights::clearCompartment() { lit_ = -1; }

bool Lights::rhythm(uint16_t bpm, RhythmPattern pattern, uint32_t now) {
  if (bpm > 200) return false;
  pattern_ = pattern;
  sosOn_ = pattern == RhythmPattern::Sos && bpm > 0;
  bpm_ = pattern == RhythmPattern::Sos ? 0 : bpm;
  if (bpm == 0) {
    bpm_ = 0;
    sosOn_ = false;
    pattern_ = RhythmPattern::Beat;
  }
  rhythmSince_ = now;
  return true;
}

void Lights::clear() {
  lit_ = -1;
  bpm_ = 0;
  sosOn_ = false;
  pattern_ = RhythmPattern::Beat;
}

void Lights::update(uint32_t now) {
  // A command can arrive after the caller captured its loop time. A slightly older time is not an expired lease.
  if (lit_ >= 0 && static_cast<int32_t>(now - litSince_) >= 0 && now - litSince_ >= leaseMs_) lit_ = -1;
}

uint8_t Lights::rhythmLevel(uint32_t now) const {
  const uint32_t t = now - rhythmSince_;
  if (sosOn_) {
    // ... --- ... : dot 1 unit, dash 3, gap 1 inside a letter, 3 between letters, 7 before repeating.
    static const uint8_t kOn[] = {1, 1, 1, 3, 3, 3, 1, 1, 1};
    uint32_t cycle = 0;
    for (uint8_t i = 0; i < 9; ++i) cycle += kOn[i] + ((i == 2 || i == 5) ? 3 : (i == 8 ? 7 : 1));
    uint32_t pos = (t / kSosUnitMs) % cycle;
    for (uint8_t i = 0; i < 9; ++i) {
      if (pos < kOn[i]) return 255;
      pos -= kOn[i];
      const uint32_t gap = (i == 2 || i == 5) ? 3 : (i == 8 ? 7 : 1);
      if (pos < gap) return 0;
      pos -= gap;
    }
    return 0;
  }
  if (bpm_ == 0) return 0;
  const uint32_t period = 60000u / bpm_;
  const uint32_t flash = kBeatFlashMs < period / 2 ? kBeatFlashMs : period / 2;
  return (t % period) < flash ? 255 : 0;
}

uint8_t Lights::level(uint8_t channel, uint32_t now) const {
  if (channel >= count_) return 0;
  if (rhythmOn()) return rhythmLevel(now);
  if (static_cast<int>(channel) != lit_) return 0;
  const uint32_t t = now - litSince_;
  switch (mode_) {
    case LedMode::Solid:
      return 255;
    case LedMode::Blink:
      return (t % kBlinkPeriodMs) < kBlinkPeriodMs / 2 ? 255 : 0;
    case LedMode::Pulse: {
      // A triangle "breath" from dim to full and back, never fully off so the slot stays findable.
      const uint32_t phase = t % kBreathPeriodMs;
      const uint32_t half = kBreathPeriodMs / 2;
      const uint32_t rise = phase < half ? phase : kBreathPeriodMs - phase;
      return static_cast<uint8_t>(20 + (235u * rise) / half);
    }
  }
  return 0;
}

}  // namespace clara
