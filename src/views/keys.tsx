import { allowedLanguageModels, env } from "../env";
import type { DashboardApiKey, User } from "../types";
import { EmptyState } from "./components/EmptyState";
import { Header } from "./components/Header";
import { Modal, ModalActions, ModalButton } from "./components/Modal";
import { Table } from "./components/Table";
import { Layout } from "./layout";

type KeysProps = {
  user: User;
  apiKeys: DashboardApiKey[];
};

export const Keys = ({ user, apiKeys }: KeysProps) => {
  return (
    <Layout title="API Keys" includeHtmx includeAlpine user={user}>
      <div
        x-data={`{
          createModal: false,
          createdModal: false,
          revokeModal: false,
          newKey: '',
          keyName: '',
          revokeKeyId: '',
          revokeKeyName: '',
          
          async createKey() {
            const res = await fetch('/api/keys', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ name: this.keyName })
            });
            if (res.ok) {
              const data = await res.json();
              this.newKey = data.key;
              this.keyName = '';
              this.createModal = false;
              this.createdModal = true;
              htmx.trigger('#api-keys-list', 'refresh');
            }
          },
          
          async revokeKey() {
            const res = await fetch('/api/keys/' + this.revokeKeyId, { method: 'DELETE' });
            if (res.ok) {
              this.revokeModal = false;
              htmx.trigger('#api-keys-list', 'refresh');
            }
          }
        }`}
      >
        <Header title="hackai" user={user} />

        <div class="w-full max-w-6xl mx-auto px-4 py-8">
          <div class="mb-12">
            <div class="flex justify-between items-center mb-6">
              <h2 class="text-2xl font-bold text-brand-heading">API Keys</h2>
              <button
                type="button"
                x-on:click="createModal = true"
                class="px-6 py-2.5 text-sm font-medium rounded-full bg-brand-primary text-white hover:bg-brand-primary-hover hover:tracking-wider transition-all"
              >
                Create New Key
              </button>
            </div>
            <div
              id="api-keys-list"
              hx-get="/api/keys/partial"
              hx-trigger="refresh"
              hx-swap="innerHTML"
            >
              <ApiKeysList apiKeys={apiKeys} />
            </div>
          </div>
        </div>

        <CreateKeyModal />
        <CreatedModal />
        <RevokeKeyModal />
      </div>
    </Layout>
  );
};

export const ApiKeysList = ({ apiKeys }: { apiKeys: DashboardApiKey[] }) => {
  if (apiKeys.length === 0) {
    return <EmptyState message="No API keys yet. Create one to get started." />;
  }

  return (
    <Table
      columns={[
        { header: "Name", key: "name" },
        {
          header: "Key",
          render: (row) => (
            <code class="bg-brand-bg px-2 py-1 rounded-lg text-xs font-mono text-brand-heading border border-brand-border">
              {row.keyPreview}
            </code>
          ),
        },
        {
          header: "Created",
          render: (row) => new Date(row.createdAt).toLocaleDateString(),
        },
        {
          header: "Actions",
          render: (row) => (
            <button
              type="button"
              x-on:click={`revokeKeyId = '${row.id}'; revokeKeyName = '${row.name}'; revokeModal = true`}
              class="px-3 py-2 text-xs font-medium rounded-full bg-transparent text-red-500 border-2 border-red-500/30 hover:bg-red-500/10 transition-all"
            >
              Revoke
            </button>
          ),
        },
      ]}
      data={apiKeys}
    />
  );
};

const CreateKeyModal = () => (
  <Modal name="createModal" title="Create New API Key" class="select-none">
    <div class="mb-6">
      <label
        class="block text-sm font-bold text-brand-heading mb-2"
        for="keyName"
      >
        Key Name
      </label>
      <input
        type="text"
        id="keyName"
        x-model="keyName"
        class="w-full px-4 py-3 rounded-xl border-2 border-brand-border bg-brand-bg/50 focus:border-brand-primary outline-none transition-colors font-medium text-brand-text"
        placeholder="e.g. My Project"
      />
    </div>
    <ModalActions>
      <ModalButton variant="secondary" close="createModal">
        Cancel
      </ModalButton>
      <ModalButton variant="primary" onClick="createKey()">
        Create
      </ModalButton>
    </ModalActions>
  </Modal>
);

const CreatedModal = () => (
  <Modal name="createdModal" title="API Key Created" class="select-none">
    <p class="mb-6 text-brand-text">
      Save this key now. You won't see it again.{" "}
      <b>Don't share it or commit it to a public repo!</b>
    </p>
    <div
      class="bg-brand-bg border-2 border-brand-border p-4 mb-6 rounded-xl font-mono text-sm break-all text-brand-primary font-bold select-text"
      x-text="newKey"
    />
    <p class="mb-3 text-sm font-bold text-brand-heading">Example usage:</p>
    <div class="bg-brand-bg border-2 border-brand-border p-4 mb-6 rounded-xl font-mono text-xs text-brand-text leading-relaxed overflow-x-auto select-text">
      <div>curl {env.BASE_URL}/proxy/v1/chat/completions \</div>
      <div class="pl-4">
        -H "Authorization: Bearer{" "}
        <span class="text-brand-primary" x-text="newKey" />" \
      </div>
      <div class="pl-4">-H "Content-Type: application/json" \</div>
      <div class="pl-4">
        -d '{`{"model": "`}
        <span class="text-brand-primary">{allowedLanguageModels[0]}</span>
        {`", "messages": [{"role": "user", "content": "Hi"}]}`}'
      </div>
    </div>
    <ModalActions>
      <ModalButton variant="primary" close="createdModal">
        Done
      </ModalButton>
    </ModalActions>
  </Modal>
);

const RevokeKeyModal = () => (
  <Modal name="revokeModal" title="Revoke API Key" class="select-none">
    <p class="mb-6 text-brand-text">
      Revoke <strong x-text="revokeKeyName" class="text-brand-heading" />? This
      can't be undone.
    </p>
    <ModalActions>
      <ModalButton variant="secondary" close="revokeModal">
        Cancel
      </ModalButton>
      <ModalButton variant="primary" onClick="revokeKey()">
        Revoke Key
      </ModalButton>
    </ModalActions>
  </Modal>
);
