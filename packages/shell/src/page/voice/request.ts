// Asking for a voice note from anywhere (the editor's "Voice note"), answered by the recorder
// drawn once inside the frame (`VoiceDialogs`), as the database dialogs are: with no frame
// listening, or a browser that cannot record, a request answers null at once.
import type { EditorHost } from '@cgw/editor';
import { canRecordAudio } from './recording';

export type VoiceRequest = { answer: (file: File | null) => void };

export const voiceRequests = new EventTarget();
let listening = 0;

/** Counts a frame listening for requests; the function it returns stops counting it. */
export function listenForVoice(take: (request: VoiceRequest) => void): () => void {
  const onRequest = (event: Event) => take((event as CustomEvent<VoiceRequest>).detail);
  voiceRequests.addEventListener('request', onRequest);
  listening++;
  return () => {
    listening--;
    voiceRequests.removeEventListener('request', onRequest);
  };
}

/** Records a voice note; null when cancelled or nothing could be recorded. */
export function requestVoiceNote(): Promise<File | null> {
  if (!listening) return Promise.resolve(null);
  return new Promise((resolve) => {
    voiceRequests.dispatchEvent(new CustomEvent('request', { detail: { answer: resolve } }));
  });
}

/** The editor's voice host, where this browser can record (else none: no "Voice note"). */
export function voiceHost(): EditorHost['voice'] {
  return canRecordAudio(globalThis as Parameters<typeof canRecordAudio>[0])
    ? { record: requestVoiceNote }
    : undefined;
}
