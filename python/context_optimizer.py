from sentence_transformers import CrossEncoder, SentenceTransformer, util
from llmlingua import PromptCompressor
import sys

def log(message):
    try:
        sys.stderr.write(f"[context-optimizer] {message}\n")
        sys.stderr.flush()
    except Exception:
        pass


try:
    import torch
except Exception:
    torch = None

class ContextOptimizer:
    def __init__(
        self,
        reranker_model="BAAI/bge-reranker-large",
        embed_model="all-MiniLM-L6-v2",
        compression_rate=0.5,
        max_chunks=6,
        dedupe_threshold=0.9,
        total_prune_budget_chars=4000,
        error_prefixes=None,
    ):
        device = "cuda" if torch is not None and torch.cuda.is_available() else "cpu"
        # Keep the LLMLingua-2 algorithm on both devices; on CPU use the smaller
        # multilingual BERT checkpoint instead of the large xlm-roberta model so
        # the optimizer stays responsive without a CUDA GPU.
        compressor_model = (
            "microsoft/llmlingua-2-xlm-roberta-large-meetingbank"
            if device == "cuda"
            else "microsoft/llmlingua-2-bert-base-multilingual-cased-meetingbank"
        )

        log(
            f"initializing optimizer device={device} reranker={reranker_model} embedder={embed_model} compressor={compressor_model}"
        )

        self.reranker = CrossEncoder(reranker_model, device=device)
        self.embedder = SentenceTransformer(embed_model, device=device)
        self.compressor = PromptCompressor(
            model_name=compressor_model,
            use_llmlingua2=True,
            device_map=device,
        )

        self.compression_rate = compression_rate
        self.max_chunks = max_chunks
        self.dedupe_threshold = dedupe_threshold
        self.total_prune_budget_chars = total_prune_budget_chars
        self.error_prefixes = tuple(error_prefixes or ("[error]", "[context-optimizer] error"))

        log("optimizer initialized")

    def _normalize_doc(self, doc):
        if isinstance(doc, str):
            return doc.strip()

        if isinstance(doc, (list, tuple)):
            parts = [str(part).strip() for part in doc if part is not None and str(part).strip()]
            return " ".join(parts).strip()

        return str(doc).strip()

    def _is_prefixed(self, doc, prefixes):
        lowered = doc.lower()
        return any(lowered.startswith(prefix.lower()) for prefix in prefixes)

    def _purge_error_docs(self, docs):
        return [doc for doc in docs if not self._is_prefixed(doc, self.error_prefixes)]

    def dedupe(self, docs):
        if not docs:
            return docs

        embeddings = self.embedder.encode(docs, convert_to_tensor=True)

        unique_docs = []
        unique_embeddings = []

        for i, emb in enumerate(embeddings):
            if not unique_embeddings:
                unique_docs.append(docs[i])
                unique_embeddings.append(emb)
                continue

            similarities = [util.cos_sim(emb, u_emb).item() for u_emb in unique_embeddings]

            if max(similarities) < self.dedupe_threshold:
                unique_docs.append(docs[i])
                unique_embeddings.append(emb)

        return unique_docs

    def _pre_prune(self, query, docs):
        """Rank + dedupe the docs and keep the best ones that fit the char budget."""
        if not docs or self.total_prune_budget_chars <= 0:
            return []

        scores = self.reranker.predict([(query, doc) for doc in docs])
        score_for_doc = {}
        for score, doc in zip(scores, docs):
            score_for_doc.setdefault(doc, score)

        ranked = self.dedupe(
            [doc for _, doc in sorted(zip(scores, docs), key=lambda x: x[0], reverse=True)]
        )

        pruned = []
        remaining = self.total_prune_budget_chars

        for doc in ranked:
            if remaining <= 0:
                break

            if len(doc) > remaining:
                # Keep one high-value oversized doc rather than returning nothing.
                if not pruned and score_for_doc.get(doc, 0) > 0:
                    pruned.append(doc)
                    break
                continue

            pruned.append(doc)
            remaining -= len(doc)

        return pruned

    def compress(self, docs):
        if not docs:
            return ""

        compressed = self.compressor.compress_prompt(
            docs,
            rate=self.compression_rate,
        )

        return compressed["compressed_prompt"]

    def optimize(self, query, docs=None):
        docs = [
            normalized
            for normalized in (self._normalize_doc(doc) for doc in (docs or []))
            if normalized
        ]
        docs = self._purge_error_docs(docs)

        # _pre_prune already returns docs ranked best-first, so capping to
        # max_chunks is a plain slice.
        pruned = self._pre_prune(query, docs)
        if not pruned:
            return ""

        return self.compress(pruned[: self.max_chunks])
