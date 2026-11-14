#include "pulse_estimator.h"

namespace clara {

const char* pulseQualityName(PulseQuality quality) {
  switch (quality) {
    case PulseQuality::Valid:
      return "valid";
    case PulseQuality::Suspect:
      return "suspect";
    case PulseQuality::Unavailable:
      return "unavailable";
  }
  return "unavailable";
}

void PulseEstimator::reset() {
  finger_ = false;
  haveBeat_ = false;
  filled_ = 0;
  next_ = 0;
}

void PulseEstimator::sample(uint32_t ir, bool beat, uint32_t now) {
  if (ir < kFingerIr) {
    // Finger lifted: every interval measured so far belonged to the last placement.
    reset();
    return;
  }
  finger_ = true;
  if (!beat) return;
  if (haveBeat_) {
    const uint32_t interval = now - lastBeat_;
    if (interval >= kMinIntervalMs && interval <= kMaxIntervalMs) {
      intervals_[next_] = interval;
      next_ = static_cast<uint8_t>((next_ + 1) % kIntervalSlots);
      if (filled_ < kIntervalSlots) ++filled_;
    } else if (interval > kMaxIntervalMs) {
      // A long silence: start counting again rather than mixing old and new beats.
      filled_ = 0;
      next_ = 0;
    } else {
      return;  // A double trigger inside one beat: keep the earlier beat time.
    }
  }
  haveBeat_ = true;
  lastBeat_ = now;
}

PulseResult PulseEstimator::result(uint32_t now) const {
  if (!finger_) return {-1, PulseQuality::Unavailable};
  if (!haveBeat_ || now - lastBeat_ > kBeatStaleMs || filled_ < kMinIntervals) return {-1, PulseQuality::Suspect};
  uint32_t sum = 0;
  for (uint8_t i = 0; i < filled_; ++i) sum += intervals_[i];
  const float mean = static_cast<float>(sum) / filled_;
  for (uint8_t i = 0; i < filled_; ++i) {
    const float diff = static_cast<float>(intervals_[i]) - mean;
    if ((diff < 0 ? -diff : diff) > mean * kMaxSpread) return {-1, PulseQuality::Suspect};
  }
  const int bpm = static_cast<int>(60000.0f / mean + 0.5f);
  if (bpm < 30 || bpm > 200) return {-1, PulseQuality::Suspect};
  return {bpm, PulseQuality::Valid};
}

}  // namespace clara
