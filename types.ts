
export interface SlideData {
  slideNumber: number;
  imageDataUrl: string | null;
  originalText: string;
  speakerNotes: string;
  sources?: { uri: string; title: string }[];
}

export enum ProcessingState {
  IDLE = 'idle',
  PARSING = 'parsing',
  GENERATING_NOTES = 'generating_notes',
  CREATING_PPT = 'creating_ppt',
  DONE = 'done',
  ERROR = 'error',
}
