// Compartment LEDs and the all-LED rhythm, as levels over time. No Arduino code: main.cpp writes level()
// to each PWM channel every loop, and the native tests check the rules on a fake clock.
//
// Rules (docs/contracts.md, "light.set.request"): at most one compartment lit; a light goes off when its lease
// ends; clear() turns everything off (lid close, Pi silent, reset). A rhythm drives every LED and wins over a
// single compartment while it runs.
#pragma once

#include <cstdint>

namespace clara {

constexpr uint8_t kMaxLeds = 16;
// Placeholder from docs/contracts.md ("proposed maximum 30 seconds"); longer requests are shortened to this.
constexpr uint32_t kMaxLeaseMs = 30000;
constexpr uint32_t kBlinkPeriodMs = 1000;
constexpr uint32_t kBreathPeriodMs = 1600;
// How long each LED flash lasts on a CPR beat (capped at half the beat period).
constexpr uint32_t kBeatFlashMs = 120;
// Morse unit for the SOS flash.
constexpr uint32_t kSosUnitMs = 200;

enum class LedMode : uint8_t { Solid, Blink, Pulse };
enum class RhythmPattern : uint8_t { Beat, Sos };

bool parseLedMode(const char* text, LedMode* mode);

class Lights {
 public:
  explicit Lights(uint8_t count) : count_(count > kMaxLeds ? kMaxLeds : count) {}

  uint8_t count() const { return count_; }

  // Lights `channel` for `ms` (others off). Returns false for a channel outside 0..count-1.
  bool light(int channel, uint32_t ms, LedMode mode, uint32_t now);
  // Turns the compartment light off (leaves a rhythm running).
  void clearCompartment();
  // `bpm` 0 stops the rhythm. Returns false for bpm over 200.
  bool rhythm(uint16_t bpm, RhythmPattern pattern, uint32_t now);
  // Everything off: compartment and rhythm.
  void clear();
  // Ends an expired lease. Call every loop.
  void update(uint32_t now);
  // 0..255 for one channel now.
  uint8_t level(uint8_t channel, uint32_t now) const;

  int litChannel() const { return lit_; }
  uint16_t rhythmBpm() const { return bpm_; }
  bool rhythmOn() const { return bpm_ > 0 || sosOn_; }
  bool anyOn() const { return lit_ >= 0 || rhythmOn(); }

 private:
  uint8_t rhythmLevel(uint32_t now) const;

  const uint8_t count_;
  int lit_ = -1;
  LedMode mode_ = LedMode::Solid;
  uint32_t litSince_ = 0;
  uint32_t leaseMs_ = 0;
  uint16_t bpm_ = 0;
  RhythmPattern pattern_ = RhythmPattern::Beat;
  bool sosOn_ = false;
  uint32_t rhythmSince_ = 0;
};

}  // namespace clara
