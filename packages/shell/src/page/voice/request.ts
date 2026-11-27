// Asking for a voice note (the editor's "Voice note"), answered by the recorder an open page draws
// (`VoiceDialogs`), as the database dialogs are: with nothing listening, or a browser that cannot
// record, a request answers null at once.
import type { EditorHost } from '@cgw/editor';

export type VoiceRequest = (file: File | null) => void;

let take: ((answer: VoiceRequest) => void) | null = null;

/** The frame's recorder listens; the function it returns stops it. */
export function listenForVoice(listener: (answer: VoiceRequest) => void): () => void {
  take = listener;
  return () => {
    if (take === listener) take = null;
  };
}

/** Records a voice note; null when cancelled or nothing could be recorded. */
export const requestVoiceNote = (): Promise<File | null> =>
  new Promise((answer) => (take ? take(answer) : answer(null)));

/** The editor's voice host, where this browser can record (else none: no "Voice note"). */
export const voiceHost = (): EditorHost['voice'] =>
  typeof MediaRecorder === 'function' && typeof navigator.mediaDevices?.getUserMedia === 'function'
    ? { record: requestVoiceNote }
    : undefined;
