import OpenAI from 'openai';
import fetch from 'node-fetch';

const client = new OpenAI({
  baseURL: 'http://localhost:8080/',
  apiKey: 'ollama',
});

async function testStreaming() {
  console.log('--- Test: Streaming ---');
  const stream = await client.chat.completions.create({
    messages: [{ role: 'user', content: 'Say: this is a streaming test.' }],
    stream: true,
  });
  for await (const chunk of stream) {
    console.log(chunk);
  }
}

async function testNonStreaming() {
  console.log('--- Test: Non-Streaming ---');
  const resp = await client.chat.completions.create({
    messages: [{ role: 'user', content: 'Say: this is a non-streaming test.' }],
    stream: false,
  });
  console.log(resp);
}

async function testModelEndpoint() {
  console.log('--- Test: /model ---');
  const res = await fetch('http://localhost:8080/model');
  const json = await res.json();
  console.log(json);
}

async function testEchoEndpoint() {
  console.log('--- Test: /echo ---');
  const res = await fetch('http://localhost:8080/echo', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ foo: 'bar' }),
  });
  const json = await res.json();
  console.log(json);
}

(async () => {
  await testStreaming();
  await testNonStreaming();
  await testModelEndpoint();
  await testEchoEndpoint();
})();
