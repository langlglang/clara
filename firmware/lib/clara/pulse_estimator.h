// Demo-only heart-rate estimate from the MAX30102's full 18-bit IR samples.
// The sensor is configured for 100 conversions/s averaged four at a time: 25 FIFO records/s.
// This code rejects absent contact, saturation, interrupted sampling and inconsistent beat intervals.
// It is not a medical measurement and never estimates oxygen saturation.
#pragma once

#include <cstdint>

namespace clara {

constexpr uint32_t kFingerIr = 50000;       // SparkFun's example contact threshold; tune on the actual breakout.
constexpr uint32_t kSaturatedIr = 260000;   // MAX30102 FIFO is 18 bit (maximum 262143).
constexpr uint8_t kMinIntervals = 4;
constexpr uint8_t kIntervalSlots = 5;
constexpr uint32_t kMinIntervalMs = 300;   // 200 bpm
constexpr uint32_t kMaxIntervalMs = 2000;  // 30 bpm
constexpr uint32_t kBeatStaleMs = 2500;
constexpr uint32_t kSampleGapMs = 120;     // More than three expected 40 ms FIFO periods.
constexpr float kMaxIntervalSpread = 0.18f;

enum class PulseQuality : uint8_t { Valid, Suspect, Unavailable };

const char* pulseQualityName(PulseQuality quality);

struct PulseResult {
  int bpm;  // -1 means null
  PulseQuality quality;
};

class PulseEstimator {
 public:
  void reset();
  // Supply every IR FIFO record in chronological order, with its reconstructed monotonic sample time.
  void sample(uint32_t ir, uint32_t sampledAtMs);
  PulseResult result(uint32_t nowMs) const;

 private:
  void beginContact(uint32_t ir, uint32_t sampledAtMs);
  void acceptPeak(uint32_t peakAtMs);

  bool finger_ = false;
  bool haveBeat_ = false;
  uint32_t lastSample_ = 0;
  uint32_t lastBeat_ = 0;
  float dc_ = 0;
  float ac1_ = 0;
  float ac2_ = 0;
  float filtered1_ = 0;
  float filtered2_ = 0;
  float trough_ = 0;
  uint8_t filteredCount_ = 0;
  uint32_t intervals_[kIntervalSlots] = {};
  uint8_t filled_ = 0;
  uint8_t next_ = 0;
};

}  // namespace clara
