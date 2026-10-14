# /// script
# requires-python = ">=3.12,<3.14"
# dependencies = ["sentence-transformers>=5", "transformers>=5", "torch>=2.9", "pillow>=11", "torchvision>=0.24"]
# ///
"""Loopback-only, text-only EmbeddingGemma 2 runtime. No transcript storage."""
import argparse
import json
import math
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

REVISION = "914f7f89142e33e77833254d9c9b90c3cef7303b"
MODEL = "google/embeddinggemma-2"
IDENTITY = f"{MODEL}@{REVISION}:256"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=18791)
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()

    import torch
    from sentence_transformers import SentenceTransformer

    torch.set_num_threads(4)
    model = SentenceTransformer(
        MODEL,
        revision=REVISION,
        device="cpu",
        config_kwargs={"vision_config": None, "audio_config": None},
        model_kwargs={"torch_dtype": torch.float32},
    )
    lock = threading.Lock()

    def encode(texts, kind):
        with lock:
            vectors = model.encode(
                texts,
                prompt_name="SearchQuery" if kind == "query" else "Document",
                truncate_dim=256,
                normalize_embeddings=True,
                show_progress_bar=False,
            ).tolist()
        if any(len(vector) != 256 or not all(math.isfinite(v) for v in vector) for vector in vectors):
            raise ValueError("invalid vectors")
        return vectors

    if args.self_test:
        query = encode(["Which model handles memory extraction?"], "query")[0]
        documents = encode(["Luna extracts durable memories.", "A banana is a fruit."], "document")
        scores = [sum(q * d for q, d in zip(query, document)) for document in documents]
        if scores[0] <= scores[1]:
            raise RuntimeError("semantic retrieval smoke test failed")
        print(json.dumps({"model": IDENTITY, "dimensions": len(query), "scores": scores, "finite": True}))
        return

    # Bounded inference queue. Concurrent clients never run separate copies.
    slots = threading.BoundedSemaphore(8)

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass  # Never log memory text or request bodies.

        def reply(self, status, body):
            data = json.dumps(body).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self):
            self.reply(200 if self.path == "/health" else 404, {"model": IDENTITY})

        def do_POST(self):
            if self.path != "/embed":
                self.reply(404, {"error": "not found"})
                return
            if not slots.acquire(blocking=False):
                self.reply(503, {"error": "embedding queue full"})
                return
            try:
                self.connection.settimeout(10)
                size = int(self.headers.get("Content-Length", "0"))
                if not 0 < size <= 128 * 1024:
                    self.reply(413, {"error": "request exceeds budget"})
                    return
                body = json.loads(self.rfile.read(size))
                texts = body.get("texts")
                kind = body.get("kind")
                if body.get("model") != IDENTITY:
                    self.reply(409, {"error": "embedding model mismatch"})
                    return
                if kind not in ("query", "document") or not isinstance(texts, list) or not 1 <= len(texts) <= 32:
                    self.reply(400, {"error": "invalid embedding batch"})
                    return
                if any(not isinstance(text, str) or len(text) > 8000 for text in texts):
                    self.reply(400, {"error": "text exceeds budget"})
                    return
                self.reply(200, {"model": IDENTITY, "vectors": encode(texts, kind)})
            except (ValueError, TypeError, TimeoutError):
                self.reply(400, {"error": "invalid embedding request"})
            except (BrokenPipeError, ConnectionResetError):
                pass
            except Exception:
                self.reply(503, {"error": "embedding inference failed"})
            finally:
                slots.release()

    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    print(f"Embeddings ready on 127.0.0.1:{args.port} ({IDENTITY})", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
