type ReplicateModelConfig = {
  id: string;
};

export type ReplicateCategoryConfig = {
  name: string;
  models: ReplicateModelConfig[];
};

export const replicateCategories: ReplicateCategoryConfig[] = [
  {
    name: "Text to Speech",
    models: [
      { id: "minimax/speech-02-turbo" },
      { id: "minimax/speech-2.8-turbo" },
      { id: "minimax/speech-2.8-hd" },
      { id: "resemble-ai/chatterbox-pro" },
      { id: "zsxkib/dia" },
      { id: "lucataco/xtts-v2" },
      { id: "qwen/qwen3-tts" },
      { id: "inworld/tts-1.5-mini" },
      { id: "inworld/tts-1.5-max" },
      { id: "inworld/realtime-tts-1.5-mini" },
      { id: "inworld/realtime-tts-1.5-max" },
    ],
  },
  {
    name: "Speech to Text",
    models: [
      { id: "vaibhavs10/incredibly-fast-whisper" },
      { id: "nvidia/parakeet-rnnt-1.1b" },
    ],
  },
  {
    name: "OCR",
    models: [
      { id: "cuuupid/glm-4v-9b" },
      { id: "lucataco/deepseek-ocr" },
      { id: "abiruyt/text-extract-ocr" },
    ],
  },
  {
    name: "Image Upscaling",
    models: [
      { id: "fermatresearch/magic-image-refiner" },
      { id: "recraft-ai/recraft-crisp-upscale" },
      { id: "google/upscaler" },
    ],
  },
  {
    name: "Image Utilities",
    models: [
      { id: "lucataco/remove-bg" },
      { id: "851-labs/background-remover" },
      { id: "zsxkib/ic-light-background" },
      { id: "arielreplicate/robust_video_matting" },
      { id: "lucataco/rembg-video" },
      { id: "falcons-ai/nsfw_image_detection" },
    ],
  },
  {
    name: "Music Generation",
    models: [
      { id: "google/lyria-2" },
      { id: "meta/musicgen" },
      { id: "minimax/music-1.5" },
    ],
  },
  {
    name: "Specialized Image Models",
    models: [{ id: "retro-diffusion/rd-plus" }],
  },
  {
    name: "Audio",
    models: [
      { id: "geopti/sam-audio-large" },
      { id: "minimax/voice-cloning" },
    ],
  },
];

export const allowedReplicateModels = replicateCategories.flatMap((cat) =>
  cat.models.map((m) => m.id),
);
