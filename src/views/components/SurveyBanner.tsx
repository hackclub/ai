import { Button } from "./Button";
import { Clipboard } from "./Icons";

export const SurveyBanner = () => {
  return (
    <div class="bg-brand-primary/10 border-l-4 border-brand-primary mx-4 mt-4">
      <div class="max-w-7xl mx-auto px-4 py-4">
        <div class="flex items-center gap-4">
          <Clipboard
            class="w-6 h-6 text-brand-primary flex-shrink-0"
            aria-hidden
          />
          <div class="flex-1">
            <h3 class="text-sm font-semibold text-brand-heading">
              Help us improve HackAI!
            </h3>
            <p class="text-sm text-brand-text mt-1">
              Please take a moment to fill out our quick survey so we can see
              how useful the service is.
            </p>
          </div>
          <a
            href="https://forms.hackclub.com/ai"
            target="_blank"
            rel="noopener noreferrer"
            class="flex-shrink-0"
          >
            <Button variant="primary" class="flex items-center gap-2">
              Take Survey
            </Button>
          </a>
        </div>
      </div>
    </div>
  );
};
