// The voice note's recorder (after 0.19.0): Record asks for the microphone, Stop ends it (or the
// limit does), and the recording plays back before Insert gives it to the editor as an audio
// file, stored as any other file. Nothing is kept until Insert; the microphone is let go as soon
// as recording stops, and when the dialog closes.
import { CgButton } from '@cashgear/ui';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Dialog } from '../../Dialog';
import { useSection } from '../../i18n/sections';
import {
  elapsedText,
  keptType,
  MAX_RECORDING_MS,
  microphoneProblem,
  recordingType,
  voiceFileName,
} from './recording';
import { voiceWords } from './words';

type State =
  | { kind: 'ready' }
  | { kind: 'asking' }
  | { kind: 'recording'; started: number }
  | { kind: 'recorded'; file: File; url: string }
  | { kind: 'problem'; problem: 'denied' | 'none' | 'failed' | 'empty' };

/** What is live while recording: let go together. */
interface Live {
  stream: MediaStream;
  recorder: MediaRecorder;
  audio: AudioContext | null;
  frame: number;
  limit: ReturnType<typeof setTimeout>;
}

export function VoiceRecorder({ onDone }: { onDone: (file: File | null) => void }) {
  useSection(voiceWords);
  const { t, i18n } = useTranslation();
  const [state, setState] = useState<State>({ kind: 'ready' });
  const [now, setNow] = useState(0);
  const live = useRef<Live | null>(null);
  const meter = useRef<HTMLSpanElement>(null);
  const preview = useRef<string | null>(null);
  const closed = useRef(false);

  const letGo = () => {
    const held = live.current;
    live.current = null;
    if (!held) return;
    cancelAnimationFrame(held.frame);
    clearTimeout(held.limit);
    for (const track of held.stream.getTracks()) track.stop();
    void held.audio?.close().catch(() => {});
  };

  const forgetPreview = () => {
    if (preview.current) URL.revokeObjectURL(preview.current);
    preview.current = null;
  };

  useEffect(
    () => () => {
      closed.current = true;
      const held = live.current;
      if (held && held.recorder.state !== 'inactive') {
        held.recorder.ondataavailable = null;
        held.recorder.onstop = null;
        held.recorder.stop();
      }
      letGo();
      forgetPreview();
    },
    [],
  );

  // The elapsed time, a few times a second while recording.
  useEffect(() => {
    if (state.kind !== 'recording') return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, [state.kind]);

  const record = async () => {
    forgetPreview();
    setState({ kind: 'asking' });
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (error) {
      if (!closed.current) setState({ kind: 'problem', problem: microphoneProblem(error) });
      return;
    }
    if (closed.current) {
      for (const track of stream.getTracks()) track.stop();
      return;
    }
    let recorder: MediaRecorder;
    try {
      const mimeType = recordingType((type) => MediaRecorder.isTypeSupported(type));
      recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    } catch {
      for (const track of stream.getTracks()) track.stop();
      setState({ kind: 'problem', problem: 'failed' });
      return;
    }
    const chunks: Blob[] = [];
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) chunks.push(event.data);
    };
    recorder.onstop = () => {
      letGo();
      if (closed.current) return;
      const type = keptType(recorder.mimeType || chunks[0]?.type || '');
      const blob = new Blob(chunks, { type: type ?? '' });
      if (!type || blob.size === 0) {
        setState({ kind: 'problem', problem: type ? 'empty' : 'failed' });
        return;
      }
      const file = new File([blob], voiceFileName(t('voice.fileName'), new Date(), type), {
        type,
      });
      const url = URL.createObjectURL(file);
      preview.current = url;
      setState({ kind: 'recorded', file, url });
    };
    // The input's level, drawn as a bar: only a sign that the microphone hears something.
    let audio: AudioContext | null = null;
    let frame = 0;
    try {
      audio = new AudioContext();
      const analyser = audio.createAnalyser();
      analyser.fftSize = 512;
      audio.createMediaStreamSource(stream).connect(analyser);
      const samples = new Uint8Array(analyser.fftSize);
      const draw = () => {
        analyser.getByteTimeDomainData(samples);
        let peak = 0;
        for (const sample of samples) peak = Math.max(peak, Math.abs(sample - 128));
        meter.current?.style.setProperty('--cgw-voice-level', String(Math.min(1, peak / 64)));
        frame = requestAnimationFrame(draw);
        if (live.current) live.current.frame = frame;
      };
      frame = requestAnimationFrame(draw);
    } catch {
      // No level drawn: the recording goes on without it.
      void audio?.close().catch(() => {});
      audio = null;
    }
    const limit = setTimeout(() => {
      if (recorder.state !== 'inactive') recorder.stop();
    }, MAX_RECORDING_MS);
    live.current = { stream, recorder, audio, frame, limit };
    recorder.start(1000);
    setState({ kind: 'recording', started: Date.now() });
  };

  const stop = () => {
    const held = live.current;
    if (held && held.recorder.state !== 'inactive') held.recorder.stop();
  };

  const minutes = new Intl.NumberFormat(i18n.language).format(MAX_RECORDING_MS / 60000);
  const message =
    state.kind === 'problem'
      ? t(`voice.${state.problem}`)
      : state.kind === 'asking'
        ? t('voice.asking')
        : state.kind === 'recorded'
          ? t('voice.recorded')
          : state.kind === 'recording'
            ? t('voice.recording')
            : t('voice.ready');

  return (
    <Dialog title={t('voice.title')} onClose={() => onDone(null)}>
      <div className="cgw-voice" data-state={state.kind}>
        <p role="status" className={state.kind === 'problem' ? 'cgw-voice-problem' : undefined}>
          {message}
        </p>
        {state.kind === 'recording' && (
          <div className="cgw-voice-live">
            <span className="cgw-voice-dot" aria-hidden="true" />
            <span role="timer" className="cgw-voice-time" dir="ltr">
              {elapsedText(now - state.started)}
            </span>
            <span ref={meter} className="cgw-voice-meter" aria-hidden="true" />
          </div>
        )}
        {state.kind === 'recorded' && (
          <audio
            className="cgw-voice-preview"
            controls
            src={state.url}
            aria-label={t('voice.preview')}
          />
        )}
        <p className="cgw-voice-limit">{t('voice.limit', { minutes })}</p>
        <div className="cgw-dialog-buttons">
          <CgButton appearance="outline" onClick={() => onDone(null)}>
            {t('voice.cancel')}
          </CgButton>
          {state.kind === 'recording' ? (
            <CgButton intent="danger" icon="stop" onClick={stop}>
              {t('voice.stop')}
            </CgButton>
          ) : state.kind === 'recorded' ? (
            <>
              <CgButton appearance="outline" icon="record" onClick={() => void record()}>
                {t('voice.again')}
              </CgButton>
              <CgButton
                intent="primary"
                onClick={() => {
                  // The editor stores the file; the preview's address is no longer needed.
                  const file = state.file;
                  forgetPreview();
                  onDone(file);
                }}
              >
                {t('voice.insert')}
              </CgButton>
            </>
          ) : (
            <CgButton
              intent="primary"
              icon="mic"
              disabled={state.kind === 'asking'}
              onClick={() => void record()}
            >
              {t('voice.record')}
            </CgButton>
          )}
        </div>
      </div>
    </Dialog>
  );
}
