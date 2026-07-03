/**
 * Embeddings provider. Default: fully local via Transformers.js (no API key,
 * nothing leaves the machine). Optional API backends via MEMORY_EMBEDDINGS.
 */

export interface Embedder {
  readonly id: string;
  readonly dim: number;
  embed(texts: string[]): Promise<number[][]>;
}

const LOCAL_MODEL = process.env.MEMORY_EMBED_MODEL ?? "Xenova/bge-small-en-v1.5";
const LOCAL_DIM = 384; // bge-small-en-v1.5

/** Local in-process embedder using Transformers.js feature-extraction. */
class LocalEmbedder implements Embedder {
  readonly id = `local:${LOCAL_MODEL}`;
  readonly dim = LOCAL_DIM;
  private extractor: Promise<any> | null = null;

  private async pipe() {
    if (!this.extractor) {
      const { pipeline, env } = await import("@huggingface/transformers");
      // Keep model cache inside the repo (gitignored) for reproducibility.
      env.cacheDir = process.env.MEMORY_MODEL_CACHE ?? "./.cache/transformers";
      this.extractor = pipeline("feature-extraction", LOCAL_MODEL);
    }
    return this.extractor;
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const extractor = await this.pipe();
    const out = await extractor(texts, { pooling: "mean", normalize: true });
    // out is a Tensor [n, dim]; tolist() -> number[][]
    return out.tolist() as number[][];
  }
}

/** OpenAI-compatible embeddings (set MEMORY_EMBEDDINGS=openai + OPENAI_API_KEY). */
class OpenAIEmbedder implements Embedder {
  readonly id: string;
  readonly dim: number;
  constructor(
    private model = process.env.MEMORY_EMBED_MODEL ?? "text-embedding-3-small",
    dim = 1536,
  ) {
    this.id = `openai:${this.model}`;
    this.dim = dim;
  }
  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const key = process.env.OPENAI_API_KEY;
    if (!key) throw new Error("OPENAI_API_KEY required for MEMORY_EMBEDDINGS=openai");
    const res = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: this.model, input: texts }),
    });
    if (!res.ok) throw new Error(`OpenAI embeddings failed: ${res.status} ${await res.text()}`);
    const json = (await res.json()) as { data: { embedding: number[] }[] };
    return json.data.map((d) => d.embedding);
  }
}

/** Voyage AI embeddings (set MEMORY_EMBEDDINGS=voyage + VOYAGE_API_KEY). */
class VoyageEmbedder implements Embedder {
  readonly id: string;
  readonly dim: number;
  constructor(
    private model = process.env.MEMORY_EMBED_MODEL ?? "voyage-3-lite",
    dim = 512,
  ) {
    this.id = `voyage:${this.model}`;
    this.dim = dim;
  }
  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const key = process.env.VOYAGE_API_KEY;
    if (!key) throw new Error("VOYAGE_API_KEY required for MEMORY_EMBEDDINGS=voyage");
    const res = await fetch("https://api.voyageai.com/v1/embeddings", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: this.model, input: texts }),
    });
    if (!res.ok) throw new Error(`Voyage embeddings failed: ${res.status} ${await res.text()}`);
    const json = (await res.json()) as { data: { embedding: number[] }[] };
    return json.data.map((d) => d.embedding);
  }
}

let cached: Embedder | null = null;

/** Resolve the configured embedder (default: local, fully private). */
export function getEmbedder(): Embedder {
  if (cached) return cached;
  const backend = (process.env.MEMORY_EMBEDDINGS ?? "local").toLowerCase();
  switch (backend) {
    case "openai":
      cached = new OpenAIEmbedder();
      break;
    case "voyage":
      cached = new VoyageEmbedder();
      break;
    case "local":
      cached = new LocalEmbedder();
      break;
    default:
      throw new Error(`Unknown MEMORY_EMBEDDINGS=${backend} (use local|openai|voyage)`);
  }
  return cached;
}
