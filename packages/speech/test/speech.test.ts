import { Readable } from 'node:stream';
import type { PollyClient, SynthesizeSpeechCommand } from '@aws-sdk/client-polly';
import type { StartStreamTranscriptionCommand, TranscribeStreamingClient } from '@aws-sdk/client-transcribe-streaming';
import { describe, expect, it, vi } from 'vitest';
import { createStt, createTts, type SttStream, type Transcript, type TtsFrame } from '../src/index';
import { createPollyTts } from '../src/polly';
import { createTranscribeStt } from '../src/transcribe';

// Every AWS client constructed in this file is a fake, so no test can reach AWS with real credentials.
const aws = vi.hoisted(() => ({ transcribe: vi.fn(), polly: vi.fn() }));
vi.mock('@aws-sdk/client-transcribe-streaming', async (original) => ({
  ...(await original<object>()),
  TranscribeStreamingClient: class {
    send = aws.transcribe;
  },
}));
vi.mock('@aws-sdk/client-polly', async (original) => ({
  ...(await original<object>()),
  PollyClient: class {
    send = aws.polly;
  },
}));

// Behaves like the service: a partial result per audio event, then a final once the audio stream ends.
function fakeTranscribe(heard: string[] = []) {
  return vi.fn(async ({ input }: StartStreamTranscriptionCommand) => ({
    TranscriptResultStream: (async function* () {
      const event = (IsPartial: boolean) => ({
        TranscriptEvent: { Transcript: { Results: [{ IsPartial, Alternatives: [{ Transcript: heard.join(' ') }] }] } },
      });
      for await (const audio of input.AudioStream!) {
        heard.push(Buffer.from(audio.AudioEvent!.AudioChunk!).toString());
        yield event(true);
      }
      yield event(false);
    })(),
  }));
}

function fakePolly(...chunks: Uint8Array[]) {
  return vi.fn(async (_: SynthesizeSpeechCommand) => ({ AudioStream: Readable.from(chunks) }));
}

const transcribeStt = (send: unknown) =>
  createTranscribeStt({ client: { send } as unknown as TranscribeStreamingClient, language: 'en-US' });

function listen(stream: SttStream): Transcript[] {
  const seen: Transcript[] = [];
  stream.onTranscript((t) => seen.push(t));
  return seen;
}

async function collect(frames: AsyncIterable<TtsFrame>): Promise<TtsFrame[]> {
  const out: TtsFrame[] = [];
  for await (const frame of frames) out.push(frame);
  return out;
}

describe('Transcribe STT adapter', () => {
  it('streams pushed audio in order, maps partials and finals, and stop() ends the audio stream', async () => {
    const heard: string[] = [];
    const send = fakeTranscribe(heard);
    const stream = transcribeStt(send).start('s1');
    const seen = listen(stream);
    stream.pushAudio(Buffer.from('reset'));
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    stream.pushAudio(Buffer.from('my'));
    stream.pushAudio(Buffer.from('password'));
    await stream.stop();
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0][0].input).toMatchObject({
      LanguageCode: 'en-US',
      MediaEncoding: 'pcm',
      MediaSampleRateHertz: 16000,
    });
    expect(heard).toEqual(['reset', 'my', 'password']);
    expect(seen).toEqual([
      { text: 'reset', final: false },
      { text: 'reset my', final: false },
      { text: 'reset my password', final: false },
      { text: 'reset my password', final: true },
    ]);
  });

  it('opens no stream until audio arrives and ignores empty or late audio', async () => {
    const send = fakeTranscribe();
    const stream = transcribeStt(send).start('s1');
    stream.pushAudio(Buffer.alloc(0));
    await stream.stop();
    stream.pushAudio(Buffer.from('late'));
    expect(send).not.toHaveBeenCalled();
  });

  it('rejects stop() with a stream error instead of leaving an unhandled rejection', async () => {
    const send = vi.fn(async () => ({
      TranscriptResultStream: (async function* () {
        throw new Error('BadRequestException: no new audio was received for 15 seconds');
      })(),
    }));
    const stream = transcribeStt(send).start('s1');
    stream.pushAudio(Buffer.from('hello'));
    await new Promise((resolve) => setTimeout(resolve, 20));
    await expect(stream.stop()).rejects.toThrow('15 seconds');
    expect(send).toHaveBeenCalledOnce();
  });

  it('opens a new request for audio after Transcribe ended one, but reports and never retries a request that failed to open', async () => {
    const heard: string[] = [];
    const failed = vi.fn();
    const send = vi
      .fn()
      .mockImplementationOnce(async () => ({
        TranscriptResultStream: (async function* () {
          throw new Error('BadRequestException: no new audio was received for 15 seconds');
        })(),
      }))
      .mockImplementation(fakeTranscribe(heard));
    const stream = transcribeStt(send).start('s1');
    const seen = listen(stream);
    stream.onError(failed);
    stream.pushAudio(Buffer.from('hello'));
    await new Promise((resolve) => setTimeout(resolve, 20));
    stream.pushAudio(Buffer.from('back again'));
    await stream.stop();
    expect(send).toHaveBeenCalledTimes(2);
    expect(heard).toEqual(['back again']);
    expect(seen.at(-1)).toEqual({ text: 'back again', final: true });
    expect(failed).not.toHaveBeenCalled();

    const refused = vi.fn(async () => {
      throw new Error('Could not load credentials from any providers');
    });
    const broken = transcribeStt(refused).start('s2');
    broken.onError(failed);
    broken.pushAudio(Buffer.from('one'));
    await new Promise((resolve) => setTimeout(resolve, 20));
    broken.pushAudio(Buffer.from('two'));
    await expect(broken.stop()).rejects.toThrow('credentials');
    expect(refused).toHaveBeenCalledOnce();
    expect(failed).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ message: 'Could not load credentials from any providers' }));
  });
});

