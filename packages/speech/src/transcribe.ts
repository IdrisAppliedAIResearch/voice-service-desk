import { type LanguageCode, StartStreamTranscriptionCommand, TranscribeStreamingClient } from '@aws-sdk/client-transcribe-streaming';
import type { SttAdapter, Transcript } from './types';

export function createTranscribeStt({
  client = new TranscribeStreamingClient(),
  language,
}: {
  client?: TranscribeStreamingClient;
  language: LanguageCode;
}): SttAdapter {
  return {
    audio: true,
    start() {
      const listeners: ((t: Transcript) => void)[] = [];
      const errorListeners: ((err: unknown) => void)[] = [];
      let stopped = false;
      let request: ReturnType<typeof open> | undefined;

      function open() {
        const queue: Buffer[] = [];
        let wake = () => {};
        const r = {
          opened: false,
          ended: false,
          done: Promise.resolve(),
          push(pcm: Buffer) {
            queue.push(pcm);
            wake();
          },
          end() {
            r.ended = true;
            wake();
          },
        };

        async function* audio() {
          for (;;) {
            const pcm = queue.shift();
            if (pcm) yield { AudioEvent: { AudioChunk: pcm } };
            else if (r.ended) return;
            else await new Promise<void>((resolve) => (wake = resolve));
          }
        }

        r.done = (async () => {
          const { TranscriptResultStream } = await client.send(
            new StartStreamTranscriptionCommand({ LanguageCode: language, MediaEncoding: 'pcm', MediaSampleRateHertz: 16000, AudioStream: audio() }),
          );
          r.opened = true;
          for await (const event of TranscriptResultStream!) {
            for (const result of event.TranscriptEvent?.Transcript?.Results ?? []) {
              const text = result.Alternatives?.[0]?.Transcript;
              if (text) for (const cb of listeners) cb({ text, final: !result.IsPartial });
            }
          }
        })().finally(r.end);
        r.done.catch((err: unknown) => {
          if (!r.opened) for (const cb of errorListeners) cb(err);
        });
        return r;
      }

      return {
        pushAudio(pcm) {
          if (stopped || !pcm.length) return;
          // Reopen after Transcribe ends a request (15 s without audio); never retry one that failed to open, so it cannot loop.
          if (!request || (request.ended && request.opened)) request = open();
          if (!request.ended) request.push(pcm);
        },
        onTranscript(cb) {
          listeners.push(cb);
        },
        onError(cb) {
          errorListeners.push(cb);
        },
        async stop() {
          stopped = true;
          request?.end();
          await request?.done;
        },
      };
    },
  };
}
