// A voice note's recording (after 0.19.0, DECISIONS.md 2026-11-27): which type the browser
// records, the file it becomes, and how long it may run. No DOM here but what is passed in, so
// tests give their own.

/** The types tried in order: Opus in WebM (Chrome, Edge, Firefox), MP4 (Safari), Opus in Ogg. */
export const RECORDING_TYPES = [
  'audio/webm;codecs=opus',
  'audio/mp4',
  'audio/ogg;codecs=opus',
] as const;

/** A recording stops by itself after 15 minutes: about 2 MB of Opus, far under the asset limit. */
export const MAX_RECORDING_MS = 15 * 60 * 1000;

/** The first type the browser records, or undefined to let it choose its own. */
export function recordingType(isTypeSupported: (type: string) => boolean): string | undefined {
  return RECORDING_TYPES.find((type) => {
    try {
      return isTypeSupported(type);
    } catch {
      return false;
    }
  });
}

/** A type as the server keeps it: without its parameters (`;codecs=opus`), in lower case. */
export const plainType = (type: string) => type.split(';')[0].trim().toLowerCase();

const EXTENSIONS: Record<string, string> = {
  'audio/webm': 'webm',
  'audio/mp4': 'm4a',
  'audio/ogg': 'ogg',
};

/** The type the browser recorded in, when it is one the server keeps; else null. */
export function keptType(recorded: string): string | null {
  const type = plainType(recorded);
  return type in EXTENSIONS ? type : null;
}

const two = (value: number) => String(value).padStart(2, '0');

/** "Voice note 2026-11-27 14.05.webm": the name, the local date and time, the type's extension. */
export function voiceFileName(name: string, at: Date, type: string): string {
  const date = `${at.getFullYear()}-${two(at.getMonth() + 1)}-${two(at.getDate())}`;
  const time = `${two(at.getHours())}.${two(at.getMinutes())}`;
  return `${name} ${date} ${time}.${EXTENSIONS[plainType(type)] ?? 'webm'}`;
}

/** Elapsed time as minutes and seconds, "4:07". */
export function elapsedText(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(seconds / 60)}:${two(seconds % 60)}`;
}

/** Why a microphone could not be had, from getUserMedia's error. */
export function microphoneProblem(error: unknown): 'denied' | 'none' | 'failed' {
  const name = (error as { name?: string } | null)?.name;
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'denied';
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'none';
  return 'failed';
}