describe('Polly TTS adapter', () => {
  it('requests the neural voice as 16 kHz PCM and yields Buffers of whole 16-bit samples', async () => {
    const send = fakePolly(new Uint8Array([1, 2, 3]), Buffer.from([4, 5, 6, 7, 8]));
    const tts = createPollyTts({ client: { send } as unknown as PollyClient, voiceId: 'Joanna' });
    const frames = await collect(tts.synthesize('Your ticket is open.'));
    expect(send.mock.calls[0][0].input).toEqual({
      Text: 'Your ticket is open.',
      VoiceId: 'Joanna',
      Engine: 'neural',
      OutputFormat: 'pcm',
      SampleRate: '16000',
    });
    expect(frames).toEqual([Buffer.from([1, 2]), Buffer.from([3, 4, 5, 6, 7, 8])]);
    expect(frames.every((frame) => Buffer.isBuffer(frame))).toBe(true);
  });
});

describe('createStt and createTts', () => {
  it.each([{}, { STT_PROVIDER: 'text', STT_LANGUAGE: 'en-US', TTS_PROVIDER: 'text' }])(
    'text adapters pass text straight through (env %j)',
    async (env) => {
      const stream = createStt(env).start('s1');
      const seen = listen(stream);
      stream.pushAudio(Buffer.from('  reset my password\n'));
      await stream.stop();
      expect(seen).toEqual([{ text: 'reset my password', final: true }]);
      expect(await collect(createTts(env).synthesize('Hello.'))).toEqual(['Hello.']);
    },
  );

  it.each([
    [{ STT_LANGUAGE: 'es-US' }, 'STT_LANGUAGE must be en-US'],
    [{ STT_PROVIDER: 'transcribe', STT_LANGUAGE: 'en-GB' }, 'STT_LANGUAGE must be en-US'],
    [{ STT_PROVIDER: 'whisper' }, 'STT_PROVIDER must be text or transcribe, got "whisper"'],
  ])('createStt rejects %j', (env, message) => {
    expect(() => createStt(env)).toThrow(message);
  });

  it('createTts rejects an unknown provider', () => {
    expect(() => createTts({ TTS_PROVIDER: 'espeak' })).toThrow('TTS_PROVIDER must be text or polly, got "espeak"');
  });

  it('transcribe provider takes audio and streams in en-US by default', async () => {
    aws.transcribe.mockImplementation(fakeTranscribe());
    const stt = createStt({ STT_PROVIDER: 'transcribe' });
    expect(stt.audio).toBe(true);
    const stream = stt.start('s1');
    const seen = listen(stream);
    stream.pushAudio(Buffer.from('hello'));
    await stream.stop();
    expect(aws.transcribe.mock.calls[0][0].input).toMatchObject({ LanguageCode: 'en-US', MediaEncoding: 'pcm' });
    expect(seen.at(-1)).toEqual({ text: 'hello', final: true });
  });

  it('polly provider speaks with TTS_VOICE_ID, default Joanna', async () => {
    aws.polly.mockImplementation(fakePolly(Buffer.alloc(4)));
    await collect(createTts({ TTS_PROVIDER: 'polly' }).synthesize('Hi.'));
    await collect(createTts({ TTS_PROVIDER: 'polly', TTS_VOICE_ID: 'Matthew' }).synthesize('Hi.'));
    expect(aws.polly.mock.calls.map(([command]) => command.input.VoiceId)).toEqual(['Joanna', 'Matthew']);
  });
});
