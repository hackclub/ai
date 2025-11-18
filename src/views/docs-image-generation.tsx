import { Layout } from "./layout";
import { Header } from "./components/Header";
import { Card } from "./components/Card";
import { env } from "../env";

export const ImageGenerationDocs = ({
  user,
  allowedLanguageModels,
}: any) => {
  const exampleModel = "google/gemini-2.5-flash-image";

  return (
    <Layout title="Image Generation - OpenRouter Documentation">
      <Header title="AI Proxy - Image Generation" user={user} showBackToDashboard />

      <div class="max-w-4xl mx-auto px-4 py-8 prose dark:prose-invert prose-sm sm:prose max-w-none">
        {/* Hero Section */}
        <div class="mb-8">
          <h1 class="text-3xl font-bold mb-4">Image Generation</h1>
          <p class="text-lg text-gray-600 dark:text-gray-400">
            Generate images using AI models through the OpenRouter API
          </p>
        </div>

        <p class="text-gray-700 dark:text-gray-300 mb-8">
          OpenRouter supports image generation through models that have <code class="px-2 py-1 bg-gray-100 dark:bg-gray-800 rounded text-sm">"image"</code> in their <code class="px-2 py-1 bg-gray-100 dark:bg-gray-800 rounded text-sm">output_modalities</code>. These models can create images from text prompts when you specify the appropriate modalities in your request.
        </p>

        {/* Model Discovery */}
        <section class="mb-12">
          <h2 class="text-2xl font-semibold mb-4 flex items-center gap-2">
            <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"></path>
            </svg>
            Model Discovery
          </h2>

          <Card class="p-6 mb-4">
            <h3 class="text-lg font-semibold mb-3">On the Models Page</h3>
            <p class="text-gray-600 dark:text-gray-400 mb-4">
              Visit the{" "}
              <a href="/models" class="text-blue-600 dark:text-blue-400 hover:underline">
                Models page
              </a>{" "}
              and filter by output modalities to find models capable of image generation. Look for models that list <code class="px-2 py-1 bg-gray-100 dark:bg-gray-800 rounded text-sm">"image"</code> in their output modalities.
            </p>

            <h3 class="text-lg font-semibold mb-3 mt-6">In the Chatroom</h3>
            <p class="text-gray-600 dark:text-gray-400">
              When using the{" "}
              <a href="/chat" class="text-blue-600 dark:text-blue-400 hover:underline">
                Chatroom
              </a>
              , click the <strong>Image</strong> button to automatically filter and select models with image generation capabilities. If no image-capable model is active, you'll be prompted to add one.
            </p>
          </Card>
        </section>

        {/* API Usage */}
        <section class="mb-12">
          <h2 class="text-2xl font-semibold mb-4 flex items-center gap-2">
            <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4"></path>
            </svg>
            API Usage
          </h2>

          <p class="text-gray-700 dark:text-gray-300 mb-6">
            To generate images, send a request to the <code class="px-2 py-1 bg-gray-100 dark:bg-gray-800 rounded text-sm">/api/v1/chat/completions</code> endpoint with the <code class="px-2 py-1 bg-gray-100 dark:bg-gray-800 rounded text-sm">modalities</code> parameter set to include both <code class="px-2 py-1 bg-gray-100 dark:bg-gray-800 rounded text-sm">"image"</code> and <code class="px-2 py-1 bg-gray-100 dark:bg-gray-800 rounded text-sm">"text"</code>.
          </p>

          {/* Basic Image Generation */}
          <Card class="p-6 mb-6">
            <h3 class="text-xl font-semibold mb-4">Basic Image Generation</h3>

            <div class="space-y-6">
              {/* cURL Example */}
              <div>
                <div class="flex items-center justify-between mb-2">
                  <h4 class="text-md font-semibold text-gray-900 dark:text-gray-100">cURL</h4>
                </div>
                <div class="bg-gray-900 rounded-lg p-4 overflow-x-auto">
                  <pre class="text-sm text-gray-100">
                    <code>{`curl ${env.BASE_URL}/proxy/v1/chat/completions \\
  -H "Authorization: Bearer YOUR_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "${exampleModel}",
    "messages": [
      {
        "role": "user",
        "content": "Generate a beautiful sunset over mountains"
      }
    ],
    "modalities": ["image", "text"]
  }'`}</code>
                  </pre>
                </div>
              </div>

              {/* Python Example */}
              <div>
                <div class="flex items-center justify-between mb-2">
                  <h4 class="text-md font-semibold text-gray-900 dark:text-gray-100">Python</h4>
                </div>
                <div class="bg-gray-900 rounded-lg p-4 overflow-x-auto">
                  <pre class="text-sm text-gray-100">
                    <code>{`import requests
import json

url = "${env.BASE_URL}/proxy/v1/chat/completions"
headers = {
    "Authorization": "Bearer YOUR_API_KEY",
    "Content-Type": "application/json"
}

payload = {
    "model": "${exampleModel}",
    "messages": [
        {
            "role": "user",
            "content": "Generate a beautiful sunset over mountains"
        }
    ],
    "modalities": ["image", "text"]
}

response = requests.post(url, headers=headers, json=payload)
result = response.json()

# The generated image will be in the assistant message
if result.get("choices"):
    message = result["choices"][0]["message"]
    if message.get("images"):
        for image in message["images"]:
            image_url = image["image_url"]["url"]  # Base64 data URL
            print(f"Generated image: {image_url[:50]}...")`}</code>
                  </pre>
                </div>
              </div>

              {/* JavaScript/TypeScript Example */}
              <div>
                <div class="flex items-center justify-between mb-2">
                  <h4 class="text-md font-semibold text-gray-900 dark:text-gray-100">JavaScript/TypeScript</h4>
                </div>
                <div class="bg-gray-900 rounded-lg p-4 overflow-x-auto">
                  <pre class="text-sm text-gray-100">
                    <code>{`const response = await fetch('${env.BASE_URL}/proxy/v1/chat/completions', {
  method: 'POST',
  headers: {
    'Authorization': 'Bearer YOUR_API_KEY',
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    model: '${exampleModel}',
    messages: [
      {
        role: 'user',
        content: 'Generate a beautiful sunset over mountains',
      },
    ],
    modalities: ['image', 'text'],
  }),
});

const result = await response.json();

// The generated image will be in the assistant message
if (result.choices) {
  const message = result.choices[0].message;
  if (message.images) {
    message.images.forEach((image, index) => {
      const imageUrl = image.image_url.url; // Base64 data URL
      console.log(\`Generated image \${index + 1}: \${imageUrl.substring(0, 50)}...\`);
    });
  }
}`}</code>
                  </pre>
                </div>
              </div>

              {/* Node.js Example */}
              <div>
                <div class="flex items-center justify-between mb-2">
                  <h4 class="text-md font-semibold text-gray-900 dark:text-gray-100">Node.js</h4>
                </div>
                <div class="bg-gray-900 rounded-lg p-4 overflow-x-auto">
                  <pre class="text-sm text-gray-100">
                    <code>{`const https = require('https');

const data = JSON.stringify({
  model: '${exampleModel}',
  messages: [
    {
      role: 'user',
      content: 'Generate a beautiful sunset over mountains'
    }
  ],
  modalities: ['image', 'text']
});

const options = {
  hostname: '${env.BASE_URL.replace(/^https?:\/\//, '')}',
  path: '/proxy/v1/chat/completions',
  method: 'POST',
  headers: {
    'Authorization': 'Bearer YOUR_API_KEY',
    'Content-Type': 'application/json',
    'Content-Length': data.length
  }
};

const req = https.request(options, (res) => {
  let body = '';
  res.on('data', (chunk) => body += chunk);
  res.on('end', () => {
    const result = JSON.parse(body);
    if (result.choices) {
      const message = result.choices[0].message;
      if (message.images) {
        message.images.forEach((image) => {
          console.log('Generated image:', image.image_url.url.substring(0, 50) + '...');
        });
      }
    }
  });
});

req.write(data);
req.end();`}</code>
                  </pre>
                </div>
              </div>
            </div>
          </Card>

          {/* Image Aspect Ratio Configuration */}
          <Card class="p-6 mb-6">
            <h3 class="text-xl font-semibold mb-4">Image Aspect Ratio Configuration</h3>

            <p class="text-gray-600 dark:text-gray-400 mb-4">
              Gemini image-generation models let you request specific aspect ratios by setting <code class="px-2 py-1 bg-gray-100 dark:bg-gray-800 rounded text-sm">image_config.aspect_ratio</code>. Read more about using Gemini Image Gen models here:{" "}
              <a href="https://ai.google.dev/gemini-api/docs/image-generation" class="text-blue-600 dark:text-blue-400 hover:underline" target="_blank" rel="noopener noreferrer">
                https://ai.google.dev/gemini-api/docs/image-generation
              </a>
            </p>

            <div class="bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg p-4 mb-6">
              <h4 class="text-sm font-semibold text-blue-900 dark:text-blue-100 mb-2">Supported aspect ratios:</h4>
              <div class="grid grid-cols-2 sm:grid-cols-3 gap-2 text-sm text-blue-800 dark:text-blue-200">
                <div><code class="px-2 py-1 bg-blue-100 dark:bg-blue-900/40 rounded">1:1</code> → 1024×1024 (default)</div>
                <div><code class="px-2 py-1 bg-blue-100 dark:bg-blue-900/40 rounded">2:3</code> → 832×1248</div>
                <div><code class="px-2 py-1 bg-blue-100 dark:bg-blue-900/40 rounded">3:2</code> → 1248×832</div>
                <div><code class="px-2 py-1 bg-blue-100 dark:bg-blue-900/40 rounded">3:4</code> → 864×1184</div>
                <div><code class="px-2 py-1 bg-blue-100 dark:bg-blue-900/40 rounded">4:3</code> → 1184×864</div>
                <div><code class="px-2 py-1 bg-blue-100 dark:bg-blue-900/40 rounded">4:5</code> → 896×1152</div>
                <div><code class="px-2 py-1 bg-blue-100 dark:bg-blue-900/40 rounded">5:4</code> → 1152×896</div>
                <div><code class="px-2 py-1 bg-blue-100 dark:bg-blue-900/40 rounded">9:16</code> → 768×1344</div>
                <div><code class="px-2 py-1 bg-blue-100 dark:bg-blue-900/40 rounded">16:9</code> → 1344×768</div>
                <div><code class="px-2 py-1 bg-blue-100 dark:bg-blue-900/40 rounded">21:9</code> → 1536×672</div>
              </div>
            </div>

            <div class="space-y-6">
              {/* Python Example with Aspect Ratio */}
              <div>
                <div class="flex items-center justify-between mb-2">
                  <h4 class="text-md font-semibold text-gray-900 dark:text-gray-100">Python</h4>
                </div>
                <div class="bg-gray-900 rounded-lg p-4 overflow-x-auto">
                  <pre class="text-sm text-gray-100">
                    <code>{`import requests
import json

url = "${env.BASE_URL}/proxy/v1/chat/completions"
headers = {
    "Authorization": "Bearer YOUR_API_KEY",
    "Content-Type": "application/json"
}

payload = {
    "model": "${exampleModel}",
    "messages": [
        {
            "role": "user",
            "content": "Create a picture of a nano banana dish in a fancy restaurant with a Gemini theme"
        }
    ],
    "modalities": ["image", "text"],
    "image_config": {
        "aspect_ratio": "16:9"
    }
}

response = requests.post(url, headers=headers, json=payload)
result = response.json()

if result.get("choices"):
    message = result["choices"][0]["message"]
    if message.get("images"):
        for image in message["images"]:
            image_url = image["image_url"]["url"]
            print(f"Generated image: {image_url[:50]}...")`}</code>
                  </pre>
                </div>
              </div>

              {/* JavaScript Example with Aspect Ratio */}
              <div>
                <div class="flex items-center justify-between mb-2">
                  <h4 class="text-md font-semibold text-gray-900 dark:text-gray-100">JavaScript/TypeScript</h4>
                </div>
                <div class="bg-gray-900 rounded-lg p-4 overflow-x-auto">
                  <pre class="text-sm text-gray-100">
                    <code>{`const response = await fetch('${env.BASE_URL}/proxy/v1/chat/completions', {
  method: 'POST',
  headers: {
    'Authorization': 'Bearer YOUR_API_KEY',
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    model: '${exampleModel}',
    messages: [
      {
        role: 'user',
        content: 'Create a picture of a nano banana dish in a fancy restaurant with a Gemini theme',
      },
    ],
    modalities: ['image', 'text'],
    image_config: {
      aspect_ratio: '16:9',
    },
  }),
});

const result = await response.json();

if (result.choices) {
  const message = result.choices[0].message;
  if (message.images) {
    message.images.forEach((image, index) => {
      const imageUrl = image.image_url.url;
      console.log(\`Generated image \${index + 1}: \${imageUrl.substring(0, 50)}...\`);
    });
  }
}`}</code>
                  </pre>
                </div>
              </div>
            </div>
          </Card>

          {/* Streaming Image Generation */}
          <Card class="p-6 mb-6">
            <h3 class="text-xl font-semibold mb-4">Streaming Image Generation</h3>

            <p class="text-gray-600 dark:text-gray-400 mb-6">
              Image generation also works with streaming responses. Images will be included in the stream chunks when generation is complete.
            </p>

            <div class="space-y-6">
              {/* Python Streaming Example */}
              <div>
                <div class="flex items-center justify-between mb-2">
                  <h4 class="text-md font-semibold text-gray-900 dark:text-gray-100">Python</h4>
                </div>
                <div class="bg-gray-900 rounded-lg p-4 overflow-x-auto">
                  <pre class="text-sm text-gray-100">
                    <code>{`import requests
import json

url = "${env.BASE_URL}/proxy/v1/chat/completions"
headers = {
    "Authorization": "Bearer YOUR_API_KEY",
    "Content-Type": "application/json"
}

payload = {
    "model": "${exampleModel}",
    "messages": [
        {
            "role": "user",
            "content": "Create an image of a futuristic city"
        }
    ],
    "modalities": ["image", "text"],
    "stream": True
}

response = requests.post(url, headers=headers, json=payload, stream=True)

for line in response.iter_lines():
    if line:
        line = line.decode('utf-8')
        if line.startswith('data: '):
            data = line[6:]
            if data != '[DONE]':
                try:
                    chunk = json.loads(data)
                    if chunk.get("choices"):
                        delta = chunk["choices"][0].get("delta", {})
                        if delta.get("images"):
                            for image in delta["images"]:
                                print(f"Generated image: {image['image_url']['url'][:50]}...")
                except json.JSONDecodeError:
                    continue`}</code>
                  </pre>
                </div>
              </div>

              {/* JavaScript Streaming Example */}
              <div>
                <div class="flex items-center justify-between mb-2">
                  <h4 class="text-md font-semibold text-gray-900 dark:text-gray-100">JavaScript/TypeScript</h4>
                </div>
                <div class="bg-gray-900 rounded-lg p-4 overflow-x-auto">
                  <pre class="text-sm text-gray-100">
                    <code>{`const response = await fetch('${env.BASE_URL}/proxy/v1/chat/completions', {
  method: 'POST',
  headers: {
    'Authorization': 'Bearer YOUR_API_KEY',
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    model: '${exampleModel}',
    messages: [
      {
        role: 'user',
        content: 'Create an image of a futuristic city',
      },
    ],
    modalities: ['image', 'text'],
    stream: true,
  }),
});

const reader = response.body?.getReader();
const decoder = new TextDecoder();

while (true) {
  const { done, value } = await reader.read();
  if (done) break;

  const chunk = decoder.decode(value);
  const lines = chunk.split('\\n');

  for (const line of lines) {
    if (line.startsWith('data: ')) {
      const data = line.slice(6);
      if (data !== '[DONE]') {
        try {
          const parsed = JSON.parse(data);
          if (parsed.choices) {
            const delta = parsed.choices[0].delta;
            if (delta?.images) {
              delta.images.forEach((image, index) => {
                console.log(\`Generated image \${index + 1}: \${image.image_url.url.substring(0, 50)}...\`);
              });
            }
          }
        } catch (e) {
          // Skip invalid JSON
        }
      }
    }
  }
}`}</code>
                  </pre>
                </div>
              </div>
            </div>
          </Card>
        </section>

        {/* Response Format */}
        <section class="mb-12">
          <h2 class="text-2xl font-semibold mb-4 flex items-center gap-2">
            <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"></path>
            </svg>
            Response Format
          </h2>

          <Card class="p-6 mb-4">
            <p class="text-gray-600 dark:text-gray-400 mb-4">
              When generating images, the assistant message includes an <code class="px-2 py-1 bg-gray-100 dark:bg-gray-800 rounded text-sm">images</code> field containing the generated images:
            </p>

            <div class="bg-gray-900 rounded-lg p-4 overflow-x-auto">
              <pre class="text-sm text-gray-100">
                <code>{`{
  "choices": [
    {
      "message": {
        "role": "assistant",
        "content": "I've generated a beautiful sunset image for you.",
        "images": [
          {
            "type": "image_url",
            "image_url": {
              "url": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAA..."
            }
          }
        ]
      }
    }
  ]
}`}</code>
              </pre>
            </div>

            <div class="mt-6 space-y-3">
              <h4 class="text-md font-semibold text-gray-900 dark:text-gray-100">Image Format Details</h4>
              <ul class="space-y-2 text-gray-600 dark:text-gray-400">
                <li class="flex items-start gap-2">
                  <span class="text-blue-600 dark:text-blue-400 mt-1">•</span>
                  <span><strong>Format:</strong> Images are returned as base64-encoded data URLs</span>
                </li>
                <li class="flex items-start gap-2">
                  <span class="text-blue-600 dark:text-blue-400 mt-1">•</span>
                  <span><strong>Types:</strong> Typically PNG format (<code class="px-2 py-1 bg-gray-100 dark:bg-gray-800 rounded text-xs">data:image/png;base64,</code>)</span>
                </li>
                <li class="flex items-start gap-2">
                  <span class="text-blue-600 dark:text-blue-400 mt-1">•</span>
                  <span><strong>Multiple Images:</strong> Some models can generate multiple images in a single response</span>
                </li>
                <li class="flex items-start gap-2">
                  <span class="text-blue-600 dark:text-blue-400 mt-1">•</span>
                  <span><strong>Size:</strong> Image dimensions vary by model capabilities</span>
                </li>
              </ul>
            </div>
          </Card>
        </section>

        {/* Model Compatibility */}
        <section class="mb-12">
          <h2 class="text-2xl font-semibold mb-4 flex items-center gap-2">
            <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 3v2m6-2v2M9 19v2m6-2v2M5 9H3m2 6H3m18-6h-2m2 6h-2M7 19h10a2 2 0 002-2V7a2 2 0 00-2-2H7a2 2 0 00-2 2v10a2 2 0 002 2zM9 9h6v6H9V9z"></path>
            </svg>
            Model Compatibility
          </h2>

          <Card class="p-6 mb-4">
            <p class="text-gray-600 dark:text-gray-400 mb-4">
              Not all models support image generation. To use this feature:
            </p>

            <div class="space-y-4">
              <div class="flex items-start gap-3">
                <div class="flex-shrink-0 w-8 h-8 bg-blue-100 dark:bg-blue-900/30 rounded-full flex items-center justify-center text-blue-600 dark:text-blue-400 font-semibold">
                  1
                </div>
                <div class="flex-1">
                  <h4 class="font-semibold text-gray-900 dark:text-gray-100 mb-1">Check Output Modalities</h4>
                  <p class="text-gray-600 dark:text-gray-400 text-sm">
                    Ensure the model has <code class="px-2 py-1 bg-gray-100 dark:bg-gray-800 rounded text-xs">"image"</code> in its <code class="px-2 py-1 bg-gray-100 dark:bg-gray-800 rounded text-xs">output_modalities</code>
                  </p>
                </div>
              </div>

              <div class="flex items-start gap-3">
                <div class="flex-shrink-0 w-8 h-8 bg-blue-100 dark:bg-blue-900/30 rounded-full flex items-center justify-center text-blue-600 dark:text-blue-400 font-semibold">
                  2
                </div>
                <div class="flex-1">
                  <h4 class="font-semibold text-gray-900 dark:text-gray-100 mb-1">Set Modalities Parameter</h4>
                  <p class="text-gray-600 dark:text-gray-400 text-sm">
                    Include <code class="px-2 py-1 bg-gray-100 dark:bg-gray-800 rounded text-xs">"modalities": ["image", "text"]</code> in your request
                  </p>
                </div>
              </div>

              <div class="flex items-start gap-3">
                <div class="flex-shrink-0 w-8 h-8 bg-blue-100 dark:bg-blue-900/30 rounded-full flex items-center justify-center text-blue-600 dark:text-blue-400 font-semibold">
                  3
                </div>
                <div class="flex-1">
                  <h4 class="font-semibold text-gray-900 dark:text-gray-100 mb-1">Use Compatible Models</h4>
                  <p class="text-gray-600 dark:text-gray-400 text-sm mb-2">
                    Examples include:
                  </p>
                  <ul class="space-y-1 text-sm">
                    <li class="text-gray-600 dark:text-gray-400">
                      • <code class="px-2 py-1 bg-gray-100 dark:bg-gray-800 rounded text-xs">google/gemini-2.5-flash-image</code>
                    </li>
                    <li class="text-gray-600 dark:text-gray-400">
                      • <code class="px-2 py-1 bg-gray-100 dark:bg-gray-800 rounded text-xs">google/gemini-2.5-flash-image-preview</code>
                    </li>
                    <li class="text-gray-600 dark:text-gray-400">
                      • Other models with image generation capabilities
                    </li>
                  </ul>
                </div>
              </div>
            </div>
          </Card>
        </section>

        {/* Best Practices */}
        <section class="mb-12">
          <h2 class="text-2xl font-semibold mb-4 flex items-center gap-2">
            <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"></path>
            </svg>
            Best Practices
          </h2>

          <Card class="p-6 mb-4">
            <div class="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div class="space-y-4">
                <div class="flex items-start gap-3">
                  <svg class="w-5 h-5 text-green-600 dark:text-green-400 flex-shrink-0 mt-0.5" fill="currentColor" viewBox="0 0 20 20">
                    <path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clip-rule="evenodd"></path>
                  </svg>
                  <div>
                    <h4 class="font-semibold text-gray-900 dark:text-gray-100 text-sm mb-1">Clear Prompts</h4>
                    <p class="text-gray-600 dark:text-gray-400 text-sm">Provide detailed descriptions for better image quality</p>
                  </div>
                </div>

                <div class="flex items-start gap-3">
                  <svg class="w-5 h-5 text-green-600 dark:text-green-400 flex-shrink-0 mt-0.5" fill="currentColor" viewBox="0 0 20 20">
                    <path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clip-rule="evenodd"></path>
                  </svg>
                  <div>
                    <h4 class="font-semibold text-gray-900 dark:text-gray-100 text-sm mb-1">Model Selection</h4>
                    <p class="text-gray-600 dark:text-gray-400 text-sm">Choose models specifically designed for image generation</p>
                  </div>
                </div>

                <div class="flex items-start gap-3">
                  <svg class="w-5 h-5 text-green-600 dark:text-green-400 flex-shrink-0 mt-0.5" fill="currentColor" viewBox="0 0 20 20">
                    <path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clip-rule="evenodd"></path>
                  </svg>
                  <div>
                    <h4 class="font-semibold text-gray-900 dark:text-gray-100 text-sm mb-1">Error Handling</h4>
                    <p class="text-gray-600 dark:text-gray-400 text-sm">Check for the <code class="px-1.5 py-0.5 bg-gray-100 dark:bg-gray-800 rounded text-xs">images</code> field in responses before processing</p>
                  </div>
                </div>
              </div>

              <div class="space-y-4">
                <div class="flex items-start gap-3">
                  <svg class="w-5 h-5 text-green-600 dark:text-green-400 flex-shrink-0 mt-0.5" fill="currentColor" viewBox="0 0 20 20">
                    <path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clip-rule="evenodd"></path>
                  </svg>
                  <div>
                    <h4 class="font-semibold text-gray-900 dark:text-gray-100 text-sm mb-1">Rate Limits</h4>
                    <p class="text-gray-600 dark:text-gray-400 text-sm">Image generation may have different rate limits than text generation</p>
                  </div>
                </div>

                <div class="flex items-start gap-3">
                  <svg class="w-5 h-5 text-green-600 dark:text-green-400 flex-shrink-0 mt-0.5" fill="currentColor" viewBox="0 0 20 20">
                    <path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clip-rule="evenodd"></path>
                  </svg>
                  <div>
                    <h4 class="font-semibold text-gray-900 dark:text-gray-100 text-sm mb-1">Storage</h4>
                    <p class="text-gray-600 dark:text-gray-400 text-sm">Consider how you'll handle and store the base64 image data</p>
                  </div>
                </div>

                <div class="flex items-start gap-3">
                  <svg class="w-5 h-5 text-green-600 dark:text-green-400 flex-shrink-0 mt-0.5" fill="currentColor" viewBox="0 0 20 20">
                    <path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clip-rule="evenodd"></path>
                  </svg>
                  <div>
                    <h4 class="font-semibold text-gray-900 dark:text-gray-100 text-sm mb-1">Aspect Ratio</h4>
                    <p class="text-gray-600 dark:text-gray-400 text-sm">Use appropriate aspect ratios for your use case (portrait, landscape, square)</p>
                  </div>
                </div>
              </div>
            </div>
          </Card>
        </section>

        {/* Troubleshooting */}
        <section class="mb-12">
          <h2 class="text-2xl font-semibold mb-4 flex items-center gap-2">
            <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path>
            </svg>
            Troubleshooting
          </h2>

          <div class="space-y-4">
            <Card class="p-6">
              <h3 class="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-2 flex items-center gap-2">
                <span class="text-red-600 dark:text-red-400">⚠</span>
                No images in response?
              </h3>
              <ul class="space-y-2 text-gray-600 dark:text-gray-400 text-sm ml-7">
                <li class="flex items-start gap-2">
                  <span class="text-blue-600 dark:text-blue-400">→</span>
                  <span>Verify the model supports image generation (<code class="px-1.5 py-0.5 bg-gray-100 dark:bg-gray-800 rounded text-xs">output_modalities</code> includes <code class="px-1.5 py-0.5 bg-gray-100 dark:bg-gray-800 rounded text-xs">"image"</code>)</span>
                </li>
                <li class="flex items-start gap-2">
                  <span class="text-blue-600 dark:text-blue-400">→</span>
                  <span>Ensure you've included <code class="px-1.5 py-0.5 bg-gray-100 dark:bg-gray-800 rounded text-xs">"modalities": ["image", "text"]</code> in your request</span>
                </li>
                <li class="flex items-start gap-2">
                  <span class="text-blue-600 dark:text-blue-400">→</span>
                  <span>Check that your prompt is requesting image generation</span>
                </li>
              </ul>
            </Card>

            <Card class="p-6">
              <h3 class="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-2 flex items-center gap-2">
                <span class="text-red-600 dark:text-red-400">⚠</span>
                Model not found?
              </h3>
              <ul class="space-y-2 text-gray-600 dark:text-gray-400 text-sm ml-7">
                <li class="flex items-start gap-2">
                  <span class="text-blue-600 dark:text-blue-400">→</span>
                  <span>Use the{" "}
                    <a href="/models" class="text-blue-600 dark:text-blue-400 hover:underline">
                      Models page
                    </a>{" "}
                    to find available image generation models
                  </span>
                </li>
                <li class="flex items-start gap-2">
                  <span class="text-blue-600 dark:text-blue-400">→</span>
                  <span>Filter by output modalities to see compatible models</span>
                </li>
              </ul>
            </Card>

            <Card class="p-6">
              <h3 class="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-2 flex items-center gap-2">
                <span class="text-red-600 dark:text-red-400">⚠</span>
                Aspect ratio not working?
              </h3>
              <ul class="space-y-2 text-gray-600 dark:text-gray-400 text-sm ml-7">
                <li class="flex items-start gap-2">
                  <span class="text-blue-600 dark:text-blue-400">→</span>
                  <span>Aspect ratio configuration is only supported by Gemini image generation models</span>
                </li>
                <li class="flex items-start gap-2">
                  <span class="text-blue-600 dark:text-blue-400">→</span>
                  <span>Make sure you're using a supported aspect ratio from the list above</span>
                </li>
                <li class="flex items-start gap-2">
                  <span class="text-blue-600 dark:text-blue-400">→</span>
                  <span>Verify your <code class="px-1.5 py-0.5 bg-gray-100 dark:bg-gray-800 rounded text-xs">image_config</code> parameter is correctly formatted</span>
                </li>
              </ul>
            </Card>
          </div>
        </section>

        {/* Related Documentation */}
        <section class="mb-12">
          <h2 class="text-2xl font-semibold mb-4 flex items-center gap-2">
            <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path>
            </svg>
            Related Documentation
          </h2>

          <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <a href="/docs" class="block">
              <Card class="p-4 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors">
                <h3 class="font-semibold text-gray-900 dark:text-gray-100 mb-1">API Documentation</h3>
                <p class="text-sm text-gray-600 dark:text-gray-400">Learn about the core API endpoints and authentication</p>
              </Card>
            </a>

            <a href="/models" class="block">
              <Card class="p-4 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors">
                <h3 class="font-semibold text-gray-900 dark:text-gray-100 mb-1">Available Models</h3>
                <p class="text-sm text-gray-600 dark:text-gray-400">Browse all available models and their capabilities</p>
              </Card>
            </a>

            <a href="https://ai.google.dev/gemini-api/docs/image-generation" target="_blank" rel="noopener noreferrer" class="block">
              <Card class="p-4 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors">
                <h3 class="font-semibold text-gray-900 dark:text-gray-100 mb-1 flex items-center gap-2">
                  Gemini Image Generation Docs
                  <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"></path>
                  </svg>
                </h3>
                <p class="text-sm text-gray-600 dark:text-gray-400">Official Google documentation for Gemini image generation</p>
              </Card>
            </a>

            <a href="/dashboard" class="block">
              <Card class="p-4 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors">
                <h3 class="font-semibold text-gray-900 dark:text-gray-100 mb-1">Dashboard</h3>
                <p class="text-sm text-gray-600 dark:text-gray-400">Manage your API keys and view usage statistics</p>
              </Card>
            </a>
          </div>
        </section>
      </div>
    </Layout>
  );
};
