import { PollyClient, SynthesizeSpeechCommand, type VoiceId } from '@aws-sdk/client-polly';
import type { TtsAdapter } from './types';

export function createPollyTts({ client = new PollyClient(), voiceId }: { client?: PollyClient; voiceId: VoiceId }): TtsAdapter {
  return {
    async *synthesize(text) {
      const { AudioStream } = await client.send(
        new SynthesizeSpeechCommand({ Text: text, VoiceId: voiceId, Engine: 'neural', OutputFormat: 'pcm', SampleRate: '16000' }),
      );
      let carry = Buffer.alloc(0);
      for await (const chunk of AudioStream as AsyncIterable<Uint8Array>) {
        const pcm = Buffer.concat([carry, chunk]);
        const whole = pcm.length & ~1;
        carry = pcm.subarray(whole);
        if (whole) yield pcm.subarray(0, whole);
      }
    },
  };
}
