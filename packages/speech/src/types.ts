export interface Transcript {
  text: string;
  final: boolean;
}

export interface SttStream {
  pushAudio(pcm: Buffer): void;
  onTranscript(cb: (t: Transcript) => void): void;
  onError(cb: (err: unknown) => void): void; // recognition failed and stays down for the rest of the stream
  stop(): Promise<void>;
}

export interface SttAdapter {
  audio: boolean; // false for the text adapter, which reads pushed bytes as UTF-8 text, not PCM
  start(sessionId: string): SttStream;
}

export type TtsFrame = Buffer | string;

export interface TtsAdapter {
  synthesize(text: string): AsyncIterable<TtsFrame>;
}
