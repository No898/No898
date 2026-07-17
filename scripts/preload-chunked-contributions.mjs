import { createChunkedContributionFetch } from "./chunked-contributions.mjs";

globalThis.fetch = createChunkedContributionFetch({
  fetch: globalThis.fetch.bind(globalThis),
});
