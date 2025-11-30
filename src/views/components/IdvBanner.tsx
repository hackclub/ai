import { Button } from "./Button";
import { Warning } from "./Icons";

export const IdvBanner = () => {
  return (
    <div class="bg-red-100 border-l-4 border-red-500 mx-4 mt-4">
      <div class="max-w-7xl mx-auto px-4 py-4">
        <div class="flex items-center gap-4">
          <Warning class="w-6 h-6 text-red-500 flex-shrink-0" aria-hidden />
          <div class="flex-1">
            <h3 class="text-sm font-semibold text-red-800">
              Identity Verification Required
            </h3>
            <p class="text-sm text-red-700 mt-1">
              You must verify your identity to use the API. API requests are
              currently blocked. Once you're done, sign out and sign back in.
            </p>
          </div>
          <a
            href="https://account.hackclub.com"
            target="_blank"
            rel="noopener noreferrer"
            class="flex-shrink-0"
          >
            <Button variant="danger" class="flex items-center gap-2">
              <Warning class="w-4 h-4" aria-hidden />
              Verify Identity
            </Button>
          </a>
        </div>
      </div>
    </div>
  );
};
