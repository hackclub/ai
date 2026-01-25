type ReplicateModelConfig = {
  id: string;
  costPerRequest: number;
};

export type ReplicateCategoryConfig = {
  name: string;
  models: ReplicateModelConfig[];
};

export const replicateCategories: ReplicateCategoryConfig[] = [
  {
    name: "Text to Speech",
    models: [
      { id: "minimax/speech-02-turbo", costPerRequest: 0.0045 },
      { id: "resemble-ai/chatterbox-pro", costPerRequest: 0.07 },
      { id: "zsxkib/dia", costPerRequest: 0.069 },
      { id: "lucataco/xtts-v2", costPerRequest: 0.053 },
      { id: "qwen/qwen3-tts", costPerRequest: 0.06 },
    ],
  },
  {
    name: "Speech to Text",
    models: [
      { id: "vaibhavs10/incredibly-fast-whisper", costPerRequest: 0.02 },
      { id: "nvidia/parakeet-rnnt-1.1b", costPerRequest: 0.02 },
    ],
  },
  {
    name: "OCR",
    models: [
      { id: "cuuupid/glm-4v-9b", costPerRequest: 0.13 },
      {
        id: "lucataco/deepseek-ocr",
        costPerRequest: 0.0063,
      },
      { id: "abiruyt/text-extract-ocr", costPerRequest: 0.0019 },
    ],
  },
  {
    name: "Image Upscaling",
    models: [
      { id: "fermatresearch/magic-image-refiner", costPerRequest: 0.029 },
      { id: "recraft-ai/recraft-crisp-upscale", costPerRequest: 0.006 },
      { id: "google/upscaler", costPerRequest: 0.01 },
    ],
  },
  {
    name: "Image Utilities",
    models: [
      { id: "lucataco/remove-bg", costPerRequest: 0.00028 },
      { id: "851-labs/background-remover", costPerRequest: 0.00052 },
      { id: "zsxkib/ic-light-background", costPerRequest: 0.029 },
      { id: "arielreplicate/robust_video_matting", costPerRequest: 0.046 },
      { id: "lucataco/rembg-video", costPerRequest: 0.1 },
      { id: "falcons-ai/nsfw_image_detection", costPerRequest: 0.0003 },
    ],
  },
  {
    name: "Music Generation",
    models: [
      { id: "google/lyria-2", costPerRequest: 0.12 },
      { id: "meta/musicgen", costPerRequest: 0.076 },
      { id: "minimax/music-1.5", costPerRequest: 0.03 },
    ],
  },
];

export const replicateModelCosts = new Map(
  replicateCategories.flatMap((cat) =>
    cat.models.map((m) => [m.id, m.costPerRequest]),
  ),
);

export const allowedReplicateModels = replicateCategories.flatMap((cat) =>
  cat.models.map((m) => m.id),
);
