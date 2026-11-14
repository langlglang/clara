/**
 * Discard only speech-to-text output that cannot be a useful spoken turn. This runs on audio
 * transcripts, never typed text. Short commands such as "help", "yes", "no", "SOS" and item names
 * must still reach the agent.
 */
export function isObviousNonRequestTranscript(words: string): boolean {
  const normalized = words.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  if (!normalized) return true;
  if (/^(?:(?:um|uh|erm|er|hmm|hm)(?:\s+|$))+$/u.test(normalized)) return true;
  return /^\s*[[(]\s*(?:no speech|background noise|noise|silence|music|applause|laughter|inaudible|unintelligible)\s*[\])]\s*$/iu.test(words);
}
