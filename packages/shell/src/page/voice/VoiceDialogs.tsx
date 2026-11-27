// The recorder, drawn when the editor asks for a voice note: mounted with an open page
// (`PageView`, never on the first screen), the recorder itself loaded only when asked.
import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { listenForVoice, type VoiceRequest } from './request';

const VoiceRecorder = lazy(() =>
  import('./VoiceRecorder').then((m) => ({ default: m.VoiceRecorder })),
);

export function VoiceDialogs() {
  const [request, setRequest] = useState<VoiceRequest | null>(null);
  const current = useRef<VoiceRequest | null>(null);
  useEffect(() => {
    const stop = listenForVoice((next) => {
      // One at a time: an earlier one still open is cancelled.
      current.current?.(null);
      current.current = next;
      setRequest(() => next);
    });
    return () => {
      stop();
      current.current?.(null);
    };
  }, []);
  if (!request) return null;
  return (
    <Suspense fallback={null}>
      <VoiceRecorder
        onDone={(file) => {
          current.current = null;
          setRequest(null);
          request(file);
        }}
      />
    </Suspense>
  );
}
