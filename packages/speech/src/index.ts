import type { VoiceId } from '@aws-sdk/client-polly';
import { createPollyTts } from './polly';
import { createTranscribeStt } from './transcribe';
import type { SttAdapter, Transcript, TtsAdapter } from './types';

export * from './types';

const textStt: SttAdapter = {
  audio: false,
  start() {
    const listeners: ((t: Transcript) => void)[] = [];
    return {
      pushAudio(pcm) {
        for (const cb of listeners) cb({ text: pcm.toString('utf8').trim(), final: true });
      },
      onTranscript(cb) {
        listeners.push(cb);
      },
      onError() {},
      async stop() {},
    };
  },
};

const textTts: TtsAdapter = {
  async *synthesize(text) {
    yield text;
  },
};

export function createStt(env: NodeJS.ProcessEnv = process.env): SttAdapter {
  const language = env.STT_LANGUAGE || 'en-US';
  if (language !== 'en-US') throw new Error(`STT_LANGUAGE must be en-US (the only supported language), got "${language}"`);
  switch (env.STT_PROVIDER || 'text') {
    case 'text':
      return textStt;
    case 'transcribe':
      return createTranscribeStt({ language });
    default:
      throw new Error(`STT_PROVIDER must be text or transcribe, got "${env.STT_PROVIDER}"`);
  }
}

export function createTts(env: NodeJS.ProcessEnv = process.env): TtsAdapter {
  switch (env.TTS_PROVIDER || 'text') {
    case 'text':
      return textTts;
    case 'polly':
      return createPollyTts({ voiceId: (env.TTS_VOICE_ID || 'Joanna') as VoiceId });
    default:
      throw new Error(`TTS_PROVIDER must be text or polly, got "${env.TTS_PROVIDER}"`);
  }
}
