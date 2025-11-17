import { Button } from "./Button";

export const IdvBanner = () => {
  return (
    <div class="bg-red-50 dark:bg-red-900/20 border-l-4 border-red-500 mx-4 mt-4">
      <div class="max-w-6xl mx-auto px-4 py-4">
        <div class="flex items-center gap-4">
          <svg
            class="w-6 h-6 text-red-500 flex-shrink-0"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              stroke-width="2"
              d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
            ></path>
          </svg>
          <div class="flex-1">
            <h3 class="text-sm font-semibold text-red-800 dark:text-red-200">
              Identity Verification Required
            </h3>
            <p class="text-sm text-red-700 dark:text-red-300 mt-1">
              You must verify your identity to use the API. API requests are currently blocked. Once you're done, sign out and sign back in.
            </p>
          </div>
          <a
            href="https://identity.hackclub.com"
            target="_blank"
            rel="noopener noreferrer"
            class="flex-shrink-0"
          >
            <Button variant="danger" class="flex items-center gap-2">
              <svg
                class="w-4 h-4"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  stroke-width="2"
                  d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
                ></path>
              </svg>
              Verify Identity
            </Button>
          </a>
        </div>
      </div>
    </div>
  );
};
