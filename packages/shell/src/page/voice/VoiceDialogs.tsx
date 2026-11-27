// The recorder, drawn once inside the frame when the editor asks for a voice note: its screen is
// loaded then (`VoiceRecorder`), never with the app.
import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { listenForVoice, type VoiceRequest } from './request';

const VoiceRecorder = lazy(() =>
  import('./VoiceRecorder').then((m) => ({ default: m.VoiceRecorder })),
);

export function VoiceDialogs() {
  const [request, setRequest] = useState<VoiceRequest | null>(null);
  const current = useRef<VoiceRequest | null>(null);
  useEffect(
    () =>
      listenForVoice((next) => {
        // One at a time: an earlier one still open is cancelled.
        current.current?.answer(null);
        current.current = next;
        setRequest(next);
      }),
    [],
  );
  useEffect(() => () => current.current?.answer(null), []);
  if (!request) return null;
  return (
    <Suspense fallback={null}>
      <VoiceRecorder
        onDone={(file) => {
          current.current = null;
          setRequest(null);
          request.answer(file);
        }}
      />
    </Suspense>
  );
}
