type ReplicateModelConfig = {
  id: string;
  costPerRequestUsd: string;
};

export type ReplicateCategoryConfig = {
  name: string;
  models: ReplicateModelConfig[];
};

export const replicateCategories: ReplicateCategoryConfig[] = [
  {
    name: "Text to Speech",
    models: [
      { id: "minimax/speech-02-turbo", costPerRequestUsd: "0.0045" },
      { id: "minimax/speech-2.8-turbo", costPerRequestUsd: "0.04" },
      { id: "minimax/speech-2.8-hd", costPerRequestUsd: "0.08" },
      { id: "resemble-ai/chatterbox-pro", costPerRequestUsd: "0.07" },
      { id: "zsxkib/dia", costPerRequestUsd: "0.069" },
      { id: "lucataco/xtts-v2", costPerRequestUsd: "0.053" },
      { id: "qwen/qwen3-tts", costPerRequestUsd: "0.06" },
      { id: "inworld/tts-1.5-mini", costPerRequestUsd: "0.0175" },
      { id: "inworld/tts-1.5-max", costPerRequestUsd: "0.035" },
      { id: "inworld/realtime-tts-1.5-mini", costPerRequestUsd: "0.0525" }, // assuming 3500 chars (~500 words)
      { id: "inworld/realtime-tts-1.5-max", costPerRequestUsd: "0.1225" }, // assuming 3500 chars (~500 words)
    ],
  },
  {
    name: "Speech to Text",
    models: [
      { id: "vaibhavs10/incredibly-fast-whisper", costPerRequestUsd: "0.02" },
      { id: "nvidia/parakeet-rnnt-1.1b", costPerRequestUsd: "0.02" },
    ],
  },
  {
    name: "OCR",
    models: [
      { id: "cuuupid/glm-4v-9b", costPerRequestUsd: "0.13" },
      {
        id: "lucataco/deepseek-ocr",
        costPerRequestUsd: "0.0063",
      },
      { id: "abiruyt/text-extract-ocr", costPerRequestUsd: "0.0019" },
    ],
  },
  {
    name: "Image Upscaling",
    models: [
      { id: "fermatresearch/magic-image-refiner", costPerRequestUsd: "0.029" },
      { id: "recraft-ai/recraft-crisp-upscale", costPerRequestUsd: "0.006" },
      { id: "google/upscaler", costPerRequestUsd: "0.01" },
    ],
  },
  {
    name: "Image Utilities",
    models: [
      { id: "lucataco/remove-bg", costPerRequestUsd: "0.00028" },
      { id: "851-labs/background-remover", costPerRequestUsd: "0.00052" },
      { id: "zsxkib/ic-light-background", costPerRequestUsd: "0.029" },
      { id: "arielreplicate/robust_video_matting", costPerRequestUsd: "0.046" },
      { id: "lucataco/rembg-video", costPerRequestUsd: "0.1" },
      { id: "falcons-ai/nsfw_image_detection", costPerRequestUsd: "0.0003" },
    ],
  },
  {
    name: "Music Generation",
    models: [
      { id: "google/lyria-2", costPerRequestUsd: "0.12" },
      { id: "meta/musicgen", costPerRequestUsd: "0.076" },
      { id: "minimax/music-1.5", costPerRequestUsd: "0.03" },
    ],
  },
  {
    name: "Specialized Image Models",
    models: [{ id: "retro-diffusion/rd-plus", costPerRequestUsd: "0.06" }],
  },
  {
    name: "Audio",
    models: [
      { id: "geopti/sam-audio-large", costPerRequestUsd: "0.07" },
      { id: "minimax/voice-cloning", costPerRequestUsd: "3.0" },
    ],
  },
];

export const replicateModelCosts = new Map<string, string>(
  replicateCategories.flatMap((cat) =>
    cat.models.map((m) => [m.id, m.costPerRequestUsd]),
  ),
);

export const allowedReplicateModels = replicateCategories.flatMap((cat) =>
  cat.models.map((m) => m.id),
);
