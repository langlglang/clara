// Turns the MAX30102's IR samples and detected beats into a bpm the board is willing to report.
// No Arduino code. The rule: a number only when quality is "valid"; otherwise bpm is null. Never a guess.
//
// valid       finger on the sensor, at least kMinIntervals recent beat-to-beat intervals in 30-200 bpm,
//             all within kMaxSpread of their mean, and the last beat under kBeatStaleMs ago
// suspect     finger on the sensor but the beats are too few, too irregular or stale
// unavailable no finger (IR under kFingerIr), or no sensor (decided in main.cpp)
// These thresholds are placeholders from SparkFun's example (IR 50000 for a finger) and have not been checked
// against a reference device. Clara is a demo and never used on a patient.
#pragma once

#include <cstdint>

namespace clara {

constexpr uint32_t kFingerIr = 50000;
constexpr uint8_t kMinIntervals = 4;
constexpr uint8_t kIntervalSlots = 6;
constexpr uint32_t kMinIntervalMs = 300;   // 200 bpm
constexpr uint32_t kMaxIntervalMs = 2000;  // 30 bpm
constexpr uint32_t kBeatStaleMs = 2500;
constexpr float kMaxSpread = 0.15f;

enum class PulseQuality : uint8_t { Valid, Suspect, Unavailable };

const char* pulseQualityName(PulseQuality quality);

struct PulseResult {
  int bpm;  // -1 means null
  PulseQuality quality;
};

class PulseEstimator {
 public:
  void reset();
  // One sample: its IR value, whether the beat detector fired on it, and when.
  void sample(uint32_t ir, bool beat, uint32_t now);
  PulseResult result(uint32_t now) const;

 private:
  bool finger_ = false;
  bool haveBeat_ = false;
  uint32_t lastBeat_ = 0;
  uint32_t intervals_[kIntervalSlots] = {};
  uint8_t filled_ = 0;
  uint8_t next_ = 0;
};

}  // namespace clara
