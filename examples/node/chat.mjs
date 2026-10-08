import OpenAI from "openai";

const client = new OpenAI({
  baseURL: process.env.OLLAMA_BASE_URL ?? "http://localhost:11434/v1",
  apiKey: "ollama", // required by the SDK, ignored by Ollama
});

const model = process.env.OLLAMA_MODEL ?? "qwen2.5-coder:14b";

const response = await client.chat.completions.create({
  model,
  messages: [{ role: "user", content: "Write a haiku about local LLMs." }],
});

console.log(response.choices[0].message.content);
