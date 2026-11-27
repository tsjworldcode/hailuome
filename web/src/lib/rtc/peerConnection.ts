import {
  applyOutgoingSdpPrivacy,
  loadRtcIceConfig,
  resolveRtcPeerConnectionConfig,
} from './iceServers';

/** 等 ICE gathering 完成后再发 SDP，减少 trickle 信令条数（MVP）。 */
export function waitIceGatheringComplete(
  pc: RTCPeerConnection,
  timeoutMs = 8_000,
): Promise<void> {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      pc.removeEventListener('icegatheringstatechange', onChange);
      window.clearTimeout(timer);
      resolve();
    };
    const onChange = () => {
      if (pc.iceGatheringState === 'complete') done();
    };
    const timer = window.setTimeout(done, timeoutMs);
    pc.addEventListener('icegatheringstatechange', onChange);
  });
}

export function createVoicePeerConnection(handlers: {
  onRemoteStream: (stream: MediaStream) => void;
  onConnectionState?: (state: RTCPeerConnectionState) => void;
}): RTCPeerConnection {
  const pc = new RTCPeerConnection(resolveRtcPeerConnectionConfig());
  pc.ontrack = (ev) => {
    const stream = ev.streams[0] ?? new MediaStream([ev.track]);
    handlers.onRemoteStream(stream);
  };
  pc.onconnectionstatechange = () => {
    handlers.onConnectionState?.(pc.connectionState);
  };
  return pc;
}

export async function attachLocalAudio(
  pc: RTCPeerConnection,
): Promise<MediaStream> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: true,
    video: false,
  });
  for (const track of stream.getAudioTracks()) {
    pc.addTrack(track, stream);
  }
  return stream;
}

export async function createCompleteOffer(
  pc: RTCPeerConnection,
): Promise<RTCSessionDescriptionInit> {
  const offer = await pc.createOffer({ offerToReceiveAudio: true });
  await pc.setLocalDescription(offer);
  await waitIceGatheringComplete(pc);
  const local = pc.localDescription;
  if (!local?.sdp) throw new Error('无法生成本地 offer');
  // M-RTC-1b：发出前去掉 host（配置允许时）
  return applyOutgoingSdpPrivacy(
    { type: local.type, sdp: local.sdp },
    loadRtcIceConfig(),
  );
}

export async function createCompleteAnswer(
  pc: RTCPeerConnection,
): Promise<RTCSessionDescriptionInit> {
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  await waitIceGatheringComplete(pc);
  const local = pc.localDescription;
  if (!local?.sdp) throw new Error('无法生成本地 answer');
  return applyOutgoingSdpPrivacy(
    { type: local.type, sdp: local.sdp },
    loadRtcIceConfig(),
  );
}

export function setMuted(stream: MediaStream | null, muted: boolean): void {
  if (!stream) return;
  for (const track of stream.getAudioTracks()) {
    track.enabled = !muted;
  }
}

export function stopMediaStream(stream: MediaStream | null): void {
  if (!stream) return;
  for (const track of stream.getTracks()) {
    track.stop();
  }
}
