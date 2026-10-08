import os

from openai import OpenAI

client = OpenAI(
    base_url=os.environ.get("OLLAMA_BASE_URL", "http://localhost:11434/v1"),
    api_key="ollama",  # required by the SDK, ignored by Ollama
)

MODEL = os.environ.get("OLLAMA_MODEL", "qwen2.5-coder:14b")

response = client.chat.completions.create(
    model=MODEL,
    messages=[{"role": "user", "content": "Write a haiku about local LLMs."}],
)

print(response.choices[0].message.content)
