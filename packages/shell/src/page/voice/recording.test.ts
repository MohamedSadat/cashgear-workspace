import { describe, expect, it, vi } from 'vitest';
import {
  elapsedText,
  keptType,
  MAX_RECORDING_MS,
  microphoneProblem,
  recordingType,
  voiceFileName,
} from './recording';
import { listenForVoice, requestVoiceNote, voiceHost } from './request';

describe("a voice note's recording", () => {
  it('records Opus in WebM where it can, else MP4 (Safari), else Opus in Ogg, else what the browser chooses', () => {
    expect(recordingType(() => true)).toBe('audio/webm;codecs=opus');
    expect(recordingType((type) => type === 'audio/mp4')).toBe('audio/mp4');
    expect(recordingType((type) => type.startsWith('audio/ogg'))).toBe('audio/ogg;codecs=opus');
    expect(recordingType(() => false)).toBeUndefined();
    expect(
      recordingType(() => {
        throw new Error('no');
      }),
    ).toBeUndefined();
  });

  it('keeps only the types the server takes, without their parameters', () => {
    expect(keptType('audio/webm;codecs=opus')).toBe('audio/webm');
    expect(keptType('Audio/MP4; codecs="mp4a.40.2"')).toBe('audio/mp4');
    expect(keptType('audio/ogg')).toBe('audio/ogg');
    expect(keptType('video/webm')).toBeNull();
    expect(keptType('')).toBeNull();
  });

  it('names the file by its local date and time and its type', () => {
    const at = new Date(2026, 10, 27, 9, 5);
    expect(voiceFileName('Voice note', at, 'audio/webm')).toBe('Voice note 2026-11-27 09.05.webm');
    expect(voiceFileName('ملاحظة صوتية', at, 'audio/mp4')).toBe(
      'ملاحظة صوتية 2026-11-27 09.05.m4a',
    );
    expect(voiceFileName('Voice note', at, 'audio/ogg;codecs=opus')).toBe(
      'Voice note 2026-11-27 09.05.ogg',
    );
  });

  it('stops at 15 minutes, and shows the time as minutes and seconds', () => {
    expect(MAX_RECORDING_MS).toBe(900_000);
    expect(elapsedText(0)).toBe('0:00');
    expect(elapsedText(247_900)).toBe('4:07');
    expect(elapsedText(MAX_RECORDING_MS)).toBe('15:00');
    expect(elapsedText(-5)).toBe('0:00');
  });

  it('is offered only with a microphone API and MediaRecorder', () => {
    vi.stubGlobal('MediaRecorder', undefined);
    expect(voiceHost()).toBeUndefined();
    vi.stubGlobal('MediaRecorder', class {});
    vi.stubGlobal('navigator', { mediaDevices: undefined });
    expect(voiceHost()).toBeUndefined();
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: () => {} } });
    expect(voiceHost()?.record).toBe(requestVoiceNote);
    vi.unstubAllGlobals();
  });

  it('answers null at once with no recorder listening, else the recorder answers', async () => {
    expect(await requestVoiceNote()).toBeNull();
    const file = new File(['x'], 'Voice note.webm', { type: 'audio/webm' });
    const stop = listenForVoice((answer) => answer(file));
    expect(await requestVoiceNote()).toBe(file);
    stop();
    expect(await requestVoiceNote()).toBeNull();
  });

  it('says why the microphone could not be had', () => {
    expect(microphoneProblem(new DOMException('x', 'NotAllowedError'))).toBe('denied');
    expect(microphoneProblem(new DOMException('x', 'SecurityError'))).toBe('denied');
    expect(microphoneProblem(new DOMException('x', 'NotFoundError'))).toBe('none');
    expect(microphoneProblem(new DOMException('x', 'NotReadableError'))).toBe('failed');
    expect(microphoneProblem(null)).toBe('failed');
  });
});
