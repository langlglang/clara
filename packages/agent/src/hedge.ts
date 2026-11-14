// Adapted from Sophi (github.com/mzhao1599/sophi), services/cloud-api/src/walker/hedge.ts.
import type { Assistant, AssistantResult } from "./assistant.js";

/** Default switch-over: the backup's answer is used if the main model hasn't answered by then. */
export const BACKUP_AFTER_MS = 2_500;
/** The switch-over comes at least this long before the attempt's own limit. */
export const BACKUP_MARGIN_MS = 300;

/**
 * Main model with a backup asked at the same moment (Haiku 5.5 and Opus 5.5 by default). The main answer is
 * used unless it hasn't arrived `backupAfterMs` after the start; from then on the first usable answer wins.
 * - The main model fails early (API error, two broken replies, its deadline): the backup's answer is used as
 *   soon as it arrives, without waiting for the switch-over.
 * - A refusal from the main model is final: the backup doesn't overrule it.
 * - Both fail: the failure of the one that failed last is reported.
 * Once an answer is picked the other attempt is cancelled, so it can't start a retry.
 */
export function createHedgedAssistant({ main, backup, backupAfterMs = BACKUP_AFTER_MS }: { main: Assistant; backup: Assistant; backupAfterMs?: number }): Assistant {
  return {
    reply(state, language, words, limitMs, signal) {
      const started = Date.now();
      const cancel = new AbortController();
      const both = signal ? AbortSignal.any([signal, cancel.signal]) : cancel.signal;
      const crashed = (model: string) => (): AssistantResult => ({ ok: false, reason: "model_error", attempts: 1, ms: Date.now() - started, model });
      const fromMain = main.reply(state, language, words, limitMs, both).catch(crashed("main"));
      const fromBackup = backup.reply(state, language, words, limitMs, both).catch(crashed("backup"));
      return new Promise<AssistantResult>((resolve) => {
        let mainResult: AssistantResult | undefined;
        let backupResult: AssistantResult | undefined;
        let last: AssistantResult | undefined;
        let switched = false;
        let picked = false;
        const pick = (result: AssistantResult) => {
          if (picked) return;
          picked = true;
          clearTimeout(timer);
          cancel.abort();
          resolve({ ...result, ms: Date.now() - started });
        };
        const decide = () => {
          if (mainResult?.ok) return pick(mainResult);
          if (mainResult && !mainResult.ok && mainResult.reason === "refusal") return pick(mainResult);
          if (backupResult?.ok && (switched || mainResult)) return pick(backupResult);
          if (mainResult && backupResult) return pick(last!);
        };
        const timer = setTimeout(
          () => {
            switched = true;
            decide();
          },
          Math.max(0, Math.min(backupAfterMs, limitMs - BACKUP_MARGIN_MS)),
        );
        void fromMain.then((result) => {
          mainResult = last = result;
          decide();
        });
        void fromBackup.then((result) => {
          backupResult = last = result;
          decide();
        });
      });
    },
  };
}
