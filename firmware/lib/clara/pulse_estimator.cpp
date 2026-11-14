#include "pulse_estimator.h"

#include <cmath>

namespace clara {

const char* pulseQualityName(PulseQuality quality) {
  switch (quality) {
    case PulseQuality::Valid: return "valid";
    case PulseQuality::Suspect: return "suspect";
    case PulseQuality::Unavailable: return "unavailable";
  }
  return "unavailable";
}

void PulseEstimator::reset() {
  finger_ = false;
  haveBeat_ = false;
  filteredCount_ = 0;
  filled_ = 0;
  next_ = 0;
}

void PulseEstimator::beginContact(uint32_t ir, uint32_t sampledAtMs) {
  reset();
  finger_ = true;
  lastSample_ = sampledAtMs;
  dc_ = static_cast<float>(ir);
  ac1_ = ac2_ = filtered1_ = filtered2_ = trough_ = 0;
}

void PulseEstimator::acceptPeak(uint32_t peakAtMs) {
  if (haveBeat_) {
    const uint32_t interval = peakAtMs - lastBeat_;
    if (interval < kMinIntervalMs) return;  // One beat cannot create two peaks.
    if (interval > kMaxIntervalMs) {
      filled_ = 0;
      next_ = 0;
    } else {
      intervals_[next_] = interval;
      next_ = static_cast<uint8_t>((next_ + 1) % kIntervalSlots);
      if (filled_ < kIntervalSlots) ++filled_;
    }
  }
  haveBeat_ = true;
  lastBeat_ = peakAtMs;
}

void PulseEstimator::sample(uint32_t ir, uint32_t sampledAtMs) {
  if (ir < kFingerIr || ir >= kSaturatedIr) {
    reset();
    return;
  }
  if (!finger_) {
    beginContact(ir, sampledAtMs);
    return;
  }
  const uint32_t dt = sampledAtMs - lastSample_;
  if (dt < 20 || dt > kSampleGapMs) {
    beginContact(ir, sampledAtMs);  // An unknown sample gap invalidates all old beat times.
    return;
  }
  lastSample_ = sampledAtMs;
  const float difference = static_cast<float>(ir) - dc_;
  if (std::fabs(difference) > dc_ * 0.20f) {
    beginContact(ir, sampledAtMs);  // Abrupt contact or motion; start a new window.
    return;
  }
  dc_ += difference / 32.0f;  // Remove slow baseline drift without truncating the 18-bit reading.
  const float ac = static_cast<float>(ir) - dc_;
  // On the installed reflective breakout, each pulse is a downward IR trough.
  const float filtered = -(ac + ac1_ + ac2_) / 3.0f;  // Smooth high-frequency noise at 25 records/s.
  ac2_ = ac1_;
  ac1_ = ac;
  if (filteredCount_ < 2) {
    ++filteredCount_;
    filtered2_ = filtered1_;
    filtered1_ = filtered;
    trough_ = filtered < trough_ ? filtered : trough_;
    return;
  }

  if (filtered < trough_) trough_ = filtered;
  // A live hold had beat candidates below the old 0.2% of DC gate.
  const float minimumProminence = fmaxf(80.0f, dc_ * 0.001f);
  if (filtered1_ > filtered2_ && filtered1_ >= filtered &&
      filtered1_ > minimumProminence && filtered1_ - trough_ > minimumProminence * 2.0f) {
    acceptPeak(sampledAtMs - dt);
    trough_ = filtered;
  }
  filtered2_ = filtered1_;
  filtered1_ = filtered;
}

PulseResult PulseEstimator::result(uint32_t nowMs) const {
  if (!finger_ || nowMs - lastSample_ > kSampleGapMs) return {-1, PulseQuality::Unavailable};
  if (!haveBeat_ || nowMs - lastBeat_ > kBeatStaleMs || filled_ < kMinIntervals) return {-1, PulseQuality::Suspect};
  uint32_t sorted[kIntervalSlots];
  for (uint8_t i = 0; i < filled_; ++i) sorted[i] = intervals_[i];
  for (uint8_t i = 1; i < filled_; ++i) {
    uint32_t value = sorted[i];
    uint8_t j = i;
    while (j > 0 && sorted[j - 1] > value) { sorted[j] = sorted[j - 1]; --j; }
    sorted[j] = value;
  }
  const uint32_t median = sorted[filled_ / 2];
  uint8_t consistent = 0;
  for (uint8_t i = 0; i < filled_; ++i)
    if (std::fabs(static_cast<float>(sorted[i]) - median) <= median * kMaxIntervalSpread) ++consistent;
  // One motion peak can split a true beat. Require four agreeing intervals, including the newest.
  const uint8_t newest = static_cast<uint8_t>((next_ + kIntervalSlots - 1) % kIntervalSlots);
  if (consistent < kMinIntervals ||
      std::fabs(static_cast<float>(intervals_[newest]) - median) > median * kMaxIntervalSpread)
    return {-1, PulseQuality::Suspect};
  const int bpm = static_cast<int>((60000u + median / 2) / median);
  if (bpm < 30 || bpm > 200) return {-1, PulseQuality::Suspect};
  return {bpm, PulseQuality::Valid};
}

}  // namespace clara
