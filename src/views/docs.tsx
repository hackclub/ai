import { Layout } from './layout';
import { Header } from './components/Header';
import { Sidebar } from './components/Sidebar';
import { Card } from './components/Card';
import { env } from '../env';

export const Docs = ({ user, allowedLanguageModels, allowedEmbeddingModels }: any) => {
  const exampleModel = allowedLanguageModels?.[0] || 'gpt-4';
  const exampleEmbeddingModel = allowedEmbeddingModels?.[0] || 'text-embedding-3-large';

  return (
    <Layout title="API Documentation">
      <Header title="API Docs" user={user} showBackToDashboard />
      <Sidebar currentPath="/docs" />

      <div class="ml-64">
        <div class="max-w-4xl mx-auto px-4 py-8 prose dark:prose-invert prose-sm sm:prose max-w-none">
        <h1 class="text-3xl font-bold mb-6">API Documentation</h1>
        <p class="text-lg text-gray-600 dark:text-gray-400 mb-8">
          This is a lightweight AI proxy providing access to language models and embeddings through an OpenAI-compatible API.
        </p>

        {/* Quick Start */}
        <section class="mb-12">
          <h2 class="text-2xl font-semibold mb-4 flex items-center gap-2">
            <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10V3L4 14h7v7l9-11h-7z"></path>
            </svg>
            Quick Start
          </h2>
          <Card class="p-6 mb-4">
            <h3 class="text-lg font-semibold mb-3">1. Get Your API Key</h3>
            <p class="text-gray-600 dark:text-gray-400 mb-3">
              Create an API key from your <a href="/dashboard" class="text-blue-600 dark:text-blue-400 hover:underline">dashboard</a>.
            </p>

            <h3 class="text-lg font-semibold mb-3 mt-6">2. Make Your First Request</h3>
            <div class="bg-gray-900 rounded-lg p-4 overflow-x-auto">
              <pre class="text-sm text-gray-100"><code>{`curl ${env.BASE_URL}/proxy/v1/chat/completions \\
  -H "Authorization: Bearer YOUR_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "${exampleModel}",
    "messages": [
      {"role": "user", "content": "Hello!"}
    ]
  }'`}</code></pre>
            </div>
          </Card>
        </section>

        {/* Authentication */}
        <section class="mb-12">
          <h2 class="text-2xl font-semibold mb-4 flex items-center gap-2">
            <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"></path>
            </svg>
            Authentication
          </h2>
          <Card class="p-6">
            <p class="text-gray-600 dark:text-gray-400 mb-3">
              All API requests require authentication using an API key in the Authorization header as a Bearer token:
            </p>
            <div class="bg-gray-900 rounded-lg p-4 overflow-x-auto">
              <pre class="text-sm text-gray-100"><code>Authorization: Bearer YOUR_API_KEY</code></pre>
            </div>
            <p class="text-gray-600 dark:text-gray-400 mt-3 text-sm">
              API keys can be created and managed from your dashboard. You can have up to 50 active API keys.
            </p>
          </Card>
        </section>

        {/* Endpoints */}
        <section class="mb-12">
          <h2 class="text-2xl font-semibold mb-4 flex items-center gap-2">
            <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"></path>
            </svg>
            API Endpoints
          </h2>

          {/* Chat Completions */}
          <Card class="p-6 mb-6">
            <h3 class="text-xl font-semibold mb-2">Chat Completions</h3>
            <div class="flex items-center gap-2 mb-4">
              <span class="bg-green-100 dark:bg-green-900 text-green-800 dark:text-green-300 px-2 py-1 rounded text-sm font-mono">POST</span>
              <code class="text-sm">/proxy/v1/chat/completions</code>
            </div>
            <p class="text-gray-600 dark:text-gray-400 mb-4">
              Create a chat completion for the given conversation. Supports streaming and non-streaming modes.
            </p>

            <h4 class="font-semibold mb-2">Request Body</h4>
            <div class="bg-gray-900 rounded-lg p-4 overflow-x-auto mb-4">
              <pre class="text-sm text-gray-100"><code>{`{
  "model": "string",              // Required: Model ID
  "messages": [                   // Required: Array of messages
    {
      "role": "user|assistant|system",
      "content": "string"
    }
  ],
  "stream": false,                // Optional: Enable streaming
  "temperature": 1.0,             // Optional: 0-2, controls randomness
  "max_tokens": null,             // Optional: Max tokens to generate
  "top_p": 1.0,                   // Optional: Nucleus sampling
  // ... other OpenAI-compatible parameters
}`}</code></pre>
            </div>

            <h4 class="font-semibold mb-2">Example Request</h4>
            <div class="bg-gray-900 rounded-lg p-4 overflow-x-auto mb-4">
              <pre class="text-sm text-gray-100"><code>{`curl ${env.BASE_URL}/proxy/v1/chat/completions \\
  -H "Authorization: Bearer YOUR_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "${exampleModel}",
    "messages": [
      {
        "role": "system",
        "content": "You are a helpful assistant."
      },
      {
        "role": "user",
        "content": "What is the capital of France?"
      }
    ],
    "temperature": 0.7
  }'`}</code></pre>
            </div>

            <h4 class="font-semibold mb-2">Example Response</h4>
            <div class="bg-gray-900 rounded-lg p-4 overflow-x-auto">
              <pre class="text-sm text-gray-100"><code>{`{
  "id": "chatcmpl-123",
  "object": "chat.completion",
  "created": 1677652288,
  "model": "${exampleModel}",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "The capital of France is Paris."
      },
      "finish_reason": "stop"
    }
  ],
  "usage": {
    "prompt_tokens": 20,
    "completion_tokens": 10,
    "total_tokens": 30
  }
}`}</code></pre>
            </div>

            <h4 class="font-semibold mb-2 mt-4">Streaming</h4>
            <p class="text-gray-600 dark:text-gray-400 mb-3">
              Set <code class="bg-gray-100 dark:bg-gray-800 px-1 rounded">stream: true</code> to receive Server-Sent Events (SSE) instead of a single response:
            </p>
            <div class="bg-gray-900 rounded-lg p-4 overflow-x-auto">
              <pre class="text-sm text-gray-100"><code>{`curl ${env.BASE_URL}/proxy/v1/chat/completions \\
  -H "Authorization: Bearer YOUR_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "${exampleModel}",
    "messages": [{"role": "user", "content": "Hello!"}],
    "stream": true
  }'`}</code></pre>
            </div>
          </Card>

          {/* Embeddings */}
          <Card class="p-6 mb-6">
            <h3 class="text-xl font-semibold mb-2">Embeddings</h3>
            <div class="flex items-center gap-2 mb-4">
              <span class="bg-green-100 dark:bg-green-900 text-green-800 dark:text-green-300 px-2 py-1 rounded text-sm font-mono">POST</span>
              <code class="text-sm">/proxy/v1/embeddings</code>
            </div>
            <p class="text-gray-600 dark:text-gray-400 mb-4">
              Generate vector embeddings from text input.
            </p>

            <h4 class="font-semibold mb-2">Request Body</h4>
            <div class="bg-gray-900 rounded-lg p-4 overflow-x-auto mb-4">
              <pre class="text-sm text-gray-100"><code>{`{
  "model": "string",              // Required: Embedding model ID
  "input": "string" | ["array"],  // Required: Text to embed
  "encoding_format": "float"      // Optional: "float" or "base64"
}`}</code></pre>
            </div>

            <h4 class="font-semibold mb-2">Example Request</h4>
            <div class="bg-gray-900 rounded-lg p-4 overflow-x-auto mb-4">
              <pre class="text-sm text-gray-100"><code>{`curl ${env.BASE_URL}/proxy/v1/embeddings \\
  -H "Authorization: Bearer YOUR_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "${exampleEmbeddingModel}",
    "input": "The quick brown fox jumps over the lazy dog"
  }'`}</code></pre>
            </div>

            <h4 class="font-semibold mb-2">Example Response</h4>
            <div class="bg-gray-900 rounded-lg p-4 overflow-x-auto">
              <pre class="text-sm text-gray-100"><code>{`{
  "object": "list",
  "data": [
    {
      "object": "embedding",
      "index": 0,
      "embedding": [0.023, -0.015, 0.042, ...]
    }
  ],
  "model": "${exampleEmbeddingModel}",
  "usage": {
    "prompt_tokens": 10,
    "total_tokens": 10
  }
}`}</code></pre>
            </div>
          </Card>

          {/* Models */}
          <Card class="p-6">
            <h3 class="text-xl font-semibold mb-2">List Models</h3>
            <div class="flex items-center gap-2 mb-4">
              <span class="bg-blue-100 dark:bg-blue-900 text-blue-800 dark:text-blue-300 px-2 py-1 rounded text-sm font-mono">GET</span>
              <code class="text-sm">/proxy/v1/models</code>
            </div>
            <p class="text-gray-600 dark:text-gray-400 mb-4">
              List all available models. No authentication required.
            </p>

            <h4 class="font-semibold mb-2">Example Request</h4>
            <div class="bg-gray-900 rounded-lg p-4 overflow-x-auto mb-4">
              <pre class="text-sm text-gray-100"><code>{`curl ${env.BASE_URL}/proxy/v1/models`}</code></pre>
            </div>

            <h4 class="font-semibold mb-2">Example Response</h4>
            <div class="bg-gray-900 rounded-lg p-4 overflow-x-auto">
              <pre class="text-sm text-gray-100"><code>{`{
  "object": "list",
  "data": [
    {
      "id": "${exampleModel}",
      "object": "model",
      "created": 1686935002,
      "owned_by": "organization-owner"
    }
  ]
}`}</code></pre>
            </div>
          </Card>
        </section>

        {/* Allowed Models */}
        <section class="mb-12">
          <h2 class="text-2xl font-semibold mb-4 flex items-center gap-2">
            <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"></path>
            </svg>
            Available Models
          </h2>

          <Card class="p-6 mb-6">
            <h3 class="text-lg font-semibold mb-3">Language Models</h3>
            {allowedLanguageModels === null ? (
              <p class="text-gray-600 dark:text-gray-400">All language models are available.</p>
            ) : allowedLanguageModels.length === 0 ? (
              <p class="text-gray-600 dark:text-gray-400">No language models are currently configured.</p>
            ) : (
              <div class="grid grid-cols-1 gap-2">
                {allowedLanguageModels.map((model: string) => (
                  <div class="bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded px-3 py-2">
                    <code class="text-sm">{model}</code>
                  </div>
                ))}
              </div>
            )}
          </Card>

          <Card class="p-6">
            <h3 class="text-lg font-semibold mb-3">Embedding Models</h3>
            {allowedEmbeddingModels === null ? (
              <p class="text-gray-600 dark:text-gray-400">All embedding models are available.</p>
            ) : allowedEmbeddingModels.length === 0 ? (
              <p class="text-gray-600 dark:text-gray-400">No embedding models are currently configured.</p>
            ) : (
              <div class="grid grid-cols-1 gap-2">
                {allowedEmbeddingModels.map((model: string) => (
                  <div class="bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded px-3 py-2">
                    <code class="text-sm">{model}</code>
                  </div>
                ))}
              </div>
            )}
          </Card>

          <div class="bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg p-4 mt-4">
            <p class="text-sm text-blue-800 dark:text-blue-300">
              <strong>Note:</strong> If you request a model that is not in the allowed list, the API will automatically use the first allowed model from the respective category.
            </p>
          </div>
        </section>

        {/* SDK Examples */}
        <section class="mb-12">
          <h2 class="text-2xl font-semibold mb-4 flex items-center gap-2">
            <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4"></path>
            </svg>
            SDK Examples
          </h2>

          <Card class="p-6 mb-6">
            <h3 class="text-lg font-semibold mb-3">Python (OpenAI SDK)</h3>
            <div class="bg-gray-900 rounded-lg p-4 overflow-x-auto">
              <pre class="text-sm text-gray-100"><code>{`from openai import OpenAI

client = OpenAI(
    api_key="YOUR_API_KEY",
    base_url="${env.BASE_URL}/proxy/v1"
)

response = client.chat.completions.create(
    model="${exampleModel}",
    messages=[
        {"role": "user", "content": "Hello!"}
    ]
)

print(response.choices[0].message.content)`}</code></pre>
            </div>
          </Card>

          <Card class="p-6 mb-6">
            <h3 class="text-lg font-semibold mb-3">JavaScript/TypeScript (OpenAI SDK)</h3>
            <div class="bg-gray-900 rounded-lg p-4 overflow-x-auto">
              <pre class="text-sm text-gray-100"><code>{`import OpenAI from 'openai';

const client = new OpenAI({
  apiKey: 'YOUR_API_KEY',
  baseURL: '${env.BASE_URL}/proxy/v1',
});

const response = await client.chat.completions.create({
  model: '${exampleModel}',
  messages: [
    { role: 'user', content: 'Hello!' }
  ],
});

console.log(response.choices[0].message.content);`}</code></pre>
            </div>
          </Card>

          <Card class="p-6">
            <h3 class="text-lg font-semibold mb-3">Streaming with Python</h3>
            <div class="bg-gray-900 rounded-lg p-4 overflow-x-auto">
              <pre class="text-sm text-gray-100"><code>{`from openai import OpenAI

client = OpenAI(
    api_key="YOUR_API_KEY",
    base_url="${env.BASE_URL}/proxy/v1"
)

stream = client.chat.completions.create(
    model="${exampleModel}",
    messages=[{"role": "user", "content": "Tell me a story"}],
    stream=True
)

for chunk in stream:
    if chunk.choices[0].delta.content:
        print(chunk.choices[0].delta.content, end="")`}</code></pre>
            </div>
          </Card>
        </section>

        {/* Rate Limits & Notes */}
        <section class="mb-12">
          <h2 class="text-2xl font-semibold mb-4 flex items-center gap-2">
            <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path>
            </svg>
            Important Notes
          </h2>

          <Card class="p-6">
            <ul class="space-y-3 text-gray-600 dark:text-gray-400">
              <li class="flex gap-2">
                <svg class="w-5 h-5 text-blue-500 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path>
                </svg>
                <span><strong>Request Size:</strong> Maximum request body size is 20MB.</span>
              </li>
              <li class="flex gap-2">
                <svg class="w-5 h-5 text-blue-500 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path>
                </svg>
                <span><strong>Timeout:</strong> Requests will timeout after 120 seconds.</span>
              </li>
              <li class="flex gap-2">
                <svg class="w-5 h-5 text-blue-500 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path>
                </svg>
                <span><strong>API Keys:</strong> You can create up to 50 API keys per user.</span>
              </li>
              <li class="flex gap-2">
                <svg class="w-5 h-5 text-blue-500 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path>
                </svg>
                <span><strong>Logging:</strong> All requests are logged with token usage, duration, and IP address for monitoring purposes.</span>
              </li>
              <li class="flex gap-2">
                <svg class="w-5 h-5 text-blue-500 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path>
                </svg>
                <span><strong>OpenAI Compatibility:</strong> This API is compatible with OpenAI's client libraries. Simply change the base URL to use this proxy.</span>
              </li>
            </ul>
          </Card>
        </section>

        {/* Error Handling */}
        <section class="mb-12">
          <h2 class="text-2xl font-semibold mb-4 flex items-center gap-2">
            <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"></path>
            </svg>
            Error Handling
          </h2>

          <Card class="p-6">
            <p class="text-gray-600 dark:text-gray-400 mb-4">
              The API uses standard HTTP status codes to indicate success or failure:
            </p>
            <div class="space-y-3">
              <div class="border-l-4 border-green-500 pl-4">
                <code class="font-semibold">200 OK</code>
                <p class="text-sm text-gray-600 dark:text-gray-400 mt-1">Request succeeded</p>
              </div>
              <div class="border-l-4 border-yellow-500 pl-4">
                <code class="font-semibold">400 Bad Request</code>
                <p class="text-sm text-gray-600 dark:text-gray-400 mt-1">Invalid request parameters</p>
              </div>
              <div class="border-l-4 border-red-500 pl-4">
                <code class="font-semibold">401 Unauthorized</code>
                <p class="text-sm text-gray-600 dark:text-gray-400 mt-1">Missing or invalid API key</p>
              </div>
              <div class="border-l-4 border-red-500 pl-4">
                <code class="font-semibold">413 Payload Too Large</code>
                <p class="text-sm text-gray-600 dark:text-gray-400 mt-1">Request body exceeds 20MB limit</p>
              </div>
              <div class="border-l-4 border-red-500 pl-4">
                <code class="font-semibold">500 Internal Server Error</code>
                <p class="text-sm text-gray-600 dark:text-gray-400 mt-1">Server error occurred</p>
              </div>
            </div>
          </Card>
        </section>

        <div class="bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg p-6 text-center">
          <p class="text-gray-600 dark:text-gray-400">
            Need help? Check your <a href="/dashboard" class="text-blue-600 dark:text-blue-400 hover:underline">dashboard</a> for usage statistics and API keys.
          </p>
        </div>
        </div>
      </div>

      <script
        dangerouslySetInnerHTML={{
          __html: `
            function toggleDarkMode() {
              const isDark = document.documentElement.classList.toggle('dark');
              localStorage.setItem('darkMode', isDark);
            }
          `,
        }}
      />
    </Layout>
  );
};
