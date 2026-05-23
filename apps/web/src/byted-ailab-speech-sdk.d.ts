declare module 'byted-ailab-speech-sdk' {
  export interface LabAsrClient {
    connect: (options: {
      url: string;
      config: unknown;
    }) => void;
    startRecord: () => Promise<void>;
    stopRecord: () => void;
  }

  export interface LabAsrOptions {
    onMessage?: (text: string, fullData: unknown) => void;
    onStart?: () => void;
    onClose?: () => void;
    onError?: () => void;
  }

  export function LabASR(options: LabAsrOptions): LabAsrClient;
}
