import { MetaProvider } from '../providers/meta.ts';
import type { ExplanationTransport } from './index.ts';

/** Adapter over the existing Meta provider: shared key/model/deadline/limits/ledger. */
export function metaExplanationTransport(provider = new MetaProvider()): ExplanationTransport {
  return {
    async generate(systemMessage, userMessage, signal) {
      const res = await provider.completeText(systemMessage, userMessage, signal);
      return { content: res.content, usage: res.usage, model: res.model };
    },
  };
}
