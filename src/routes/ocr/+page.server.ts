import type { PageServerLoad } from "./$types";

import { highlight } from "#lib/server/highlight.ts";
import { requireUser } from "#lib/server/page.ts";
import type { CodeExamples } from "#lib/server/examples.ts";

const sources = (baseUrl: string) => ({
  curl: `curl ${baseUrl}/proxy/v1/ocr \\
  -H "Authorization: Bearer YOUR_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "mistral-ocr-latest",
    "document": {
      "type": "document_url",
      "document_url": "https://arxiv.org/pdf/2201.04234"
    },
    "include_image_base64": false
  }'`,
  javascript: `const response = await fetch('${baseUrl}/proxy/v1/ocr', {
  method: 'POST',
  headers: {
    'Authorization': 'Bearer YOUR_API_KEY',
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    model: 'mistral-ocr-latest',
    document: {
      type: 'document_url',
      document_url: 'https://arxiv.org/pdf/2201.04234',
    },
    include_image_base64: false,
  }),
});

const data = await response.json();
for (const page of data.pages) {
  console.log(\`--- page \${page.index} ---\`);
  console.log(page.markdown);
}`,
  python: `import requests

headers = {
    "Authorization": "Bearer YOUR_API_KEY",
    "Content-Type": "application/json",
}

payload = {
    "model": "mistral-ocr-latest",
    "document": {
        "type": "document_url",
        "document_url": "https://arxiv.org/pdf/2201.04234",
    },
    "include_image_base64": False,
}

response = requests.post(
    "${baseUrl}/proxy/v1/ocr",
    headers=headers,
    json=payload,
)

for page in response.json()["pages"]:
    print(f"--- page {page['index']} ---")
    print(page["markdown"])`,
});

const responseExample = `{
  "model": "mistral-ocr-2505-completion",
  "pages": [
    {
      "index": 0,
      "markdown": "# LeViT: a Vision Transformer in ConvNet's Clothing\\n\\n## Abstract\\n\\nWe design a family of image classification architectures...",
      "images": [],
      "dimensions": { "dpi": 200, "height": 2200, "width": 1700 }
    }
  ],
  "usage_info": { "pages_processed": 1, "doc_size_bytes": 512338 }
}`;

export const load: PageServerLoad = async ({ locals }) => {
  requireUser(locals);
  const { site } = locals.dashboard;
  const baseUrl = site.baseUrl;
  const source = sources(baseUrl);
  const [curl, javascript, python, response] = await Promise.all([
    highlight(source.curl, "bash"),
    highlight(source.javascript, "javascript"),
    highlight(source.python, "python"),
    highlight(responseExample, "javascript"),
  ]);
  const examples: CodeExamples = { curl, javascript, python };
  return {
    baseUrl,
    examples,
    response,
    pagePriceUsd: site.ocrPagePriceUsd,
  };
};
