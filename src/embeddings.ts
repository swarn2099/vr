import path from "node:path";
export const EMBEDDING_MODEL = "Xenova/all-MiniLM-L6-v2";
export const EMBEDDING_REVISION = "751bff37182d3f1213fa05d7196b954e230abad9";
export const EMBEDDING_ID = `${EMBEDDING_MODEL}@${EMBEDDING_REVISION}:q8:mean:normalized`;
let extractor: Promise<any> | undefined;
export async function embed(
  text: string,
  cacheDirectory: string,
): Promise<number[]> {
  if (!extractor)
    extractor = (async () => {
      const { pipeline, env } = await import("@huggingface/transformers");
      env.cacheDir = path.resolve(cacheDirectory);
      return pipeline("feature-extraction", EMBEDDING_MODEL, {
        revision: EMBEDDING_REVISION,
        dtype: "q8",
      });
    })();
  try {
    const model = await extractor;
    const output = await model(text, { pooling: "mean", normalize: true });
    return Array.from(output.data) as number[];
  } catch (e) {
    extractor = undefined;
    throw e;
  }
}
