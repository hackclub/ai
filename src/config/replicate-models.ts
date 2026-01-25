export type ReplicateModelConfig = {
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
      { id: "zsxkib/ic-light-background", costPerRequest: 0.029 },
      { id: "arielreplicate/robust_video_matting", costPerRequest: 0.046 },
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
