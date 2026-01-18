import { Button } from "./Button";
import { Card } from "./Card";
import { Book } from "./Icons";

export const OnboardingBanner = () => {
  return (
    <div class="mx-auto max-w-6xl px-4 mt-8">
      <Card class="bg-gradient-to-r from-brand-primary/5 to-brand-primary/2 border-brand-primary/20">
        <div class="p-6 sm:p-8 flex flex-col md:flex-row items-center gap-6 text-center md:text-left">
          <div class="p-4 bg-white rounded-full border border-brand-primary/10 flex-shrink-0">
            <Book class="w-8 h-8 text-brand-primary" aria-hidden />
          </div>
          <div class="flex-1">
            <h3 class="text-xl font-bold text-brand-heading mb-2">
              Welcome to Hack Club AI!
            </h3>
            <p class="text-brand-text leading-relaxed max-w-2xl">
              It looks like you're new here. To get started with our API and
              learn how to integrate various models into your projects, as well
              as the
              <a
                href="https://docs.ai.hackclub.com/guide/rules.html"
                class="font-bold underline"
              >
                rules you need to follow (incl. not using coding agents)
              </a>
              , check out our comprehensive documentation.
            </p>
          </div>
          <a
            href="https://docs.ai.hackclub.com"
            target="_blank"
            rel="noopener noreferrer"
            class="flex-shrink-0"
          >
            <Button
              variant="primary"
              class="flex items-center gap-2 text-lg px-8 py-3"
            >
              Read the Docs
            </Button>
          </a>
        </div>
      </Card>
    </div>
  );
};
