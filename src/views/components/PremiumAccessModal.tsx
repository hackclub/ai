import { Modal, ModalActions, ModalButton } from "./Modal";

type PremiumAccessModalProps = {
  modelId: string;
  modelName: string;
  donationAmount: string;
  donationUrl: string;
  reason: string;
};

export const PremiumAccessModal = ({
  modelId,
  modelName,
  donationAmount,
  donationUrl,
  reason,
}: PremiumAccessModalProps) => {
  return (
    <Modal name="premiumModal" title={`Access ${modelName}`}>
      <div class="mb-6">
        <div class="bg-amber-500/10 border border-amber-500/20 rounded-xl p-4 mb-4">
          <p class="text-amber-400 text-sm font-medium">
            Premium Model - Donation Required
          </p>
        </div>

        <p class="text-brand-text mb-4">{reason}</p>

        <div class="bg-brand-bg border-2 border-brand-border rounded-xl p-4">
          <div class="flex justify-between items-center">
            <span class="text-brand-text">Suggested donation:</span>
            <span class="text-2xl font-bold text-brand-primary">{donationAmount}</span>
          </div>
        </div>
      </div>

      <div class="mb-6 p-4 bg-brand-bg border-2 border-brand-border rounded-xl">
        <h4 class="font-bold text-brand-heading mb-2">How to get access:</h4>
        <ol class="list-decimal list-inside text-sm text-brand-text space-y-2">
          <li>Click "Request Access" below to get your reference code</li>
          <li>
            Donate at{" "}
            <a
              href={donationUrl}
              target="_blank"
              rel="noopener noreferrer"
              class="text-brand-primary hover:underline"
            >
              HCB
            </a>{" "}
            and include your reference code in the comments
          </li>
          <li>An admin will review and approve your access</li>
        </ol>
      </div>

      <p class="text-sm text-brand-text/70 mb-6">
        100% of donations go directly to Hack Club, a 501(c)(3) nonprofit.
      </p>

      <ModalActions>
        <ModalButton variant="secondary" close="premiumModal">
          Cancel
        </ModalButton>
        <ModalButton variant="primary" onClick={`requestAccess('${modelId}')`}>
          Request Access
        </ModalButton>
      </ModalActions>
    </Modal>
  );
};

export const PremiumRequestedModal = () => {
  return (
    <Modal name="requestedModal" title="Access Requested">
      <div class="mb-6">
        <div class="bg-green-500/10 border border-green-500/20 rounded-xl p-4 mb-4">
          <p class="text-green-400 text-sm font-medium">
            Request submitted successfully!
          </p>
        </div>

        <p class="text-brand-text mb-4">
          Your reference code is:
        </p>

        <div class="bg-brand-bg border-2 border-brand-border rounded-xl p-4 mb-4">
          <code
            class="text-xl font-mono font-bold text-amber-400"
            x-text="referenceCode"
          />
        </div>

        <p class="text-sm text-brand-text">
          Include this code in your donation comment at HCB. An admin will review
          and approve your access after verifying the donation.
        </p>
      </div>

      <div class="flex gap-3">
        <a
          x-bind:href="donationUrl"
          target="_blank"
          rel="noopener noreferrer"
          class="flex-1 px-5 py-2.5 text-sm font-medium text-center rounded-full bg-brand-primary text-white hover:bg-brand-primary-hover transition-all"
        >
          Donate Now
        </a>
        <ModalButton variant="secondary" close="requestedModal">
          Close
        </ModalButton>
      </div>
    </Modal>
  );
};
